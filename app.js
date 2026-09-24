// Afterclass — エントリーポイント
import { api, auth, connectStream } from './js/api.js';
import { state, subscribe, notify, loadBootstrap, userName, unreadCount, groupList, resetSessionCaches } from './js/state.js';
import { $, esc, storage, todayKey, addDays, expandEvents, toMinutes, formatClock, copyText, formatDateJa, formatTimeRange } from './js/utils.js';
import { icons, avatar, toast, toastError, openModal, closeModal, isModalOpen, confirmDialog, withBusy } from './js/ui.js';
import { initCalendar, renderCalendar } from './js/calendar.js';
import { initSchedule, renderSchedule } from './js/schedule.js';
import { initChat, renderChat, tickChatTimers } from './js/chat.js';
import { initGroups, renderGroups, handleInviteParam, removeGroupLocally } from './js/groups.js';
import { initCall, loadCallConfig, handleSignal, handleCallState, currentCall, startCall, tickCall, leaveCall } from './js/call.js';
import { openEventDetail, refreshEventDetail } from './js/events.js';

const VIEWS = ['calendar', 'schedule', 'chat', 'groups'];
let stream = null;
let hasConnectedOnce = false;

// --- ログイン -------------------------------------------------------------------

function showLogin(pendingInvite) {
  $('#appShell').hidden = true;
  const screen = $('#login');
  screen.hidden = false;
  if (pendingInvite) {
    api('GET', `/api/invites/${pendingInvite.replace(/[^A-Za-z0-9]/g, '')}`)
      .then(({ group }) => {
        const note = $('#loginInvite');
        note.hidden = false;
        note.innerHTML = `${icons.users}<span><strong>${esc(group.name)}</strong> に招待されています。<br>ニックネームを決めて参加しよう。</span>`;
      })
      .catch(() => {});
  }
  $('#loginName').focus();
}

function initLogin() {
  $('#loginToggle').addEventListener('click', () => {
    const codeMode = $('#loginForm').dataset.mode !== 'code';
    $('#loginForm').dataset.mode = codeMode ? 'code' : 'name';
    $('#loginNameField').hidden = codeMode;
    $('#loginCodeField').hidden = !codeMode;
    $('#loginToggle').textContent = codeMode ? 'ニックネームで新しくはじめる' : 'ほかの端末で使っていた人（ログインコード）';
    (codeMode ? $('#loginCode') : $('#loginName')).focus();
  });
  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const codeMode = e.target.dataset.mode === 'code';
    const payload = codeMode ? { code: $('#loginCode').value.trim() } : { name: $('#loginName').value.trim() };
    const error = $('#loginError');
    if (!payload.code && !payload.name) {
      error.textContent = codeMode ? 'ログインコードを入力してください' : 'ニックネームを入力してください';
      error.hidden = false;
      return;
    }
    withBusy($('#loginForm button[type="submit"]'), async () => {
      try {
        const { token } = await api('POST', '/api/login', payload);
        auth.set(token);
        error.hidden = true;
        await start();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    });
  });
}

// --- 起動 -----------------------------------------------------------------------

async function start() {
  const params = new URLSearchParams(location.search);
  const invite = params.get('join');
  const eventParam = params.get('event');
  if (!auth.token) {
    showLogin(invite);
    return;
  }
  try {
    loadBootstrap(await api('GET', '/api/bootstrap'));
  } catch (error) {
    if (error.status === 401) {
      auth.clear();
      showLogin(invite);
      return;
    }
    $('#appShell').hidden = true;
    $('#login').hidden = false;
    $('#loginError').textContent = `${error.message}（python3 server.py でサーバーを起動してから開いてください）`;
    $('#loginError').hidden = false;
    return;
  }
  $('#login').hidden = true;
  $('#appShell').hidden = false;
  if (invite || eventParam) history.replaceState(null, '', location.pathname + location.hash);
  renderProfile();
  onRoute();
  openStream();
  loadCallConfig();
  if (invite) handleInviteParam(invite);
  if (eventParam) openEventDetail(eventParam);
}

function openStream() {
  stream?.stop();
  stream = connectStream({
    onEvent: handleServerEvent,
    onOpen: async () => {
      state.connected = true;
      $('#connectionBanner').hidden = true;
      if (hasConnectedOnce) {
        // 切断中に届かなかった変更を取り込む
        try {
          loadBootstrap(await api('GET', '/api/bootstrap'));
        } catch {
          /* 次の再接続で再試行 */
        }
      }
      hasConnectedOnce = true;
    },
    onDisconnect: () => {
      state.connected = false;
      $('#connectionBanner').hidden = false;
    },
    onUnauthorized: () => logout(true),
  });
}

