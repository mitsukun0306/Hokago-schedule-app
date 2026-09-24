// 予定の作成・編集・詳細・共有
import * as backend from './backend.js';
import { state, userName, groupList, notify } from './state.js';
import {
  $, $$, esc, CATEGORIES, REPEAT_LABELS, REMINDER_LABELS, RSVP_LABELS,
  formatDateJa, formatTimeRange, repeatText, expandEvents, overlaps, toICS, downloadFile, copyText,
  todayKey, toMinutes, fromMinutes,
} from './utils.js';
import { openModal, closeModal, confirmDialog, toast, toastError, withBusy, icons, avatar, groupBadge } from './ui.js';

export function applyEvent(event) {
  state.events.set(event.id, event);
  notify();
}

export const eventLink = (id) => `${location.origin}${location.pathname}?event=${encodeURIComponent(id)}`;

// --- 作成・編集フォーム ---------------------------------------------------------

export function openEventForm({ event = null, date, start, end, groupId } = {}) {
  const editing = Boolean(event);
  const values = event ?? {
    title: '',
    date: date ?? state.selectedDate ?? todayKey(),
    allDay: false,
    start: start ?? '16:30',
    end: end ?? '',
    category: 'study',
    location: '',
    memo: '',
    groupId: groupId ?? (state.groups.has(state.sourceFilter) ? state.sourceFilter : null),
    repeat: 'none',
    repeatUntil: '',
    reminder: 0,
  };
  if (!editing && !values.end && values.start) values.end = fromMinutes(Math.min(toMinutes(values.start) + 90, 23 * 60 + 59));
  const canChangeGroup = !editing || event.ownerId === state.me.id;
  const option = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;

  const body = openModal(`
    <p class="eyebrow">${editing ? 'EDIT PLAN' : 'NEW PLAN'}</p>
    <h2 id="modalTitle">${editing ? '予定を編集する' : '予定を追加する'}</h2>
    <form id="eventForm" class="form" novalidate>
      <label>予定のタイトル<input name="title" type="text" maxlength="60" placeholder="例：図書館で勉強" value="${esc(values.title)}" required autofocus></label>
      <div class="form-row">
        <label>日付<input name="date" type="date" value="${esc(values.date)}" required></label>
        <label class="check-label"><input name="allDay" type="checkbox" ${values.allDay ? 'checked' : ''}> 終日</label>
      </div>
      <div class="form-row time-row" ${values.allDay ? 'hidden' : ''}>
        <label>開始<input name="start" type="time" value="${esc(values.start)}"></label>
        <label>終了<input name="end" type="time" value="${esc(values.end)}"></label>
      </div>
      <div class="form-row">
        <label>カテゴリー<select name="category">${Object.entries(CATEGORIES).map(([k, c]) => option(k, c.label, k === values.category)).join('')}</select></label>
        <label>共有先<select name="groupId" ${canChangeGroup ? '' : 'disabled'}>
          ${option('', '自分だけ', !values.groupId)}
          ${groupList().map((g) => option(g.id, g.name, g.id === values.groupId)).join('')}
        </select></label>
      </div>
      <label>場所<input name="location" type="text" maxlength="80" placeholder="例：駅前のカフェ" value="${esc(values.location)}"></label>
      <div class="form-row">
        <label>繰り返し<select name="repeat">${Object.entries(REPEAT_LABELS).map(([k, l]) => option(k, l, k === values.repeat)).join('')}</select></label>
        <label class="repeat-until" ${values.repeat === 'none' ? 'hidden' : ''}>終了日（任意）<input name="repeatUntil" type="date" value="${esc(values.repeatUntil)}"></label>
      </div>
      <label>リマインダー<select name="reminder">${Object.entries(REMINDER_LABELS).map(([k, l]) => option(k, l, Number(k) === values.reminder)).join('')}</select></label>
      <label>メモ<textarea name="memo" rows="3" maxlength="500" placeholder="持ち物や集合場所など">${esc(values.memo)}</textarea></label>
      <p class="form-warning" id="conflictWarning" hidden></p>
      <p class="form-error" id="formError" hidden></p>
      <button class="primary-button submit-button" type="submit">${editing ? '変更を保存する' : '予定を保存する'}</button>
    </form>`);

  const form = $('#eventForm', body);
  const read = () => {
    const data = Object.fromEntries(new FormData(form));
    return {
      title: data.title.trim(),
      date: data.date,
      allDay: form.allDay.checked,
      start: data.start ?? '',
      end: data.end ?? '',
      category: data.category,
      groupId: canChangeGroup ? data.groupId || null : values.groupId,
      location: data.location,
      memo: data.memo,
      repeat: data.repeat,
      repeatUntil: data.repeat === 'none' ? '' : data.repeatUntil,
      reminder: Number(data.reminder),
    };
  };

  const updateConflicts = () => {
    const draft = read();
    const warning = $('#conflictWarning', body);
    if (!draft.date || draft.allDay || !draft.start) {
      warning.hidden = true;
      return;
    }
    const others = [...state.events.values()].filter((e) => e.id !== event?.id && (!e.groupId || e.rsvp?.[state.me.id] !== 'no'));
    const clashes = expandEvents(others, draft.date, draft.date).filter((other) => overlaps(draft, other));
    warning.hidden = !clashes.length;
    warning.innerHTML = clashes.length
      ? `${icons.clock} 同じ時間に「${clashes.map((c) => esc(c.title)).join('」「')}」があります`
      : '';
  };

  form.addEventListener('input', (e) => {
    if (e.target.name === 'allDay') $('.time-row', form).hidden = form.allDay.checked;
    if (e.target.name === 'repeat') $('.repeat-until', form).hidden = form.repeat.value === 'none';
    if (e.target.name === 'start' && form.start.value && form.end.value && form.end.value <= form.start.value) {
      form.end.value = fromMinutes(Math.min(toMinutes(form.start.value) + 60, 23 * 60 + 59));
    }
    updateConflicts();
  });
  updateConflicts();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const draft = read();
    const errorBox = $('#formError', body);
    const fail = (message) => {
      errorBox.textContent = message;
      errorBox.hidden = false;
    };
    if (!draft.title) return fail('タイトルを入力してください');
    if (!draft.date) return fail('日付を入力してください');
    if (!draft.allDay && !draft.start) return fail('開始時刻を入力するか「終日」を選んでください');
    if (!draft.allDay && draft.end && draft.end <= draft.start) return fail('終了時刻は開始時刻より後にしてください');
    withBusy($('.submit-button', form), async () => {
      try {
        const saved = editing ? await backend.updateEvent(event, draft) : await backend.createEvent(draft);
        if (!state.events.has(saved.id)) applyEvent(saved);
        state.selectedDate = saved.date;
        state.cursor = saved.date;
        notify();
        closeModal();
        toast(editing ? '予定を更新しました' : '予定を追加しました', { type: 'success' });
      } catch (error) {
        fail(error.message);
      }
    });
  });
}

