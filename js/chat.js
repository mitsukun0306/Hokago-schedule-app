// グループチャット
import { api } from './api.js';
import { state, notify, groupList, userName, unreadCount, markRead } from './state.js';
import {
  $, esc, CATEGORIES, RSVP_LABELS, formatDateJa, formatTimeRange, formatClock, formatDuration, relativeDay, toKey,
  linkify, todayKey, expandEvents, addDays, repeatText,
} from './utils.js';
import { avatar, avatarStack, icons, toastError, confirmDialog, openModal, closeModal, withBusy } from './ui.js';
import { openEventDetail, openEventForm, setRsvp } from './events.js';
import { openInvite } from './groups.js';
import { startCall, currentCall, showCall } from './call.js';

const drafts = new Map();
let renderedGroup = null;
let renderedCount = 0;

export function initChat() {
  const root = $('#view-chat');
  root.innerHTML = `
    <div class="chat-layout card">
      <aside class="chat-list" aria-label="グループ一覧">
        <div class="chat-list-head"><h2>チャット</h2><a class="icon-button" href="#groups" title="グループを管理" aria-label="グループを管理">${icons.users}</a></div>
        <div id="chatGroups"></div>
      </aside>
      <section class="chat-room" id="chatRoom" aria-live="polite"></section>
    </div>`;

  root.addEventListener('click', async (e) => {
    const groupButton = e.target.closest('[data-open-chat]');
    if (groupButton) {
      state.activeChat = groupButton.dataset.openChat;
      notify();
      return;
    }
    const action = e.target.closest('[data-chat-action]')?.dataset.chatAction;
    const groupId = state.activeChat;
    if (action === 'back') {
      state.activeChat = null;
      notify();
    } else if (action === 'audio' || action === 'video') {
      startCall(groupId, action);
    } else if (action === 'join-call') {
      const call = currentCall();
      if (call?.groupId === groupId) showCall();
      else startCall(groupId, 'audio');
    } else if (action === 'invite') {
      openInvite(groupId);
    } else if (action === 'attach-event') {
      pickEvent(groupId);
    } else if (action === 'delete-message') {
      const id = e.target.closest('[data-message]').dataset.message;
      if (await confirmDialog({ title: 'メッセージを削除しますか？', message: 'グループの全員の画面から消えます。', confirmLabel: '削除する', danger: true })) {
        api('DELETE', `/api/messages/${id}`).catch(toastError);
      }
    }
    const eventCard = e.target.closest('[data-event-card]');
    const rsvp = e.target.closest('[data-rsvp]');
    if (rsvp) {
      const event = state.events.get(rsvp.dataset.id);
      setRsvp(rsvp.dataset.id, event?.rsvp?.[state.me.id] === rsvp.dataset.rsvp ? 'none' : rsvp.dataset.rsvp, rsvp);
    } else if (eventCard && !e.target.closest('button')) {
      openEventDetail(eventCard.dataset.eventCard);
    } else if (e.target.closest('[data-open-event]')) {
      openEventDetail(e.target.closest('[data-open-event]').dataset.openEvent);
    }
  });

  root.addEventListener('submit', (e) => {
    if (e.target.id !== 'composer') return;
    e.preventDefault();
    send();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-event-card]')) {
      openEventDetail(e.target.dataset.eventCard);
      return;
    }
    if (e.target.id === 'composerInput' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  root.addEventListener('input', (e) => {
    if (e.target.id !== 'composerInput') return;
    drafts.set(state.activeChat, e.target.value);
    autosize(e.target);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.view === 'chat' && state.activeChat && markRead(state.activeChat)) notify();
  });
}

function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
}

async function send() {
  const input = $('#composerInput');
  const groupId = state.activeChat;
  const text = input.value.trim();
  if (!text || !groupId) return;
  const button = $('#composer .send-button');
  await withBusy(button, async () => {
    try {
      await api('POST', `/api/groups/${groupId}/messages`, { text });
      input.value = '';
      drafts.delete(groupId);
      autosize(input);
      input.focus();
    } catch (error) {
      toastError(error);
    }
  });
}

function pickEvent(groupId) {
  const today = todayKey();
  const events = expandEvents([...state.events.values()].filter((e) => e.groupId === groupId), today, addDays(today, 120));
  const seen = new Set();
  const unique = events.filter((e) => !seen.has(e.id) && seen.add(e.id));
  const body = openModal(`
    <p class="eyebrow">SHARE PLAN</p><h2 id="modalTitle">予定をチャットに共有</h2>
    <p class="modal-lead">共有した予定には、チャットから出欠を回答できます。</p>
    <div class="pick-list">
      ${unique.length ? unique.map((e) => `<button class="upcoming-item" data-pick="${esc(e.id)}"><div class="upcoming-date"><strong>${Number(e.instanceDate.slice(8))}</strong>${esc(formatDateJa(e.instanceDate, { weekday: false }).replace(/\d+日$/, ''))}</div><div class="upcoming-info"><strong>${esc(e.title)}</strong><span>${esc(formatDateJa(e.instanceDate))} ${esc(formatTimeRange(e))}</span></div></button>`).join('') : '<p class="empty-text">このグループのこれからの予定はありません。</p>'}
    </div>
    <button class="primary-button submit-button" data-new-event>${icons.plus} 新しい予定を作って共有</button>`);
  body.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      try {
        await api('POST', `/api/groups/${groupId}/messages`, { eventId: pick.dataset.pick, text: '' });
        closeModal();
      } catch (error) {
        toastError(error);
      }
    } else if (e.target.closest('[data-new-event]')) {
      openEventForm({ groupId });
    }
  });
}

