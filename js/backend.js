// Firebase（Authentication + Cloud Firestore）とのやり取り
// 自前のサーバーは使わず、データの保存・リアルタイム配信・通話のシグナリングを Firestore で行う
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInAnonymously, signInWithPopup, linkWithPopup,
  GoogleAuthProvider, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, connectFirestoreEmulator, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  collection, doc, onSnapshot, query, where, orderBy, limitToLast, serverTimestamp, writeBatch, getDoc, getDocs,
  setDoc, updateDoc, deleteDoc, addDoc, arrayUnion, deleteField,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { state, notify } from './state.js';

export const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
const useEmulator = firebaseConfig.projectId?.startsWith('demo-');

let app = null;
let auth = null;
let db = null;

if (isConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    db = initializeFirestore(app, { localCache: memoryLocalCache() });
  }
  if (useEmulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
}

export const clientId =
  globalThis.crypto?.randomUUID?.() ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const USER_COLORS = ['#81b9a4', '#ed806d', '#e2b33c', '#6fa8c0', '#a58bc7', '#d58aa6', '#7d9c6b', '#c98c5a'];
const GROUP_COLORS = ['#ed806d', '#6fa8c0', '#81b9a4', '#e2b33c', '#a58bc7', '#d58aa6'];
const CATEGORIES = new Set(['study', 'play', 'club', 'food', 'other']);
const REPEATS = new Set(['none', 'daily', 'weekly', 'monthly']);
const REMINDERS = new Set([0, 5, 10, 30, 60, 1440]);
const MESSAGE_LIMIT = 200;
const HEARTBEAT_MS = 10000;
const STALE_MS = 35000;

const pick = (list, seed) => list[[...seed].reduce((sum, c) => sum + c.charCodeAt(0), 0) % list.length];
const toMs = (value) => (typeof value?.toMillis === 'function' ? value.toMillis() : typeof value === 'number' ? value : Date.now());
const me = () => auth?.currentUser?.uid;

// --- エラーを日本語に ------------------------------------------------------------

const MESSAGES = {
  'permission-denied': '権限がありません（グループから外れた可能性があります）',
  unavailable: '通信できません。インターネット接続を確認してください',
  'not-found': '見つかりませんでした',
  'auth/popup-closed-by-user': 'ログインがキャンセルされました',
  'auth/cancelled-popup-request': 'ログインがキャンセルされました',
  'auth/popup-blocked': 'ポップアップがブロックされました。ブラウザの設定で許可してください',
  'auth/operation-not-allowed': 'このログイン方法が Firebase で有効になっていません（README 参照）',
  'auth/unauthorized-domain': 'このドメインは Firebase の「承認済みドメイン」に登録されていません（README 参照）',
  'auth/credential-already-in-use': 'この Google アカウントは、すでに別のアカウントで使われています',
  'auth/network-request-failed': '通信できません。インターネット接続を確認してください',
};

export class BackendError extends Error {}

function translate(error) {
  if (error instanceof BackendError) return error;
  const message = MESSAGES[error?.code] ?? `エラーが発生しました（${error?.code ?? error?.message ?? error}）`;
  const translated = new BackendError(message);
  translated.code = error?.code;
  return translated;
}

async function run(task) {
  try {
    return await task();
  } catch (error) {
    throw translate(error);
  }
}

function clean(value, field, max, required = false) {
  const text = String(value ?? '').trim();
  if (required && !text) throw new BackendError(`${field}を入力してください`);
  if (text.length > max) throw new BackendError(`${field}は${max}文字以内で入力してください`);
  return text;
}

// --- ログイン ---------------------------------------------------------------------

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export const currentAuthUser = () => auth?.currentUser ?? null;

export function startAsGuest(name) {
  const nickname = clean(name, 'ニックネーム', 20, true);
  return run(async () => {
    const { user } = await signInAnonymously(auth);
    await setDoc(doc(db, 'users', user.uid), { name: nickname, color: pick(USER_COLORS, user.uid), busy: [], createdAt: serverTimestamp() });
  });
}

