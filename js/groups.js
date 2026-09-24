// グループ管理・招待（共有）・空き時間チェック
import { api } from './api.js';
import { state, notify, groupList, userName, loadBootstrap } from './state.js';
import {
  $, esc, todayKey, addDays, formatDateJa, expandEvents, span, fromMinutes, copyText,
} from './utils.js';
import { openModal, closeModal, confirmDialog, toast, toastError, withBusy, icons, avatar } from './ui.js';
import { openEventForm } from './events.js';

export const inviteLink = (group) => `${location.origin}${location.pathname}?join=${encodeURIComponent(group.inviteCode)}`;

export function initGroups() {
  $('#view-groups').addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const groupId = target.dataset.group;
    const actions = {
      create: () => openCreateGroup(),
      join: () => openJoinGroup(),
      invite: () => openInvite(groupId),
      chat: () => {
        state.activeChat = groupId;
        location.hash = '#chat';
      },
      availability: () => openAvailability({ groupId }),
      settings: () => openGroupSettings(groupId),
      addEvent: () => openEventForm({ groupId }),
    };
    actions[target.dataset.action]?.();
  });
}

export function renderGroups() {
  const groups = groupList();
  const root = $('#view-groups');
  root.innerHTML = `
    <section class="intro-row">
      <div><p class="eyebrow">FRIENDS <span></span> GROUPS</p><h1>仲間と予定を、<br><em>ゆるく共有しよう。</em></h1></div>
      <div class="intro-actions">
        <button class="ghost-button" data-action="join">${icons.link} 招待コードで参加</button>
        <button class="primary-button" data-action="create"><span>＋</span> グループを作る</button>
      </div>
    </section>
    ${groups.length ? `<div class="group-grid">${groups.map(groupCard).join('')}</div>` : `
      <div class="card empty-state large">${icons.users}
        <h2>まだグループがありません</h2>
        <p>グループを作って招待リンクを送るか、友だちからもらった招待コードで参加しましょう。<br>グループの予定・チャット・通話はメンバー全員で共有されます。</p>
        <div class="intro-actions center"><button class="ghost-button" data-action="join">招待コードで参加</button><button class="primary-button" data-action="create">グループを作る</button></div>
      </div>`}`;
}

function groupCard(group) {
  const upcoming = expandEvents([...state.events.values()].filter((e) => e.groupId === group.id), todayKey(), addDays(todayKey(), 365));
  const next = upcoming[0];
  const call = state.calls.get(group.id);
  return `<article class="card group-card" style="--group:${esc(group.color)}">
    <header>
      <div><h2>${esc(group.name)}</h2><p>${group.members.length}人のメンバー${group.ownerId === state.me.id ? ' · 管理者' : ''}</p></div>
      <button class="icon-button" data-action="settings" data-group="${esc(group.id)}" aria-label="グループの設定" title="設定">${icons.settings}</button>
    </header>
    ${call?.participants.length ? `<p class="live-badge">${icons.phone} 通話中 · ${call.participants.length}人</p>` : ''}
    <ul class="member-list">${group.members.map((id) => `<li>${avatar(id, 'small')}<span>${esc(userName(id))}${id === state.me.id ? '（あなた）' : ''}</span></li>`).join('')}</ul>
    <div class="group-next">${next ? `<span>次の予定</span><strong>${esc(formatDateJa(next.instanceDate))} ${esc(next.title)}</strong>` : '<span>次の予定</span><strong class="muted-text">まだありません</strong>'}</div>
    <div class="group-actions">
      <button class="ghost-button" data-action="chat" data-group="${esc(group.id)}">${icons.chat} チャット</button>
      <button class="ghost-button" data-action="availability" data-group="${esc(group.id)}">${icons.clock} 空き時間</button>
      <button class="ghost-button" data-action="addEvent" data-group="${esc(group.id)}">${icons.plus} 予定</button>
      <button class="ghost-button accent" data-action="invite" data-group="${esc(group.id)}">${icons.share} 招待</button>
    </div>
  </article>`;
}

// --- 作成・参加 -------------------------------------------------------------------