// --- 詳細 ---------------------------------------------------------------------

export function openEventDetail(eventId, instanceDate) {
  const event = state.events.get(eventId);
  if (!event) {
    toast('この予定は見つかりませんでした（削除されたか、見る権限がありません）', { type: 'error' });
    return;
  }
  const date = instanceDate ?? event.date;
  const body = openModal(renderDetail(event, date), { wide: true });
  body.dataset.eventId = eventId;
  body.dataset.date = date;
  bindDetail(body);
}

/** 開いている詳細モーダルを最新の状態で描き直す */
export function refreshEventDetail() {
  const body = $('#modalBody');
  const id = body?.dataset.eventId;
  if (!id || $('#modal').hidden) return;
  const event = state.events.get(id);
  if (!event) {
    closeModal();
    toast('この予定は削除されました');
    return;
  }
  const shareOpen = !$('.share-panel', body)?.hidden;
  body.innerHTML = renderDetail(event, body.dataset.date);
  if (shareOpen) $('.share-panel', body).hidden = false;
}

function renderDetail(event, date) {
  const me = state.me.id;
  const group = event.groupId ? state.groups.get(event.groupId) : null;
  const myStatus = event.rsvp?.[me];
  const members = group ? group.members : [event.ownerId];
  const counts = { yes: 0, maybe: 0, no: 0 };
  members.forEach((id) => event.rsvp?.[id] && (counts[event.rsvp[id]] += 1));
  const canDelete = event.ownerId === me || group?.ownerId === me;

  return `
    <div class="detail">
      <div class="detail-badges"><span class="category-badge ${esc(event.category)}">${esc(CATEGORIES[event.category]?.label ?? 'その他')}</span>${groupBadge(event.groupId)}</div>
      <h2 id="modalTitle" class="detail-title">${esc(event.title)}</h2>
      <ul class="detail-meta">
        <li>${icons.calendar}<span>${esc(formatDateJa(date, { year: true }))} · ${esc(formatTimeRange(event))}</span></li>
        ${event.repeat !== 'none' ? `<li>${icons.repeat}<span>${esc(repeatText(event))}</span></li>` : ''}
        ${event.location ? `<li>${icons.pin}<span>${esc(event.location)}</span></li>` : ''}
        ${event.reminder ? `<li>${icons.bell}<span>${esc(REMINDER_LABELS[event.reminder])}にお知らせ</span></li>` : ''}
        <li>${avatar(event.ownerId, 'tiny')}<span>${esc(userName(event.ownerId))}さんが作成</span></li>
      </ul>
      ${event.memo ? `<p class="detail-memo">${esc(event.memo)}</p>` : ''}
      ${group ? `
        <section class="rsvp">
          <div class="rsvp-head"><h3>出欠</h3><span>参加 ${counts.yes} · 未定 ${counts.maybe} · 不参加 ${counts.no}</span></div>
          <div class="rsvp-buttons" role="group" aria-label="自分の出欠">
            ${Object.entries(RSVP_LABELS).map(([key, label]) => `<button class="rsvp-button ${key} ${myStatus === key ? 'active' : ''}" data-rsvp="${key}" aria-pressed="${myStatus === key}">${label}</button>`).join('')}
          </div>
          <ul class="rsvp-list">
            ${members.map((id) => `<li>${avatar(id, 'tiny')}<span>${esc(userName(id))}</span><em class="rsvp-status ${esc(event.rsvp?.[id] ?? 'none')}">${esc(RSVP_LABELS[event.rsvp?.[id]] ?? '未回答')}</em></li>`).join('')}
          </ul>
        </section>` : ''}
      <div class="detail-actions">
        <button class="ghost-button" data-action="edit">${icons.edit} 編集</button>
        <button class="ghost-button" data-action="share">${icons.share} 共有</button>
        ${canDelete ? `<button class="ghost-button danger-text" data-action="delete">${icons.trash} 削除</button>` : ''}
      </div>
      <div class="share-panel" hidden>
        <p class="share-note">${group ? `「${esc(group.name)}」のメンバーはリンクから開けます。` : 'この予定は自分だけに見えています。リンクやカレンダーファイル、テキストで共有できます。'}</p>
        <div class="share-grid">
          <button class="share-option" data-share="link">${icons.link}<span>リンクをコピー</span></button>
          <button class="share-option" data-share="text">${icons.copy}<span>テキストでコピー</span></button>
          <button class="share-option" data-share="chat">${icons.chat}<span>チャットに送る</span></button>
          <button class="share-option" data-share="ics">${icons.download}<span>カレンダーに追加(.ics)</span></button>
          ${navigator.share ? `<button class="share-option" data-share="native">${icons.share}<span>ほかのアプリ</span></button>` : ''}
        </div>
      </div>
    </div>`;
}