export function signInWithGoogle() {
  return run(async () => {
    const { user } = await signInWithPopup(auth, new GoogleAuthProvider());
    const profile = await getDoc(doc(db, 'users', user.uid));
    if (!profile.exists()) {
      await setDoc(doc(db, 'users', user.uid), {
        name: (user.displayName || 'ユーザー').slice(0, 20),
        color: pick(USER_COLORS, user.uid),
        busy: [],
        createdAt: serverTimestamp(),
      });
    }
  });
}

/** ゲストのアカウントを Google アカウントにひも付けて、ほかの端末でも使えるようにする */
export function linkGoogle() {
  return run(() => linkWithPopup(auth.currentUser, new GoogleAuthProvider()));
}

export function logout() {
  stopSync();
  return run(() => signOut(auth));
}

export function updateMyName(name) {
  const nickname = clean(name, 'ニックネーム', 20, true);
  return run(() => updateDoc(doc(db, 'users', me()), { name: nickname }));
}

// --- リアルタイム同期 -------------------------------------------------------------

let hooks = {};
let rootUnsubs = [];
const groupUnsubs = new Map(); // groupId -> unsubscribe[]
const userUnsubs = new Map(); // userId -> unsubscribe
const eventSource = new Map(); // eventId -> どのクエリから来たか
const rawCalls = new Map(); // groupId -> participant[]
let serverOffset = 0;
let callTimer = null;
let busyTimer = null;
let lastBusy = '';

/**
 * ログイン中のユーザーのデータを購読して state に反映する
 * hooks: onMe, onNewEvent, onMessage, onCallState, onSignal, onGroupRemoved, onError
 */
export function startSync(uid, handlers) {
  stopSync();
  hooks = handlers;
  watchUser(uid);

  const personal = query(collection(db, 'events'), where('ownerId', '==', uid), where('groupId', '==', null));
  rootUnsubs.push(onSnapshot(personal, (snap) => applyEvents(snap, 'personal'), fail));

  let firstGroups = true;
  const groups = query(collection(db, 'groups'), where('members', 'array-contains', uid));
  rootUnsubs.push(
    onSnapshot(
      groups,
      (snap) => {
        for (const change of snap.docChanges()) {
          const id = change.doc.id;
          if (change.type === 'removed') {
            stopGroup(id);
            hooks.onGroupRemoved?.(id);
            continue;
          }
          const data = change.doc.data({ serverTimestamps: 'estimate' });
          state.groups.set(id, { id, ...data, createdAt: toMs(data.createdAt) });
          data.members.forEach(watchUser);
          if (!groupUnsubs.has(id)) watchGroup(id);
        }
        state.groupsLoaded = true;
        if (firstGroups) {
          firstGroups = false;
          hooks.onReady?.();
        }
        scheduleBusy();
        notify();
      },
      fail,
    ),
  );

  const signals = query(collection(db, 'signals'), where('toUser', '==', uid), where('to', '==', clientId));
  rootUnsubs.push(
    onSnapshot(
      signals,
      (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type !== 'added') continue;
          const data = change.doc.data({ serverTimestamps: 'estimate' });
          deleteDoc(change.doc.ref).catch(() => {});
          if (Date.now() - toMs(data.createdAt) > 60000) continue; // 古い信号は捨てる
          hooks.onSignal?.({ from: data.from, fromUser: data.fromUser, groupId: data.groupId, data: data.data });
        }
      },
      fail,
    ),
  );

  callTimer = setInterval(() => rawCalls.forEach((_, gid) => publishCall(gid)), HEARTBEAT_MS);
}

export function stopSync() {
  rootUnsubs.forEach((unsub) => unsub());
  rootUnsubs = [];
  [...groupUnsubs.keys()].forEach(stopGroup);
  userUnsubs.forEach((unsub) => unsub());
  userUnsubs.clear();
  eventSource.clear();
  rawCalls.clear();
  clearInterval(callTimer);
  clearTimeout(busyTimer);
  stopHeartbeat();
  lastBusy = '';
}

function fail(error) {
  console.error(error);
  hooks.onError?.(translate(error));
}