export function openCreateGroup() {
  const body = openModal(`
    <p class="eyebrow">NEW GROUP</p><h2 id="modalTitle">グループを作る</h2>
    <form class="form" id="groupForm">
      <label>グループ名<input name="name" maxlength="30" placeholder="例：2年B組 / 美術部 / いつメン" required autofocus></label>
      <p class="form-error" hidden></p>
      <button class="primary-button submit-button">作成して招待する</button>
    </form>`);
  $('#groupForm', body).addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('.submit-button', body), async () => {
      try {
        const { group } = await api('POST', '/api/groups', { name: e.target.name.value });
        state.groups.set(group.id, group);
        notify();
        openInvite(group.id, true);
      } catch (error) {
        const box = $('.form-error', body);
        box.textContent = error.message;
        box.hidden = false;
      }
    });
  });
}

export function openJoinGroup(prefill = '') {
  const body = openModal(`
    <p class="eyebrow">JOIN GROUP</p><h2 id="modalTitle">招待コードで参加</h2>
    <form class="form" id="joinForm">
      <label>招待コード（8文字）または招待リンク<input name="code" maxlength="200" placeholder="例：K7M2QX9A" value="${esc(prefill)}" required autofocus autocomplete="off"></label>
      <p class="form-error" hidden></p>
      <button class="primary-button submit-button">参加する</button>
    </form>`);
  const form = $('#joinForm', body);
  const extract = (value) => {
    const trimmed = value.trim();
    try {
      return new URL(trimmed).searchParams.get('join') ?? trimmed;
    } catch {
      return trimmed;
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('.submit-button', body), async () => {
      try {
        await joinByCode(extract(form.code.value));
      } catch (error) {
        const box = $('.form-error', body);
        box.textContent = error.message;
        box.hidden = false;
      }
    });
  });
}

export async function joinByCode(code) {
  const clean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (clean.length < 4) throw new Error('招待コードを正しく入力してください');
  const { group, joined } = await api('POST', `/api/invites/${clean}/join`);
  loadBootstrap(await api('GET', '/api/bootstrap'));
  closeModal();
  toast(joined ? `「${group.name}」に参加しました` : `すでに「${group.name}」のメンバーです`, { type: 'success' });
  state.activeChat = group.id;
  location.hash = '#chat';
}

/** 招待リンク経由で開いたとき */
export async function handleInviteParam(code) {
  try {
    const { group } = await api('GET', `/api/invites/${code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`);
    if (state.groups.has(group.id)) {
      toast(`すでに「${group.name}」のメンバーです`);
      return;
    }
    const ok = await confirmDialog({
      title: `「${group.name}」に参加しますか？`,
      message: `現在 ${group.memberCount} 人のメンバーがいます。参加するとグループの予定・チャット・通話を共有します。`,
      confirmLabel: '参加する',
    });
    if (ok) await joinByCode(code);
  } catch (error) {
    toastError(error);
  }
}

// --- 招待（共有） -----------------------------------------------------------------

export function openInvite(groupId, justCreated = false) {
  const group = state.groups.get(groupId);
  if (!group) return;
  const link = inviteLink(group);
  const message = `「${group.name}」で放課後の予定を共有しよう！\n参加はこちら → ${link}\n招待コード：${group.inviteCode}`;
  const body = openModal(`
    <p class="eyebrow">${justCreated ? 'GROUP CREATED' : 'INVITE FRIENDS'}</p>
    <h2 id="modalTitle">${justCreated ? 'グループができました！' : `「${esc(group.name)}」に招待`}</h2>
    <p class="modal-lead">このリンクかコードを友だちに送ると、グループに参加できます。</p>
    <div class="invite-code" aria-label="招待コード">${esc(group.inviteCode.slice(0, 4))}<span>-</span>${esc(group.inviteCode.slice(4))}</div>
    <div class="invite-link"><input readonly value="${esc(link)}" aria-label="招待リンク"><button class="primary-button" data-share="link">${icons.copy} コピー</button></div>
    <div class="share-grid">
      <button class="share-option" data-share="code">${icons.copy}<span>コードをコピー</span></button>
      <button class="share-option" data-share="message">${icons.chat}<span>招待文をコピー</span></button>
      <a class="share-option" href="https://line.me/R/msg/text/?${encodeURIComponent(message)}" target="_blank" rel="noopener noreferrer">${icons.send}<span>LINE で送る</span></a>
      <a class="share-option" href="mailto:?subject=${encodeURIComponent(`${group.name} への招待`)}&body=${encodeURIComponent(message)}">${icons.mail}<span>メールで送る</span></a>
      ${navigator.share ? `<button class="share-option" data-share="native">${icons.share}<span>ほかのアプリ</span></button>` : ''}
    </div>`);
  body.addEventListener('click', async (e) => {
    const method = e.target.closest('[data-share]')?.dataset.share;
    if (!method) return;
    if (method === 'native') {
      try {
        await navigator.share({ title: `${group.name} への招待`, text: message, url: link });
      } catch {
        /* キャンセル */
      }
      return;
    }
    const text = { link, code: group.inviteCode, message }[method];
    if (await copyText(text)) toast('コピーしました', { type: 'success' });
  });
  $('.invite-link input', body).addEventListener('focus', (e) => e.target.select());
}