// --- サーバーからのリアルタイムイベント --------------------------------------------

function handleServerEvent({ type, payload }) {
  const me = state.me?.id;
  switch (type) {
    case 'event.upsert': {
      const isNew = !state.events.has(payload.event.id);
      state.events.set(payload.event.id, payload.event);
      if (isNew && payload.event.ownerId !== me && payload.event.groupId) {
        const group = state.groups.get(payload.event.groupId);
        pushNotification({
          text: `${userName(payload.event.ownerId)}さんが「${group?.name}」に予定「${payload.event.title}」を追加しました`,
          action: { type: 'event', id: payload.event.id },
        });
      }
      refreshEventDetail();
      break;
    }
    case 'event.delete':
      state.events.delete(payload.id);
      refreshEventDetail();
      break;
    case 'message.new': {
      const { message } = payload;
      const list = state.messages.get(message.groupId) ?? [];
      if (!list.some((m) => m.id === message.id)) list.push(message);
      state.messages.set(message.groupId, list);
      const viewing = state.view === 'chat' && state.activeChat === message.groupId && !document.hidden;
      if (message.userId !== me && message.kind !== 'system' && message.kind !== 'call' && !viewing) {
        const group = state.groups.get(message.groupId);
        const text = message.kind === 'event' ? `📅 予定を共有しました` : message.text;
        pushNotification({ text: `${group?.name} · ${userName(message.userId)}: ${text}`, action: { type: 'chat', id: message.groupId }, silent: true });
        browserNotify(`${userName(message.userId)}（${group?.name}）`, text, message.groupId);
      }
      break;
    }
    case 'message.update': {
      const list = state.messages.get(payload.message.groupId) ?? [];
      const index = list.findIndex((m) => m.id === payload.message.id);
      if (index >= 0) list[index] = payload.message;
      break;
    }
    case 'group.update': {
      state.groups.set(payload.group.id, payload.group);
      payload.users.forEach((user) => state.users.set(user.id, user));
      break;
    }
    case 'group.remove':
      removeGroupLocally(payload.groupId);
      break;
    case 'user.update':
      state.users.set(payload.user.id, payload.user);
      if (payload.user.id === me) {
        state.me = payload.user;
        renderProfile();
      }
      break;
    case 'call.state': {
      const before = state.calls.get(payload.groupId)?.participants.length ?? 0;
      handleCallState(payload);
      const after = payload.participants;
      const starter = after[0];
      if (!before && after.length && starter.userId !== me && currentCall()?.groupId !== payload.groupId) {
        const group = state.groups.get(payload.groupId);
        const label = starter.kind === 'video' ? 'ビデオ通話' : '音声通話';
        toast(`${userName(starter.userId)}さんが「${group?.name}」で${label}を始めました`, {
          duration: 15000,
          actions: [{ label: '参加する', onClick: () => startCall(payload.groupId, starter.kind) }],
        });
        pushNotification({ text: `「${group?.name}」で${label}が始まりました`, action: { type: 'chat', id: payload.groupId } });
        browserNotify(`「${group?.name}」で${label}中`, `${userName(starter.userId)}さんが通話を始めました`, payload.groupId);
      }
      break;
    }
    case 'signal':
      handleSignal(payload);
      return;
    default:
      return;
  }
  notify();
}

// --- 通知 -----------------------------------------------------------------------

function pushNotification({ text, action }) {
  state.notifications.unshift({ id: crypto.randomUUID?.() ?? String(Math.random()), text, action, at: Date.now(), read: false });
  state.notifications.splice(30);
  renderNotifications();
}

function browserNotify(title, body, groupId) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: groupId, icon: undefined });
    n.onclick = () => {
      window.focus();
      state.activeChat = groupId;
      location.hash = '#chat';
      n.close();
    };
  } catch {
    /* 一部ブラウザは Service Worker 経由のみ対応 */
  }
}

