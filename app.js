// Afterclass — エントリーポイント
import * as backend from './js/backend.js';
import { state, subscribe, notify, userName, unreadCount, groupList, resetState } from './js/state.js';
import { $, esc, storage, todayKey, addDays, expandEvents, toMinutes, formatClock, formatDateJa, formatTimeRange } from './js/utils.js';
import { icons, avatar, toast, toastError, openModal, closeModal, isModalOpen, confirmDialog, withBusy } from './js/ui.js';
import { initCalendar, renderCalendar } from './js/calendar.js';
import { initSchedule, renderSchedule } from './js/schedule.js';
import { initChat, renderChat, tickChatTimers } from './js/chat.js';
import { initGroups, renderGroups, handleInviteParam, removeGroupLocally } from './js/groups.js';
import { initCall, handleSignal, handleCallState, currentCall, startCall, tickCall, leaveCall } from './js/call.js';
import { openEventDetail, refreshEventDetail } from './js/events.js';

const VIEWS = ['calendar', 'schedule', 'chat', 'groups'];
const params = new URLSearchParams(location.search);
let pendingInvite = params.get('join');
let pendingEvent = params.get('event');
let signedInUid = null;

// --- ログイン -------------------------------------------------------------------

function showScreen(name) {
  $('#setup').hidden = name !== 'setup';
  $('#login').hidden = name !== 'login';
  $('#loading').hidden = name !== 'loading';
  $('#appShell').hidden = name !== 'app';
}

function showLogin() {
  showScreen('login');
  const note = $('#loginInvite');
  note.hidden = !pendingInvite;
  note.innerHTML = `${icons.users}<span>グループに招待されています。<br>ログインすると参加できます。</span>`;
  $('#loginName').focus();
}

function initLogin() {
  const error = $('#loginError');
  const fail = (err) => {
    error.textContent = err.message;
    error.hidden = false;
  };
  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    error.hidden = true;
    withBusy($('#loginForm button[type="submit"]'), () => backend.startAsGuest($('#loginName').value).catch(fail));
  });
  $('#googleLogin').addEventListener('click', (e) => {
    error.hidden = true;
    withBusy(e.currentTarget, () => backend.signInWithGoogle().catch(fail));
  });
}

// --- 起動 -----------------------------------------------------------------------

function onAuthChanged(user) {
  if (!user) {
    signedInUid = null;
    backend.stopSync();
    resetState();
    showLogin();
    return;
  }
  if (signedInUid === user.uid) return;
  signedInUid = user.uid;
  showScreen('loading');
  backend.startSync(user.uid, {
    onReady: onSyncReady,
    onMe: () => {
      renderProfile();
      if (!$('#loading').hidden && state.groupsLoaded) onSyncReady();
    },
    onNewEvent,
    onMessage,
    onCallState,
    onSignal: handleSignal,
    onGroupRemoved: (groupId) => removeGroupLocally(groupId),
    onEventsChanged: refreshEventDetail,
    onError: (err) => toast(err.message, { type: 'error', duration: 6000 }),
  });
}

let appShown = false;
function onSyncReady() {
  if (!state.me) return; // プロフィールが届くのを待つ
  if (appShown && !$('#appShell').hidden) return;
  appShown = true;
  showScreen('app');
  renderProfile();
  onRoute();
  if (pendingInvite || pendingEvent) history.replaceState(null, '', location.pathname + location.hash);
  if (pendingInvite) handleInviteParam(pendingInvite);
  if (pendingEvent) setTimeout(() => openEventDetail(pendingEvent), 800);
  pendingInvite = null;
  pendingEvent = null;
}

// --- リアルタイムの通知 ----------------------------------------------------------

function onNewEvent(event) {
  if (!event.groupId) return;
  const group = state.groups.get(event.groupId);
  pushNotification({
    text: `${userName(event.ownerId)}さんが「${group?.name}」に予定「${event.title}」を追加しました`,
    action: { type: 'event', id: event.id },
  });
}