export function renderChat() {
  const groups = groupList();
  if (state.activeChat && !state.groups.has(state.activeChat)) state.activeChat = null;
  const wide = matchMedia('(min-width: 761px)').matches;
  if (!state.activeChat && wide && groups.length) state.activeChat = groups[0].id;
  $('#view-chat .chat-layout').classList.toggle('room-open', Boolean(state.activeChat));

  $('#chatGroups').innerHTML = groups.length
    ? groups
        .map((g) => {
          const messages = state.messages.get(g.id) ?? [];
          const last = messages.at(-1);
          const unread = unreadCount(g.id);
          const inCall = state.calls.get(g.id)?.participants.length;
          return `<button class="chat-group ${g.id === state.activeChat ? 'active' : ''}" data-open-chat="${esc(g.id)}" style="--group:${esc(g.color)}">
            <span class="group-icon">${esc(g.name.slice(0, 1))}</span>
            <span class="chat-group-body"><strong>${esc(g.name)}</strong><small>${inCall ? `${icons.phone} 通話中` : esc(last ? preview(last) : 'まだメッセージはありません')}</small></span>
            <span class="chat-group-side">${last ? `<small>${esc(shortTime(last.createdAt))}</small>` : ''}${unread ? `<em class="unread">${unread > 99 ? '99+' : unread}</em>` : ''}</span>
          </button>`;
        })
        .join('')
    : `<div class="empty-state">${icons.chat}<p>グループに参加するとチャットできます</p><a class="primary-button" href="#groups">グループへ</a></div>`;

  renderRoom();
}

function preview(message) {
  if (message.deleted) return 'メッセージが削除されました';
  const name = message.userId ? `${userName(message.userId)}: ` : '';
  if (message.kind === 'event') return `${name}📅 ${state.events.get(message.eventId)?.title ?? message.text}`;
  if (message.kind === 'call') return `${userName(message.userId)}さんが${message.text}`;
  return `${message.kind === 'text' ? name : ''}${message.text}`;
}

function shortTime(ms) {
  const key = toKey(new Date(ms));
  if (key === todayKey()) return formatClock(ms);
  return relativeDay(key) || formatDateJa(key, { weekday: false });
}