function openGroupSettings(groupId) {
  const group = state.groups.get(groupId);
  if (!group) return;
  const body = openModal(`
    <p class="eyebrow">SETTINGS</p><h2 id="modalTitle">グループの設定</h2>
    <form class="form" id="renameForm">
      <label>グループ名<input name="name" maxlength="30" value="${esc(group.name)}" required></label>
      <button class="primary-button submit-button">名前を保存</button>
    </form>
    <div class="settings-section">
      <h3>招待コードを作り直す</h3>
      <p>今の招待コード・リンクは使えなくなります。知らない人に広まってしまったときに使ってください。</p>
      <button class="ghost-button" data-action="regenerate">${icons.repeat} 招待コードを作り直す</button>
    </div>
    <div class="settings-section">
      <h3>グループから退出</h3>
      <p>${group.members.length === 1 ? 'あなたが最後のメンバーです。退出するとグループと予定・チャットはすべて削除されます。' : '退出するとこのグループの予定・チャットは見られなくなります。'}</p>
      <button class="ghost-button danger-text" data-action="leave">${icons.x} 退出する</button>
    </div>`);
  $('#renameForm', body).addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('.submit-button', body), async () => {
      try {
        const { group: updated } = await api('PATCH', `/api/groups/${groupId}`, { name: e.target.name.value });
        state.groups.set(updated.id, updated);
        notify();
        toast('グループ名を変更しました', { type: 'success' });
      } catch (error) {
        toastError(error);
      }
    });
  });
  body.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'regenerate') {
      const ok = await confirmDialog({ title: '招待コードを作り直しますか？', message: '今のリンクとコードは使えなくなります。', confirmLabel: '作り直す' });
      if (!ok) return;
      try {
        const { group: updated } = await api('POST', `/api/groups/${groupId}/invite`);
        state.groups.set(updated.id, updated);
        notify();
        openInvite(groupId);
      } catch (error) {
        toastError(error);
      }
    } else if (action === 'leave') {
      const ok = await confirmDialog({ title: `「${group.name}」から退出しますか？`, confirmLabel: '退出する', danger: true });
      if (!ok) return;
      try {
        await api('POST', `/api/groups/${groupId}/leave`);
        removeGroupLocally(groupId);
        closeModal();
        toast('グループから退出しました');
      } catch (error) {
        toastError(error);
      }
    }
  });
}

export function removeGroupLocally(groupId) {
  state.groups.delete(groupId);
  state.messages.delete(groupId);
  state.calls.delete(groupId);
  for (const [id, event] of state.events) if (event.groupId === groupId) state.events.delete(id);
  if (state.activeChat === groupId) state.activeChat = null;
  if (state.sourceFilter === groupId) state.sourceFilter = 'all';
  notify();
}

// --- 空き時間 ---------------------------------------------------------------------

const DAY_START = 7 * 60;
const DAY_END = 23 * 60;