export function eventAsText(event, date = event.date) {
  const group = event.groupId ? state.groups.get(event.groupId) : null;
  return [
    `📅 ${event.title}`,
    `${formatDateJa(date, { year: true })} ${formatTimeRange(event)}`,
    event.location && `📍 ${event.location}`,
    event.memo,
    group && eventLink(event.id),
  ].filter(Boolean).join('\n');
}

function bindDetail(body) {
  body.addEventListener('click', async (e) => {
    const event = state.events.get(body.dataset.eventId);
    if (!event) return;
    const date = body.dataset.date;
    const rsvp = e.target.closest('[data-rsvp]');
    const action = e.target.closest('[data-action]')?.dataset.action;
    const share = e.target.closest('[data-share]')?.dataset.share;

    if (rsvp) {
      const status = rsvp.dataset.rsvp === event.rsvp?.[state.me.id] ? 'none' : rsvp.dataset.rsvp;
      await setRsvp(event.id, status, rsvp);
    } else if (action === 'edit') {
      openEventForm({ event });
    } else if (action === 'share') {
      const panel = $('.share-panel', body);
      panel.hidden = !panel.hidden;
    } else if (action === 'delete') {
      await deleteEvent(event);
    } else if (share) {
      await shareEvent(event, date, share);
    }
  });
}