function watchUser(uid) {
  if (userUnsubs.has(uid)) return;
  const unsub = onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      if (!snap.exists()) {
        if (uid === me()) {
          // プロフィールが作られる前に落ちた場合の保険
          setDoc(doc(db, 'users', uid), { name: 'ゲスト', color: pick(USER_COLORS, uid), busy: [], createdAt: serverTimestamp() }).catch(fail);
        }
        return;
      }
      const data = snap.data();
      const user = { id: uid, name: data.name, color: data.color };
      state.users.set(uid, user);
      if (uid === me()) {
        state.me = user;
        lastBusy = JSON.stringify(data.busy ?? []);
        hooks.onMe?.(user);
      }
      notify();
    },
    (error) => {
      if (uid === me()) fail(error);
    },
  );
  userUnsubs.set(uid, unsub);
}

function watchGroup(gid) {
  const unsubs = [];
  const events = query(collection(db, 'events'), where('groupId', '==', gid));
  unsubs.push(onSnapshot(events, (snap) => applyEvents(snap, gid), fail));

  let firstMessages = true;
  const messages = query(collection(db, 'groups', gid, 'messages'), orderBy('createdAt'), limitToLast(MESSAGE_LIMIT));
  unsubs.push(
    onSnapshot(
      messages,
      (snap) => {
        const list = snap.docs.map((d) => toMessage(gid, d));
        state.messages.set(gid, list);
        if (!firstMessages) {
          for (const change of snap.docChanges()) {
            if (change.type === 'added' && !change.doc.metadata.hasPendingWrites) hooks.onMessage?.(toMessage(gid, change.doc));
          }
        }
        firstMessages = false;
        notify();
      },
      fail,
    ),
  );

  unsubs.push(
    onSnapshot(
      collection(db, 'groups', gid, 'call'),
      (snap) => {
        rawCalls.set(
          gid,
          snap.docs.map((d) => {
            const data = d.data({ serverTimestamps: 'estimate' });
            if (d.id === clientId && !d.metadata.hasPendingWrites && data.heartbeat) serverOffset = toMs(data.heartbeat) - Date.now();
            return { clientId: d.id, userId: data.userId, kind: data.kind, joinedAt: data.joinedAt, heartbeat: toMs(data.heartbeat) };
          }),
        );
        publishCall(gid);
      },
      fail,
    ),
  );
  groupUnsubs.set(gid, unsubs);
}

function stopGroup(gid) {
  groupUnsubs.get(gid)?.forEach((unsub) => unsub());
  groupUnsubs.delete(gid);
  rawCalls.delete(gid);
}

function toMessage(gid, snap) {
  const data = snap.data({ serverTimestamps: 'estimate' });
  return {
    id: snap.id,
    groupId: gid,
    userId: data.userId,
    kind: data.kind,
    text: data.text ?? '',
    eventId: data.eventId ?? null,
    deleted: Boolean(data.deleted),
    createdAt: toMs(data.createdAt),
  };
}

function applyEvents(snap, source) {
  let changed = false;
  for (const change of snap.docChanges()) {
    const id = change.doc.id;
    if (change.type === 'removed') {
      // 共有先を変えた予定は、別のクエリで追加されてから消えることがあるので出どころを確認する
      if (eventSource.get(id) === source) {
        state.events.delete(id);
        eventSource.delete(id);
        changed = true;
      }
      continue;
    }
    const data = change.doc.data({ serverTimestamps: 'estimate' });
    const event = { id, ...data, rsvp: data.rsvp ?? {}, createdAt: toMs(data.createdAt), updatedAt: toMs(data.updatedAt) };
    const isNew = !state.events.has(id);
    state.events.set(id, event);
    eventSource.set(id, source);
    if (isNew && change.type === 'added' && !snap.metadata.fromCache && event.ownerId !== me() && state.eventsReady?.has(source)) {
      hooks.onNewEvent?.(event);
    }
    changed = true;
  }
  state.eventsReady ??= new Set();
  state.eventsReady.add(source);
  if (changed) {
    hooks.onEventsChanged?.();
    scheduleBusy();
    notify();
  }
}