function renderRoom() {
  const room = $('#chatRoom');
  const group = state.groups.get(state.activeChat);
  if (!group) {
    room.innerHTML = `<div class="empty-state">${icons.chat}<p>チャットを選んでください</p></div>`;
    renderedGroup = null;
    return;
  }
  const messages = state.messages.get(group.id) ?? [];
  const call = state.calls.get(group.id);
  const inThisCall = currentCall()?.groupId === group.id;

  if (renderedGroup !== group.id) {
    room.innerHTML = `
      <header class="chat-head">
        <button class="icon-button back-button" data-chat-action="back" aria-label="一覧に戻る">${icons.back}</button>
        <div class="chat-title"></div>
        <div class="chat-tools">
          <button class="icon-button" data-chat-action="audio" title="音声通話" aria-label="音声通話">${icons.phone}</button>
          <button class="icon-button" data-chat-action="video" title="ビデオ通話" aria-label="ビデオ通話">${icons.video}</button>
          <button class="icon-button" data-chat-action="invite" title="友だちを招待" aria-label="友だちを招待">${icons.share}</button>
        </div>
      </header>
      <div class="call-banner" hidden></div>
      <div class="messages" id="messages" tabindex="0" aria-label="メッセージ"></div>
      <form class="composer" id="composer">
        <button type="button" class="icon-button" data-chat-action="attach-event" title="予定を共有" aria-label="予定を共有">${icons.calendar}</button>
        <textarea id="composerInput" rows="1" maxlength="1000" placeholder="メッセージを入力" aria-label="メッセージ"></textarea>
        <button class="send-button" type="submit" aria-label="送信">${icons.send}</button>
      </form>`;
    const input = $('#composerInput');
    input.value = drafts.get(group.id) ?? '';
    autosize(input);
    renderedCount = -1;
  }

  $('.chat-title', room).innerHTML = `<strong>${esc(group.name)}</strong><span>${avatarStack(group.members, 4)}${group.members.length}人</span>`;
  const banner = $('.call-banner', room);
  if (call?.participants.length) {
    banner.hidden = false;
    const names = [...new Set(call.participants.map((p) => p.userId))].map(userName);
    banner.innerHTML = `<span class="pulse"></span><span>${inThisCall ? '参加中の通話' : '通話中'} · ${esc(names.join('、'))}${call.startedAt ? ` · <time data-since="${call.startedAt}">${formatDuration(Date.now() - call.startedAt)}</time>` : ''}</span>
      <button class="primary-button small" data-chat-action="join-call">${inThisCall ? '通話に戻る' : '参加する'}</button>`;
  } else {
    banner.hidden = true;
  }

  const list = $('#messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const firstRender = renderedCount === -1;
  list.innerHTML = messages.length ? renderMessages(messages) : `<div class="empty-state">${icons.chat}<p>最初のメッセージを送ってみよう</p></div>`;
  const grewByMine = messages.length > renderedCount && messages.at(-1)?.userId === state.me.id;
  if (firstRender || nearBottom || grewByMine) list.scrollTop = list.scrollHeight;
  renderedCount = messages.length;
  renderedGroup = group.id;

  if (state.view === 'chat' && !document.hidden && markRead(group.id)) notify();
}

function renderMessages(messages) {
  const me = state.me.id;
  let html = '';
  let lastDay = null;
  let previous = null;
  for (const message of messages) {
    const day = toKey(new Date(message.createdAt));
    if (day !== lastDay) {
      html += `<div class="day-divider"><span>${esc(relativeDay(day) || formatDateJa(day, { year: day.slice(0, 4) !== todayKey().slice(0, 4) }))}</span></div>`;
      lastDay = day;
      previous = null;
    }
    if (message.kind === 'system' || message.kind === 'call') {
      html += `<div class="system-message">${message.kind === 'call' ? icons.phone : ''}${esc(message.kind === 'call' ? `${userName(message.userId)}さんが${message.text}` : message.text)}<time>${formatClock(message.createdAt)}</time></div>`;
      previous = null;
      continue;
    }
    const mine = message.userId === me;
    const continued = previous && previous.userId === message.userId && message.createdAt - previous.createdAt < 5 * 60 * 1000;
    html += `<div class="message ${mine ? 'mine' : ''} ${continued ? 'continued' : ''}" data-message="${esc(message.id)}">
      ${mine ? '' : `<div class="message-avatar">${continued ? '' : avatar(message.userId, 'small')}</div>`}
      <div class="message-body">
        ${!mine && !continued ? `<span class="message-name">${esc(userName(message.userId))}</span>` : ''}
        <div class="message-line">
          ${message.deleted ? '<div class="bubble deleted">メッセージを削除しました</div>' : message.kind === 'event' ? eventCard(message) : `<div class="bubble">${linkify(esc(message.text)).replace(/\n/g, '<br>')}</div>`}
          <span class="message-meta">${mine && !message.deleted ? `<button class="delete-message" data-chat-action="delete-message" aria-label="削除" title="削除">${icons.trash}</button>` : ''}<time>${formatClock(message.createdAt)}</time></span>
        </div>
      </div>
    </div>`;
    previous = message;
  }
  return html;
}

function eventCard(message) {
  const event = state.events.get(message.eventId);
  if (!event) return `<div class="bubble deleted">📅 ${esc(message.text || '共有された予定')}（削除されました）</div>`;
  const group = state.groups.get(event.groupId);
  const me = state.me.id;
  const yes = group ? group.members.filter((id) => event.rsvp?.[id] === 'yes').length : 0;
  return `<div class="event-card" data-event-card="${esc(event.id)}" role="button" tabindex="0">
    <div class="event-card-head"><span class="category-badge ${esc(event.category)}">${esc(CATEGORIES[event.category]?.label ?? '')}</span><small>${message.text ? esc(message.text) : '予定を共有しました'}</small></div>
    <strong>${esc(event.title)}</strong>
    <span>${icons.calendar}${esc(event.repeat !== 'none' ? repeatText(event) : formatDateJa(event.date))} ${esc(formatTimeRange(event))}</span>
    ${event.location ? `<span>${icons.pin}${esc(event.location)}</span>` : ''}
    <div class="event-card-foot">
      <span>${icons.users}参加 ${yes}${group ? `/${group.members.length}` : ''}</span>
      <div class="mini-rsvp">${Object.entries(RSVP_LABELS).map(([key, label]) => `<button class="rsvp-button small ${key} ${event.rsvp?.[me] === key ? 'active' : ''}" data-rsvp="${key}" data-id="${esc(event.id)}" aria-pressed="${event.rsvp?.[me] === key}">${label}</button>`).join('')}</div>
    </div>
  </div>`;
}

/** チャット画面の通話時間表示を1秒ごとに更新 */
export function tickChatTimers() {
  document.querySelectorAll('time[data-since]').forEach((el) => {
    el.textContent = formatDuration(Date.now() - Number(el.dataset.since));
  });
}