export function openAvailability({ groupId, date } = {}) {
  const groups = groupList();
  if (!groups.length) {
    toast('空き時間を見るには、まずグループを作るか参加してください', { type: 'error', duration: 5000 });
    return;
  }
  const current = { groupId: groupId ?? (state.groups.has(state.sourceFilter) ? state.sourceFilter : groups[0].id), date: date ?? todayKey() };
  const body = openModal(`
    <p class="eyebrow">AVAILABILITY</p><h2 id="modalTitle">みんなの空き時間</h2>
    <div class="form form-row availability-controls">
      <label>グループ<select name="group">${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === current.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
      <label>日付<input type="date" name="date" value="${esc(current.date)}"></label>
    </div>
    <div id="availabilityResult" class="availability"><p class="empty-text">読み込み中…</p></div>`, { wide: true });

  let busyData = null;
  const load = async () => {
    $('#availabilityResult', body).innerHTML = '<p class="empty-text">読み込み中…</p>';
    try {
      busyData = await api('GET', `/api/groups/${current.groupId}/busy`);
      render();
    } catch (error) {
      $('#availabilityResult', body).innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
    }
  };
  const render = () => {
    const members = busyData.members.map((m) => {
      const blocks = expandEvents(m.busy.map((b, i) => ({ id: b.id ?? `busy${i}`, title: b.title ?? '予定あり', category: 'other', ...b })), current.date, current.date);
      return { userId: m.userId, blocks };
    });
    const free = freeSlots(members.flatMap((m) => m.blocks));
    const scale = (minutes) => ((Math.min(Math.max(minutes, DAY_START), DAY_END) - DAY_START) / (DAY_END - DAY_START)) * 100;
    const bar = (blocks, cls) => blocks
      .map((b) => {
        const [s, e] = b.allDay ? [DAY_START, DAY_END] : span(b);
        if (e <= DAY_START || s >= DAY_END) return '';
        return `<span class="${cls}" style="left:${scale(s)}%;width:${Math.max(scale(e) - scale(s), 1)}%" title="${esc(`${b.allDay ? '終日' : `${fromMinutes(s)}–${fromMinutes(e)}`} ${b.title}`)}"></span>`;
      })
      .join('');
    const hours = [];
    for (let h = 8; h <= 22; h += 2) hours.push(`<span style="left:${scale(h * 60)}%">${h}</span>`);
    $('#availabilityResult', body).innerHTML = `
      <p class="modal-lead">${esc(formatDateJa(current.date, { year: true }))} の ${DAY_START / 60}:00〜${DAY_END / 60}:00（予定の中身は、見る権限がある予定だけ表示されます）</p>
      <div class="timeline">
        <div class="timeline-hours">${hours.join('')}</div>
        ${members.map((m) => `<div class="timeline-row">${avatar(m.userId, 'tiny')}<span class="timeline-name">${esc(userName(m.userId))}</span><div class="timeline-track">${bar(m.blocks, 'busy-block')}</div></div>`).join('')}
        <div class="timeline-row everyone"><span class="timeline-name">みんな空き</span><div class="timeline-track">${bar(free.map((f) => ({ start: fromMinutes(f[0]), end: fromMinutes(f[1]), title: 'みんな空いています' })), 'free-block')}</div></div>
      </div>
      <h3 class="free-title">みんなが空いている時間</h3>
      ${free.length ? `<ul class="free-list">${free.map(([s, e]) => `<li><strong>${fromMinutes(s)}–${fromMinutes(e)}</strong><span>${Math.floor((e - s) / 60) ? `${Math.floor((e - s) / 60)}時間` : ''}${(e - s) % 60 ? `${(e - s) % 60}分` : ''}</span><button class="ghost-button small" data-slot="${s}-${e}">${icons.plus} この時間で予定を作る</button></li>`).join('')}</ul>`
        : '<p class="empty-text">この日は全員が空いている時間（30分以上）がありません。別の日を選んでみよう。</p>'}`;
  };

  body.addEventListener('input', (e) => {
    if (e.target.name === 'group') {
      current.groupId = e.target.value;
      load();
    } else if (e.target.name === 'date' && e.target.value) {
      current.date = e.target.value;
      if (busyData) render();
    }
  });
  body.addEventListener('click', (e) => {
    const slot = e.target.closest('[data-slot]');
    if (!slot) return;
    const [s, e2] = slot.dataset.slot.split('-').map(Number);
    openEventForm({ date: current.date, groupId: current.groupId, start: fromMinutes(s), end: fromMinutes(Math.min(e2, s + 120)) });
  });
  load();
}

function freeSlots(blocks) {
  if (blocks.some((b) => b.allDay)) return [];
  const busy = blocks.map(span).sort((a, b) => a[0] - b[0]);
  const free = [];
  let cursor = DAY_START;
  for (const [s, e] of busy) {
    if (s > cursor) free.push([cursor, Math.min(s, DAY_END)]);
    cursor = Math.max(cursor, e);
    if (cursor >= DAY_END) break;
  }
  if (cursor < DAY_END) free.push([cursor, DAY_END]);
  return free.filter(([s, e]) => e - s >= 30);
}