/** 空き時間チェック用に、自分が予定のある時間帯（タイトルなし）をプロフィールに書く */
function scheduleBusy() {
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => {
    const uid = me();
    if (!uid) return;
    const busy = [...state.events.values()]
      .filter((e) => (!e.groupId ? e.ownerId === uid : e.ownerId === uid || e.rsvp?.[uid] === 'yes'))
      .map((e) => ({ eventId: e.id, date: e.date, start: e.start, end: e.end, allDay: e.allDay, repeat: e.repeat, repeatUntil: e.repeatUntil }))
      .sort((a, b) => a.eventId.localeCompare(b.eventId));
    const serialized = JSON.stringify(busy);
    if (serialized === lastBusy) return;
    lastBusy = serialized;
    updateDoc(doc(db, 'users', uid), { busy }).catch(() => {});
  }, 1500);
}

// --- グループ ---------------------------------------------------------------------

function newInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function postSystem(gid, text, kind = 'system') {
  return addDoc(collection(db, 'groups', gid, 'messages'), {
    userId: me(), kind, text, eventId: null, deleted: false, createdAt: serverTimestamp(),
  });
}

export function createGroup(name) {
  const groupName = clean(name, 'グループ名', 30, true);
  return run(async () => {
    const ref = doc(collection(db, 'groups'));
    const code = newInviteCode();
    const group = { name: groupName, color: pick(GROUP_COLORS, ref.id), ownerId: me(), members: [me()], inviteCode: code, createdAt: serverTimestamp() };
    const batch = writeBatch(db);
    batch.set(ref, group);
    batch.set(doc(db, 'invites', code), { groupId: ref.id, groupName });
    await batch.commit();
    await postSystem(ref.id, `${state.me.name}さんがグループ「${groupName}」を作成しました`);
    const created = { id: ref.id, ...group, createdAt: Date.now() };
    state.groups.set(ref.id, created);
    return created;
  });
}

const normalizeCode = (code) => String(code ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export function invitePreview(code) {
  const clean = normalizeCode(code);
  return run(async () => {
    if (clean.length < 4) throw new BackendError('招待コードを正しく入力してください');
    const snap = await getDoc(doc(db, 'invites', clean));
    if (!snap.exists()) throw new BackendError('招待コードが見つかりません。作り直された可能性があります');
    return { id: snap.data().groupId, name: snap.data().groupName };
  });
}

export function joinGroup(code) {
  const clean = normalizeCode(code);
  return run(async () => {
    const group = await invitePreview(clean);
    if (state.groups.has(group.id)) return { group, joined: false };
    const batch = writeBatch(db);
    batch.set(doc(db, 'groups', group.id, 'joins', me()), { code: clean, at: serverTimestamp() });
    batch.update(doc(db, 'groups', group.id), { members: arrayUnion(me()) });
    await batch.commit();
    await postSystem(group.id, `${state.me.name}さんが参加しました`);
    return { group, joined: true };
  });
}

export function renameGroup(gid, name) {
  const groupName = clean(name, 'グループ名', 30, true);
  return run(async () => {
    const group = state.groups.get(gid);
    const batch = writeBatch(db);
    batch.update(doc(db, 'groups', gid), { name: groupName });
    batch.set(doc(db, 'invites', group.inviteCode), { groupId: gid, groupName });
    await batch.commit();
  });
}

export function regenerateInvite(gid) {
  return run(async () => {
    const group = state.groups.get(gid);
    const code = newInviteCode();
    const batch = writeBatch(db);
    batch.delete(doc(db, 'invites', group.inviteCode));
    batch.set(doc(db, 'invites', code), { groupId: gid, groupName: group.name });
    batch.update(doc(db, 'groups', gid), { inviteCode: code });
    await batch.commit();
    state.groups.set(gid, { ...group, inviteCode: code });
    return state.groups.get(gid);
  });
}

export function leaveGroup(gid) {
  return run(async () => {
    const group = state.groups.get(gid);
    const others = group.members.filter((id) => id !== me());
    await callLeaveIfIn(gid);
    if (!others.length) {
      // 最後の1人: グループの予定・招待コードもまとめて消す
      const events = await getDocs(query(collection(db, 'events'), where('groupId', '==', gid)));
      const batch = writeBatch(db);
      events.docs.forEach((d) => batch.delete(d.ref));
      batch.delete(doc(db, 'invites', group.inviteCode));
      batch.delete(doc(db, 'groups', gid));
      await batch.commit();
    } else {
      await postSystem(gid, `${state.me.name}さんが退出しました`);
      await updateDoc(doc(db, 'groups', gid), { members: others, ownerId: group.ownerId === me() ? others[0] : group.ownerId });
    }
  });
}

/** 空き時間チェック: メンバーごとの予定のある時間帯 */
export function groupBusy(gid) {
  return run(async () => {
    const group = state.groups.get(gid);
    const members = await Promise.all(
      group.members.map(async (userId) => {
        const snap = await getDoc(doc(db, 'users', userId));
        const busy = (snap.data()?.busy ?? []).map((block) => {
          const visible = state.events.get(block.eventId);
          return visible ? { ...block, id: visible.id, title: visible.title } : { ...block, id: undefined };
        });
        return { userId, busy };
      }),
    );
    return { members };
  });
}

// --- 予定 -------------------------------------------------------------------------

function eventFields(draft) {
  const title = clean(draft.title, 'タイトル', 60, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date ?? '')) throw new BackendError('日付を入力してください');
  const allDay = Boolean(draft.allDay);
  const start = allDay ? '' : draft.start ?? '';
  const end = allDay ? '' : draft.end ?? '';
  if (!allDay && !/^\d{2}:\d{2}$/.test(start)) throw new BackendError('開始時刻を入力するか「終日」を選んでください');
  if (end && end <= start) throw new BackendError('終了時刻は開始時刻より後にしてください');
  const repeat = REPEATS.has(draft.repeat) ? draft.repeat : 'none';
  const repeatUntil = repeat === 'none' ? '' : draft.repeatUntil ?? '';
  if (repeatUntil && repeatUntil < draft.date) throw new BackendError('繰り返しの終了日は開始日より後にしてください');
  const groupId = draft.groupId || null;
  if (groupId && !state.groups.has(groupId)) throw new BackendError('グループが見つかりません');
  return {
    title,
    date: draft.date,
    allDay,
    start,
    end,
    category: CATEGORIES.has(draft.category) ? draft.category : 'other',
    location: clean(draft.location, '場所', 80),
    memo: clean(draft.memo, 'メモ', 500),
    groupId,
    repeat,
    repeatUntil,
    reminder: REMINDERS.has(Number(draft.reminder)) ? Number(draft.reminder) : 0,
  };
}