function onMessage(message) {
  const viewing = state.view === 'chat' && state.activeChat === message.groupId && !document.hidden;
  if (message.userId === state.me?.id || message.kind === 'system' || message.kind === 'call' || viewing) return;
  const group = state.groups.get(message.groupId);
  const text = message.kind === 'event' ? '📅 予定を共有しました' : message.text;
  pushNotification({ text: `${group?.name} · ${userName(message.userId)}: ${text}`, action: { type: 'chat', id: message.groupId } });
  browserNotify(`${userName(message.userId)}（${group?.name}）`, text, message.groupId);
}

function onCallState(callState, before) {
  handleCallState(callState);
  const starter = callState.participants[0];
  if (before || !starter || starter.userId === state.me?.id || currentCall()?.groupId === callState.groupId) return;
  const group = state.groups.get(callState.groupId);
  const label = starter.kind === 'video' ? 'ビデオ通話' : '音声通話';
  toast(`${userName(starter.userId)}さんが「${group?.name}」で${label}を始めました`, {
    duration: 15000,
    actions: [{ label: '参加する', onClick: () => startCall(callState.groupId, starter.kind) }],
  });
  pushNotification({ text: `「${group?.name}」で${label}が始まりました`, action: { type: 'chat', id: callState.groupId } });
  browserNotify(`「${group?.name}」で${label}中`, `${userName(starter.userId)}さんが通話を始めました`, callState.groupId);
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
  if (!state.me) return;
  $('#profileButton').innerHTML = `${avatar(state.me.id)}<span class="profile-name">${esc(state.me.name)}</span><span class="chevron">⌄</span>`;
  const user = backend.currentAuthUser();
  const linked = user && !user.isAnonymous;
  $('#linkGoogle').textContent = linked ? `Google で連携済み（${user.email ?? ''}）` : 'Google と連携（ほかの端末でも使う）';
  $('#linkGoogle').disabled = Boolean(linked);
}

function initProfile() {
  $('#profileButton').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#notifPanel').hidden = true;
    const menu = $('#profileMenu');
    renderProfile();
    menu.hidden = !menu.hidden;
    $('#profileButton').setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('#profileMenu').addEventListener('click', async (e) => {
    e.stopPropagation();
    const action = e.target.closest('[data-profile]')?.dataset.profile;
    if (!action) return;
    $('#profileMenu').hidden = true;
    if (action === 'rename') openRename();
    if (action === 'link') {
      try {
        await backend.linkGoogle();
        renderProfile();
        toast('Google アカウントと連携しました。ほかの端末でも「Google でログイン」で使えます', { type: 'success', duration: 6000 });
      } catch (error) {
        toastError(error);
      }
    }
    if (action === 'notify') {
      if (!('Notification' in window)) return toast('このブラウザは通知に対応していません', { type: 'error' });
      const result = await Notification.requestPermission();
      toast(result === 'granted' ? '通知をオンにしました' : '通知は許可されませんでした（ブラウザの設定から変更できます）', { type: result === 'granted' ? 'success' : 'error' });
      renderNotifications();
    }
    if (action === 'logout') {
      const guest = backend.currentAuthUser()?.isAnonymous;
      const ok = await confirmDialog({
        title: 'ログアウトしますか？',
        message: guest
          ? 'ゲストのままログアウトすると、このアカウントには二度と戻れません。続けて使うなら、先に「Google と連携」してください。'
          : 'もう一度「Google でログイン」すれば元に戻れます。',
        confirmLabel: 'ログアウト',
        danger: true,
      });
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
        await backend.updateMyName(e.target.name.value);
        closeModal();
        toast('ニックネームを変更しました', { type: 'success' });
      } catch (error) {
        toastError(error);
      }
    });
  });
}

async function logout() {
  await leaveCall();
  closeModal();
  appShown = false;
  try {
    await backend.logout();
  } catch (error) {
    toastError(error);
  }
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
  window.addEventListener('offline', () => ($('#connectionBanner').hidden = false));
  window.addEventListener('online', () => ($('#connectionBanner').hidden = true));
  $('#connectionBanner').hidden = navigator.onLine;
  if (!backend.isConfigured) {
    showScreen('setup');
    return;
  }
  backend.watchAuth(onAuthChanged);
}

init();