export async function setRsvp(eventId, status, button) {
  await withBusy(button, async () => {
    try {
      await backend.setRsvp(eventId, status);
      refreshEventDetail();
    } catch (error) {
      toastError(error);
    }
  });
}

async function deleteEvent(event) {
  const ok = await confirmDialog({
    title: '予定を削除しますか？',
    message: event.repeat !== 'none' ? '繰り返しの予定はすべての回が削除されます。' : event.groupId ? 'グループのメンバー全員のカレンダーから削除されます。' : '',
    confirmLabel: '削除する',
    danger: true,
  });
  if (!ok) return;
  try {
    await backend.deleteEvent(event);
    state.events.delete(event.id);
    notify();
    closeModal();
    toast('予定を削除しました');
  } catch (error) {
    toastError(error);
  }
}

async function shareEvent(event, date, method) {
  const group = event.groupId ? state.groups.get(event.groupId) : null;
  if (method === 'link') {
    if (!group) toast('自分だけの予定のリンクは、自分しか開けません', { duration: 4000 });
    if (await copyText(eventLink(event.id))) toast('リンクをコピーしました', { type: 'success' });
  } else if (method === 'text') {
    if (await copyText(eventAsText(event, date))) toast('予定をテキストでコピーしました', { type: 'success' });
  } else if (method === 'ics') {
    downloadFile(`${event.title.replace(/[\\/:*?"<>|]/g, '_')}.ics`, toICS([event], { groupName: group?.name }), 'text/calendar;charset=utf-8');
  } else if (method === 'native') {
    try {
      await navigator.share({ title: event.title, text: eventAsText(event, date) });
    } catch {
      /* キャンセル */
    }
  } else if (method === 'chat') {
    shareToChat(event, date);
  }
}

function shareToChat(event, date) {
  const groups = groupList();
  if (!groups.length) {
    toast('まだグループがありません。「グループ」から作成・参加できます', { type: 'error', duration: 5000 });
    return;
  }
  const send = async (groupId) => {
    try {
      const payload = event.groupId === groupId ? { eventId: event.id, text: '' } : { text: eventAsText(event, date) };
      await backend.sendMessage(groupId, payload);
      toast(`「${state.groups.get(groupId).name}」に送りました`, { type: 'success' });
    } catch (error) {
      toastError(error);
    }
  };
  if (event.groupId) return send(event.groupId);
  const panel = $('.share-panel', $('#modalBody'));
  const picker = document.createElement('div');
  picker.className = 'chat-picker';
  picker.innerHTML = `<p>どのチャットに送りますか？</p>${groups.map((g) => `<button class="ghost-button" data-group="${esc(g.id)}">${esc(g.name)}</button>`).join('')}`;
  $$('.chat-picker', panel).forEach((el) => el.remove());
  panel.appendChild(picker);
  picker.addEventListener('click', (e) => {
    const button = e.target.closest('[data-group]');
    if (button) {
      picker.remove();
      send(button.dataset.group);
    }
  });
}