export function createEvent(draft) {
  const fields = eventFields(draft);
  return run(async () => {
    const ref = doc(collection(db, 'events'));
    const event = { ...fields, ownerId: me(), rsvp: { [me()]: 'yes' }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    await setDoc(ref, event);
    if (fields.groupId) {
      await addDoc(collection(db, 'groups', fields.groupId, 'messages'), {
        userId: me(), kind: 'event', text: `予定「${fields.title}」を追加しました`, eventId: ref.id, deleted: false, createdAt: serverTimestamp(),
      });
    }
    return { id: ref.id, ...event, createdAt: Date.now(), updatedAt: Date.now() };
  });
}

export function updateEvent(event, draft) {
  const fields = eventFields(draft);
  if (fields.groupId !== (event.groupId ?? null) && event.ownerId !== me()) {
    return Promise.reject(new BackendError('共有先を変更できるのは作成した人だけです'));
  }
  return run(async () => {
    await updateDoc(doc(db, 'events', event.id), { ...fields, updatedAt: serverTimestamp() });
    return { ...event, ...fields };
  });
}

export function deleteEvent(event) {
  const group = event.groupId ? state.groups.get(event.groupId) : null;
  if (event.ownerId !== me() && group?.ownerId !== me()) {
    return Promise.reject(new BackendError('予定を削除できるのは作成した人（またはグループ管理者）だけです'));
  }
  return run(async () => {
    await deleteDoc(doc(db, 'events', event.id));
    if (group) await postSystem(group.id, `${state.me.name}さんが予定「${event.title}」を削除しました`);
  });
}

export function setRsvp(eventId, status) {
  return run(() => updateDoc(doc(db, 'events', eventId), { [`rsvp.${me()}`]: ['yes', 'maybe', 'no'].includes(status) ? status : deleteField() }));
}

// --- チャット ---------------------------------------------------------------------

export function sendMessage(gid, { text = '', eventId = null }) {
  const body = clean(text, 'メッセージ', 1000);
  if (!body && !eventId) return Promise.reject(new BackendError('メッセージを入力してください'));
  if (eventId && state.events.get(eventId)?.groupId !== gid) return Promise.reject(new BackendError('このグループの予定だけ共有できます'));
  return run(() =>
    addDoc(collection(db, 'groups', gid, 'messages'), {
      userId: me(), kind: eventId ? 'event' : 'text', text: body, eventId, deleted: false, createdAt: serverTimestamp(),
    }),
  );
}

export function deleteMessage(gid, messageId) {
  return run(() => updateDoc(doc(db, 'groups', gid, 'messages', messageId), { deleted: true, text: '', eventId: null }));
}

// --- 通話（参加者の管理とシグナリング） -----------------------------------------------

let heartbeat = null;
let callSession = null; // { groupId, joinedAt, startedAt }

const serverNow = () => Date.now() + serverOffset;

function freshParticipants(gid) {
  return (rawCalls.get(gid) ?? []).filter((p) => p.clientId === clientId || serverNow() - p.heartbeat < STALE_MS);
}

function publishCall(gid) {
  const participants = freshParticipants(gid)
    .map(({ clientId: id, userId, kind, joinedAt }) => ({ clientId: id, userId, kind, joinedAt }))
    .sort((a, b) => a.joinedAt - b.joinedAt || a.clientId.localeCompare(b.clientId));
  const previous = state.calls.get(gid);
  const key = participants.map((p) => p.clientId).join(',');
  // 長く止まっている参加者のデータは片付ける
  for (const p of rawCalls.get(gid) ?? []) {
    if (p.clientId !== clientId && serverNow() - p.heartbeat > STALE_MS * 4) deleteDoc(doc(db, 'groups', gid, 'call', p.clientId)).catch(() => {});
  }
  if (previous?.key === key) return;
  const next = { groupId: gid, participants, startedAt: participants[0]?.joinedAt ?? null, key };
  state.calls.set(gid, next);
  hooks.onCallState?.(next, previous?.participants.length ?? 0);
  notify();
}

function stopHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = null;
}