function renderNotifications() {
  const unread = state.notifications.filter((n) => !n.read).length;
  $('#notifButton i').hidden = !unread;
  $('#notifButton').setAttribute('aria-label', unread ? `通知 ${unread}件` : '通知');
  $('#notifPanel').innerHTML = `
    <div class="dropdown-head"><strong>お知らせ</strong>${state.notifications.length ? '<button class="link-button" data-clear>すべて消す</button>' : ''}</div>
    ${state.notifications.length ? `<ul class="notif-list">${state.notifications.map((n) => `<li><button class="${n.read ? '' : 'unread'}" data-notif="${esc(n.id)}"><span>${esc(n.text)}</span><time>${formatClock(n.at)}</time></button></li>`).join('')}</ul>` : '<p class="empty-text">新しいお知らせはありません</p>'}
    ${'Notification' in window && Notification.permission === 'default' ? `<button class="ghost-button full" data-permission>${icons.bell} ブラウザ通知をオンにする</button>` : ''}`;
}

function initNotifications() {
  const button = $('#notifButton');
  const panel = $('#notifPanel');
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#profileMenu').hidden = true;
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) {
      renderNotifications();
      state.notifications.forEach((n) => (n.read = true));
      $('#notifButton i').hidden = true;
    }
  });
  panel.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (e.target.closest('[data-clear]')) {
      state.notifications = [];
      renderNotifications();
      return;
    }
    if (e.target.closest('[data-permission]')) {
      await Notification.requestPermission();
      renderNotifications();
      return;
    }
    const item = e.target.closest('[data-notif]');
    if (!item) return;
    const notification = state.notifications.find((n) => n.id === item.dataset.notif);
    panel.hidden = true;
    if (notification?.action.type === 'chat') {
      state.activeChat = notification.action.id;
      location.hash = '#chat';
    } else if (notification?.action.type === 'event') {
      openEventDetail(notification.action.id);
    }
  });
  document.addEventListener('click', () => {
    panel.hidden = true;
    $('#profileMenu').hidden = true;
  });
  renderNotifications();
}

// --- リマインダー（アプリを開いている間） ------------------------------------------

function checkReminders() {
  if (!state.me) return;
  const today = todayKey();
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const firedKey = `afterclass.reminded.${state.me.id}`;
  const fired = storage.get(firedKey, {});
  const tomorrowKey = addDays(today, 1);
  const candidates = [...state.events.values()].filter((e) => e.reminder && (!e.groupId || e.rsvp?.[state.me.id] === 'yes' || e.ownerId === state.me.id));
  let changed = false;
  for (const instance of expandEvents(candidates, today, tomorrowKey)) {
    if (fired[instance.key]) continue;
    const startMinutes = instance.allDay ? 8 * 60 : toMinutes(instance.start);
    const dayOffset = instance.instanceDate === today ? 0 : 24 * 60;
    const minutesUntil = startMinutes + dayOffset - nowMinutes;
    if (minutesUntil <= instance.reminder && minutesUntil > -5) {
      fired[instance.key] = Date.now();
      changed = true;
      const when = `${formatDateJa(instance.instanceDate)} ${formatTimeRange(instance)}`;
      toast(`⏰ もうすぐ「${instance.title}」（${when}）`, {
        duration: 12000,
        actions: [{ label: '詳細', onClick: () => openEventDetail(instance.id, instance.instanceDate) }],
      });
      pushNotification({ text: `⏰ リマインダー：「${instance.title}」${when}`, action: { type: 'event', id: instance.id } });
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(`⏰ ${instance.title}`, { body: when, tag: instance.key });
        } catch {
          /* noop */
        }
      }
    }
  }
  if (changed) {
    const weekAgo = Date.now() - 7 * 86400000;
    Object.keys(fired).forEach((key) => fired[key] < weekAgo && delete fired[key]);
    storage.set(firedKey, fired);
  }
}

// --- プロフィール ----------------------------------------------------------------

function renderProfile() {
  $('#profileButton').innerHTML = `${avatar(state.me.id)}<span class="profile-name">${esc(state.me.name)}</span><span class="chevron">⌄</span>`;
}

function initProfile() {
  $('#profileButton').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#notifPanel').hidden = true;
    const menu = $('#profileMenu');
    menu.hidden = !menu.hidden;
    $('#profileButton').setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('#profileMenu').addEventListener('click', async (e) => {
    e.stopPropagation();
    const action = e.target.closest('[data-profile]')?.dataset.profile;
    if (!action) return;
    $('#profileMenu').hidden = true;
    if (action === 'rename') openRename();
    if (action === 'code') openLoginCode();
    if (action === 'notify') {
      if (!('Notification' in window)) return toast('このブラウザは通知に対応していません', { type: 'error' });
      const result = await Notification.requestPermission();
      toast(result === 'granted' ? '通知をオンにしました' : '通知は許可されませんでした（ブラウザの設定から変更できます）', { type: result === 'granted' ? 'success' : 'error' });
      renderNotifications();
    }
    if (action === 'logout') {
      const ok = await confirmDialog({ title: 'ログアウトしますか？', message: 'もう一度使うにはログインコードが必要です。先に「ログインコード」を控えておいてください。', confirmLabel: 'ログアウト', danger: true });
      if (ok) logout();
    }
    return undefined;
  });
}

