import { storage, todayKey } from './utils.js';

export const state = {
  me: null,
  users: new Map(),
  groups: new Map(),
  events: new Map(),
  messages: new Map(), // groupId -> message[]
  calls: new Map(), // groupId -> { participants, startedAt }
  connected: true,
  groupsLoaded: false,
  eventsReady: new Set(),

  view: 'calendar',
  calendarMode: storage.get('afterclass.calendarMode', 'month'),
  cursor: todayKey(), // 表示中の月・週の基準日
  selectedDate: todayKey(),
  sourceFilter: 'all', // 'all' | 'personal' | groupId
  activeChat: null,
  notifications: [],
};

const listeners = new Set();
let scheduled = false;

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 状態変更を通知（同じフレーム内の変更はまとめて1回だけ描画） */
export function notify() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    listeners.forEach((listener) => listener());
  });
}

/** ログアウト時などにデータを空にする */
export function resetState() {
  state.me = null;
  state.users = new Map();
  state.groups = new Map();
  state.events = new Map();
  state.messages = new Map();
  state.calls = new Map();
  state.notifications = [];
  state.activeChat = null;
  state.sourceFilter = 'all';
  state.groupsLoaded = false;
  state.eventsReady = new Set();
  lastRead = null;
}

export const userName = (id) => (id === state.me?.id ? state.me.name : state.users.get(id)?.name ?? '退出したメンバー');
export const userColor = (id) => state.users.get(id)?.color ?? '#b7bdb9';
export const groupList = () => [...state.groups.values()].sort((a, b) => a.createdAt - b.createdAt);

export function visibleEvents(filter = state.sourceFilter) {
  const events = [...state.events.values()];
  if (filter === 'all') return events;
  if (filter === 'personal') return events.filter((e) => !e.groupId);
  return events.filter((e) => e.groupId === filter);
}

/** 自分が関わる予定（自分の個人予定 + 不参加にしていないグループ予定） */
export function myEvents() {
  return [...state.events.values()].filter((e) => !e.groupId || e.rsvp?.[state.me.id] !== 'no');
}

// --- 既読管理（端末ごとに保存） ---

const readKey = () => `afterclass.read.${state.me?.id}`;
let lastRead = null;

export function getLastRead(groupId) {
  lastRead ??= storage.get(readKey(), {});
  return lastRead[groupId] ?? 0;
}

export function markRead(groupId) {
  const messages = state.messages.get(groupId) ?? [];
  const latest = messages.at(-1)?.createdAt ?? 0;
  if (getLastRead(groupId) >= latest) return false;
  lastRead[groupId] = latest;
  storage.set(readKey(), lastRead);
  return true;
}

export function unreadCount(groupId) {
  const since = getLastRead(groupId);
  return (state.messages.get(groupId) ?? []).filter(
    (m) => m.createdAt > since && m.kind !== 'system' && m.userId !== state.me.id && !m.deleted,
  ).length;
}