export function callJoin(gid, kind) {
  return run(async () => {
    const joinedAt = Date.now();
    const others = freshParticipants(gid).filter((p) => p.clientId !== clientId);
    const ref = doc(db, 'groups', gid, 'call', clientId);
    await setDoc(ref, { userId: me(), kind, joinedAt, heartbeat: serverTimestamp() });
    stopHeartbeat();
    heartbeat = setInterval(() => updateDoc(ref, { heartbeat: serverTimestamp() }).catch(() => {}), HEARTBEAT_MS);
    const startedAt = Math.min(joinedAt, ...others.map((p) => p.joinedAt));
    callSession = { groupId: gid, joinedAt, startedAt };
    if (!others.length) await postSystem(gid, kind === 'video' ? 'ビデオ通話を開始しました' : '音声通話を開始しました', 'call');
    return { joinedAt, startedAt };
  });
}

export function callLeave(gid) {
  return run(async () => {
    stopHeartbeat();
    const session = callSession;
    callSession = null;
    await deleteDoc(doc(db, 'groups', gid, 'call', clientId));
    const others = freshParticipants(gid).filter((p) => p.clientId !== clientId);
    if (!others.length && session) {
      const minutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
      await postSystem(gid, `通話が終了しました（${minutes}分）`);
    }
  });
}

async function callLeaveIfIn(gid) {
  if (callSession?.groupId === gid) await callLeave(gid).catch(() => {});
}

/** ページを閉じるときの退出（完了は保証されないので、残った分は心拍の途切れで判定する） */
export function callLeaveOnUnload() {
  if (!callSession) return;
  stopHeartbeat();
  deleteDoc(doc(db, 'groups', callSession.groupId, 'call', clientId)).catch(() => {});
}

export function sendSignal(gid, to, toUser, data) {
  return addDoc(collection(db, 'signals'), {
    to, toUser, from: clientId, fromUser: me(), groupId: gid, data: JSON.parse(JSON.stringify(data)), createdAt: serverTimestamp(),
  }).catch(() => {});
}