function openRename() {
  const body = openModal(`
    <p class="eyebrow">PROFILE</p><h2 id="modalTitle">ニックネームを変更</h2>
    <form class="form" id="renameMe"><label>ニックネーム<input name="name" maxlength="20" value="${esc(state.me.name)}" required autofocus></label>
    <button class="primary-button submit-button">保存する</button></form>`);
  $('#renameMe', body).addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('.submit-button', body), async () => {
      try {
        const { user } = await api('PATCH', '/api/me', { name: e.target.name.value });
        state.me = user;
        state.users.set(user.id, user);
        renderProfile();
        notify();
        closeModal();
        toast('ニックネームを変更しました', { type: 'success' });
      } catch (error) {
        toastError(error);
      }
    });
  });
}

function openLoginCode() {
  const body = openModal(`
    <p class="eyebrow">LOGIN CODE</p><h2 id="modalTitle">ログインコード</h2>
    <p class="modal-lead">ほかの端末で同じアカウントを使うときに入力するコードです。<strong>パスワードと同じなので、人には教えないでください。</strong></p>
    <div class="secret-box"><code id="secretCode">••••••••••••••••••••</code><button class="ghost-button small" data-reveal>表示</button></div>
    <button class="primary-button submit-button" data-copy>${icons.copy} コピーする</button>`);
  body.addEventListener('click', async (e) => {
    if (e.target.closest('[data-reveal]')) $('#secretCode', body).textContent = auth.token;
    if (e.target.closest('[data-copy]') && (await copyText(auth.token))) toast('コピーしました', { type: 'success' });
  });
}

async function logout(expired = false) {
  await leaveCall();
  stream?.stop();
  stream = null;
  hasConnectedOnce = false;
  auth.clear();
  resetSessionCaches();
  state.me = null;
  state.notifications = [];
  closeModal();
  if (expired) toast('ログインの有効期限が切れました。もう一度ログインしてください', { type: 'error' });
  showLogin();
}

// --- 画面切り替え ----------------------------------------------------------------

function onRoute() {
  const view = location.hash.slice(1);
  state.view = VIEWS.includes(view) ? view : 'calendar';
  VIEWS.forEach((name) => {
    $(`#view-${name}`).hidden = name !== state.view;
  });
  document.querySelectorAll('[data-view]').forEach((link) => {
    const current = link.dataset.view === state.view;
    link.classList.toggle('active', current);
    if (current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.body.dataset.view = state.view;
  closeModal();
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  if (!state.me) return;
  if (state.view === 'calendar') renderCalendar();
  if (state.view === 'schedule') renderSchedule();
  if (state.view === 'chat') renderChat();
  if (state.view === 'groups') renderGroups();
  const unread = groupList().reduce((sum, g) => sum + unreadCount(g.id), 0);
  document.querySelectorAll('.chat-badge').forEach((badge) => {
    badge.hidden = !unread;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  });
  document.querySelectorAll('.group-count').forEach((badge) => {
    badge.textContent = String(state.groups.size);
    badge.hidden = !state.groups.size;
  });
  document.title = unread ? `(${unread}) Afterclass | 放課後の予定帳` : 'Afterclass | 放課後の予定帳';
}

function init() {
  initLogin();
  initCalendar();
  initSchedule();
  initChat();
  initGroups();
  initCall();
  initNotifications();
  initProfile();
  subscribe(render);
  window.addEventListener('hashchange', onRoute);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isModalOpen()) closeModal();
  });
  $('#modal').addEventListener('click', (e) => {
    if (e.target === $('#modal') || e.target.closest('.modal-close')) closeModal();
  });
  setInterval(() => {
    tickCall();
    tickChatTimers();
  }, 1000);
  setInterval(checkReminders, 30000);
  setTimeout(checkReminders, 3000);
  // 日付が変わったら「今日」を更新
  let lastDay = todayKey();
  setInterval(() => {
    if (todayKey() !== lastDay) {
      lastDay = todayKey();
      notify();
    }
  }, 60000);
  start();
}

init();
