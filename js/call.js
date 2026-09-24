// グループ通話（WebRTC メッシュ接続。シグナリングは Firestore 経由）
import * as backend from './backend.js';
import { clientId } from './backend.js';
import { iceServers as configuredIceServers } from './firebase-config.js';
import { state, notify, userName, userColor } from './state.js';
import { $, esc, formatDuration } from './utils.js';
import { icons, toast, toastError, confirmDialog } from './ui.js';

const iceServers = configuredIceServers ?? [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
let active = null;
const tiles = new Map(); // 'local' | clientId -> element

const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO_CONSTRAINTS = { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' };

export const currentCall = () => active;

export function initCall() {
  const overlay = $('#callOverlay');
  overlay.addEventListener('click', (e) => {
    const action = e.target.closest('[data-call]')?.dataset.call;
    if (action === 'mic') toggleMic();
    else if (action === 'cam') toggleCam();
    else if (action === 'screen') toggleScreen();
    else if (action === 'leave') leaveCall();
    else if (action === 'minimize') minimize(true);
    else if (action === 'play') {
      const video = e.target.closest('.call-tile')?.querySelector('video');
      video?.play().then(() => e.target.closest('[data-call]').remove()).catch(() => {});
    }
  });
  $('#callPill').addEventListener('click', () => minimize(false));
  window.addEventListener('pagehide', () => {
    if (active?.joined) backend.callLeaveOnUnload();
  });
}

export function showCall() {
  minimize(false);
}

function minimize(value) {
  if (!active) return;
  active.minimized = value;
  renderShell();
}

// --- 参加・退出 -------------------------------------------------------------------

export async function startCall(groupId, kind = 'audio') {
  if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
    toast('このブラウザは通話に対応していません。最新の Chrome / Safari / Edge を使ってください', { type: 'error', duration: 6000 });
    return;
  }
  if (!window.isSecureContext) {
    toast('通話を使うには https:// または localhost で開く必要があります（README 参照）', { type: 'error', duration: 7000 });
    return;
  }
  if (active) {
    if (active.groupId === groupId) return showCall();
    const ok = await confirmDialog({ title: '今の通話を終了しますか？', message: '別のグループの通話に移動します。', confirmLabel: '移動する' });
    if (!ok) return undefined;
    await leaveCall();
  }
  const session = {
    groupId,
    kind,
    peers: new Map(),
    audioTrack: null,
    camTrack: null,
    screenTrack: null,
    micOn: true,
    camOn: false,
    screenOn: false,
    minimized: false,
    joined: false,
    startedAt: Date.now(),
  };
  active = session;
  renderShell();
  renderTiles();

  await acquireMedia(session, kind);
  if (active !== session) return stopMedia(session); // 準備中にキャンセルされた

  try {
    const { joinedAt, startedAt } = await backend.callJoin(groupId, kind);
    if (active !== session) {
      backend.callLeave(groupId).catch(() => {});
      return undefined;
    }
    session.joined = true;
    session.joinedAt = joinedAt;
    session.startedAt = startedAt;
    syncPeers(state.calls.get(groupId)?.participants ?? []);
    renderShell();
    renderTiles();
  } catch (error) {
    toastError(error);
    teardown(session);
  }
  return undefined;
}

async function acquireMedia(session, kind) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: kind === 'video' ? VIDEO_CONSTRAINTS : false });
    session.audioTrack = stream.getAudioTracks()[0] ?? null;
    session.camTrack = stream.getVideoTracks()[0] ?? null;
  } catch (error) {
    if (kind === 'video') {
      toast('カメラを使えなかったので、音声で参加します', { type: 'error' });
      return acquireMedia(session, 'audio');
    }
    toast(error?.name === 'NotAllowedError' ? 'マイクの使用が許可されていません。聞くだけで参加します' : 'マイクが見つかりません。聞くだけで参加します', { type: 'error', duration: 6000 });
  }
  session.camOn = Boolean(session.camTrack);
  session.micOn = Boolean(session.audioTrack);
  return undefined;
}

export async function leaveCall() {
  const session = active;
  if (!session) return;
  if (session.joined) backend.callLeave(session.groupId).catch(() => {});
  teardown(session);
}

function teardown(session) {
  stopMedia(session);
  for (const peer of session.peers.values()) peer.pc.close();
  session.peers.clear();
  if (active === session) active = null;
  tiles.forEach((tile) => tile.remove());
  tiles.clear();
  renderShell();
  notify();
}

function stopMedia(session) {
  [session.audioTrack, session.camTrack, session.screenTrack].forEach((track) => track?.stop());
}

// --- シグナリング -----------------------------------------------------------------

function sendSignal(to, data) {
  const peer = active?.peers.get(to);
  if (!peer) return;
  backend.sendSignal(active.groupId, to, peer.userId, data);
}

const currentVideoTrack = () => (active.screenOn ? active.screenTrack : active.camOn ? active.camTrack : null);
const mediaState = () => ({ mic: Boolean(active.audioTrack && active.micOn), cam: active.camOn, screen: active.screenOn });

function getPeer(remoteId, userId) {
  let peer = active.peers.get(remoteId);
  if (peer) return peer;
  const pc = new RTCPeerConnection({ iceServers });
  peer = {
    id: remoteId,
    userId,
    pc,
    stream: new MediaStream(),
    pendingCandidates: [],
    queue: Promise.resolve(),
    remote: { mic: true, cam: false, screen: false },
    offerer: false,
  };
  const session = active;
  pc.onicecandidate = (e) => {
    if (e.candidate && active === session) sendSignal(remoteId, { type: 'candidate', candidate: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    if (!peer.stream.getTracks().includes(e.track)) peer.stream.addTrack(e.track);
    updateTile(peer);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && peer.offerer && active === session) restartIce(peer);
    updateTile(peer);
  };
  active.peers.set(remoteId, peer);
  renderTiles();
  return peer;
}

async function connectTo(remoteId, userId) {
  const peer = getPeer(remoteId, userId);
  peer.offerer = true;
  // 後からカメラ・画面共有を切り替えられるよう、音声と映像の枠を最初から用意しておく
  peer.pc.addTransceiver(active.audioTrack ?? 'audio', { direction: 'sendrecv' });
  peer.pc.addTransceiver(currentVideoTrack() ?? 'video', { direction: 'sendrecv' });
  try {
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    sendSignal(remoteId, { type: 'offer', sdp: peer.pc.localDescription });
    sendSignal(remoteId, { type: 'state', state: mediaState() });
  } catch (error) {
    console.warn('offer failed', error);
  }
}

async function restartIce(peer) {
  try {
    await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: true }));
    sendSignal(peer.id, { type: 'offer', sdp: peer.pc.localDescription });
  } catch (error) {
    console.warn('ice restart failed', error);
  }
}

export function handleSignal({ from, fromUser, groupId, data }) {
  if (!active || active.groupId !== groupId || !data) return;
  const peer = getPeer(from, fromUser);
  // 同じ相手からの信号は届いた順に処理する
  peer.queue = peer.queue.then(() => processSignal(peer, data)).catch((error) => console.warn('signal error', error));
}

async function processSignal(peer, data) {
  const { pc } = peer;
  if (data.type === 'offer') {
    await pc.setRemoteDescription(data.sdp);
    for (const transceiver of pc.getTransceivers()) {
      const kind = transceiver.receiver.track.kind;
      transceiver.direction = 'sendrecv';
      await transceiver.sender.replaceTrack(kind === 'audio' ? active.audioTrack : currentVideoTrack());
    }
    await pc.setLocalDescription(await pc.createAnswer());
    sendSignal(peer.id, { type: 'answer', sdp: pc.localDescription });
    sendSignal(peer.id, { type: 'state', state: mediaState() });
    await flushCandidates(peer);
  } else if (data.type === 'answer') {
    if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(data.sdp);
    await flushCandidates(peer);
  } else if (data.type === 'candidate') {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    else peer.pendingCandidates.push(data.candidate);
  } else if (data.type === 'state') {
    peer.remote = { ...peer.remote, ...data.state };
    updateTile(peer);
  }
}

async function flushCandidates(peer) {
  const pending = peer.pendingCandidates.splice(0);
  for (const candidate of pending) await peer.pc.addIceCandidate(candidate).catch(() => {});
}

/** 参加者一覧（Firestore から届く）に合わせて接続を作る・切る */
export function handleCallState(callState) {
  if (!active || active.groupId !== callState.groupId) return;
  syncPeers(callState.participants);
  if (active.joined && !callState.participants.some((p) => p.clientId === clientId)) {
    // 通信が長く途切れて、ほかの人から退出扱いにされた場合
    const session = active;
    setTimeout(() => {
      const latest = state.calls.get(session.groupId);
      if (active === session && !latest?.participants.some((p) => p.clientId === clientId)) {
        toast('通信が途切れたため通話から退出しました', { type: 'error' });
        leaveCall();
      }
    }, 3000);
  }
  renderTiles();
  renderShell();
}

function syncPeers(participants) {
  if (!active?.joined) return;
  const present = new Set(participants.map((p) => p.clientId));
  for (const [id, peer] of active.peers) {
    if (!present.has(id)) {
      peer.pc.close();
      active.peers.delete(id);
    }
  }
  // 同時に参加しても片方だけが接続を申し込むよう、あとから参加した側が申し込む
  for (const p of participants) {
    if (p.clientId === clientId || active.peers.has(p.clientId)) continue;
    const iJoinedLater = active.joinedAt > p.joinedAt || (active.joinedAt === p.joinedAt && clientId > p.clientId);
    if (iJoinedLater) connectTo(p.clientId, p.userId);
  }
}

function broadcastState() {
  for (const id of active.peers.keys()) sendSignal(id, { type: 'state', state: mediaState() });
}

async function replaceOnAll(kind, track) {
  const jobs = [];
  for (const peer of active.peers.values()) {
    for (const transceiver of peer.pc.getTransceivers()) {
      if (transceiver.receiver.track.kind === kind && !transceiver.stopped) jobs.push(transceiver.sender.replaceTrack(track).catch(() => {}));
    }
  }
  await Promise.all(jobs);
}

// --- 操作 -----------------------------------------------------------------------

async function toggleMic() {
  if (!active) return;
  if (!active.audioTrack) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      active.audioTrack = stream.getAudioTracks()[0];
      active.micOn = true;
      await replaceOnAll('audio', active.audioTrack);
    } catch {
      toast('マイクを使えません。ブラウザの設定でマイクを許可してください', { type: 'error', duration: 5000 });
      return;
    }
  } else {
    active.micOn = !active.micOn;
    active.audioTrack.enabled = active.micOn;
  }
  broadcastState();
  renderShell();
  renderTiles();
}

async function toggleCam() {
  if (!active) return;
  if (active.camOn) {
    active.camTrack?.stop();
    active.camTrack = null;
    active.camOn = false;
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
      active.camTrack = stream.getVideoTracks()[0];
      active.camOn = true;
    } catch {
      toast('カメラを使えません。ブラウザの設定でカメラを許可してください', { type: 'error', duration: 5000 });
      return;
    }
  }
  if (!active.screenOn) await replaceOnAll('video', active.camTrack);
  broadcastState();
  renderShell();
  renderTiles();
}

async function toggleScreen() {
  if (!active) return;
  if (active.screenOn) {
    await stopScreen();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    active.screenTrack = stream.getVideoTracks()[0];
    active.screenOn = true;
    active.screenTrack.addEventListener('ended', () => stopScreen());
    await replaceOnAll('video', active.screenTrack);
  } catch {
    return; // キャンセル
  }
  broadcastState();
  renderShell();
  renderTiles();
}

async function stopScreen() {
  if (!active?.screenOn) return;
  active.screenTrack?.stop();
  active.screenTrack = null;
  active.screenOn = false;
  await replaceOnAll('video', active.camOn ? active.camTrack : null);
  broadcastState();
  renderShell();
  renderTiles();
}

// --- 描画 -----------------------------------------------------------------------

function renderShell() {
  const overlay = $('#callOverlay');
  const pill = $('#callPill');
  if (!active) {
    overlay.hidden = true;
    overlay.innerHTML = '';
    pill.hidden = true;
    document.body.classList.remove('in-call');
    return;
  }
  const group = state.groups.get(active.groupId);
  overlay.hidden = active.minimized;
  pill.hidden = !active.minimized;
  document.body.classList.toggle('in-call', !active.minimized);
  if (!$('.call-window', overlay)) {
    overlay.innerHTML = `
      <div class="call-window" role="dialog" aria-label="通話">
        <header class="call-head">
          <div><strong class="call-title"></strong><span class="call-sub"><time id="callTimer"></time> · <span class="call-count"></span></span></div>
          <button class="call-icon" data-call="minimize" title="小さくする" aria-label="通話画面を小さくする">${icons.minimize}</button>
        </header>
        <div class="call-grid" id="callGrid"></div>
        <div class="call-controls"></div>
      </div>`;
  }
  $('.call-title', overlay).textContent = group?.name ?? '通話';
  const participants = state.calls.get(active.groupId)?.participants.length ?? 0;
  $('.call-count', overlay).textContent = active.joined ? `${Math.max(participants, active.peers.size + 1)}人` : '接続中…';
  const canShare = Boolean(navigator.mediaDevices?.getDisplayMedia);
  const micOn = active.audioTrack && active.micOn;
  $('.call-controls', overlay).innerHTML = `
    <button class="call-control ${micOn ? '' : 'off'}" data-call="mic" aria-pressed="${!micOn}" title="${micOn ? 'ミュート' : 'ミュート解除'}">${micOn ? icons.mic : icons.micOff}<span>${micOn ? 'ミュート' : '解除'}</span></button>
    <button class="call-control ${active.camOn ? '' : 'off'}" data-call="cam" aria-pressed="${active.camOn}" title="カメラ">${active.camOn ? icons.video : icons.videoOff}<span>カメラ</span></button>
    ${canShare ? `<button class="call-control ${active.screenOn ? 'on' : ''}" data-call="screen" aria-pressed="${active.screenOn}" title="画面共有">${icons.screen}<span>${active.screenOn ? '共有停止' : '画面共有'}</span></button>` : ''}
    <button class="call-control leave" data-call="leave" title="退出">${icons.phoneOff}<span>退出</span></button>`;
  tickCall();
}

function createTile(id, userId, isLocal) {
  const tile = document.createElement('div');
  tile.className = 'call-tile';
  tile.innerHTML = `
    <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
    <div class="tile-avatar"><span class="avatar huge" style="background:${esc(userColor(userId))}">${esc(userName(userId).slice(0, 1))}</span></div>
    <div class="tile-label"><span class="tile-mic"></span><span class="tile-name">${esc(isLocal ? `${userName(userId)}（あなた）` : userName(userId))}</span></div>
    <span class="tile-status"></span>`;
  tiles.set(id, tile);
  return tile;
}

function renderTiles() {
  const grid = $('#callGrid');
  if (!active || !grid) return;
  const wanted = new Set(['local', ...active.peers.keys()]);
  for (const [id, tile] of tiles) {
    if (!wanted.has(id)) {
      tile.remove();
      tiles.delete(id);
    }
  }
  if (!tiles.has('local')) grid.appendChild(createTile('local', state.me.id, true));
  for (const peer of active.peers.values()) {
    if (!tiles.has(peer.id)) {
      const tile = createTile(peer.id, peer.userId, false);
      grid.appendChild(tile);
      const video = tile.querySelector('video');
      video.srcObject = peer.stream;
    }
    updateTile(peer);
  }
  updateLocalTile();
  grid.dataset.count = String(Math.min(tiles.size, 9));
  const empty = $('.call-waiting', grid);
  if (!active.peers.size && active.joined) {
    if (!empty) grid.insertAdjacentHTML('beforeend', '<p class="call-waiting">ほかのメンバーの参加を待っています…<br><small>チャットに「参加する」ボタンが表示されています</small></p>');
  } else {
    empty?.remove();
  }
}

function updateLocalTile() {
  const tile = tiles.get('local');
  if (!tile) return;
  const video = tile.querySelector('video');
  const track = currentVideoTrack();
  const current = video.srcObject?.getVideoTracks?.()[0];
  if (track && current !== track) video.srcObject = new MediaStream([track]);
  if (!track) video.srcObject = null;
  tile.classList.toggle('has-video', Boolean(track));
  tile.classList.toggle('mirror', Boolean(track) && !active.screenOn);
  const micOn = Boolean(active.audioTrack && active.micOn);
  tile.querySelector('.tile-mic').innerHTML = micOn ? '' : icons.micOff;
  tile.querySelector('.tile-status').textContent = active.joined ? '' : '接続中…';
}

function updateTile(peer) {
  const tile = tiles.get(peer.id);
  if (!tile || !active) return;
  const video = tile.querySelector('video');
  const hasVideo = (peer.remote.cam || peer.remote.screen) && peer.stream.getVideoTracks().length > 0;
  tile.classList.toggle('has-video', hasVideo);
  tile.classList.toggle('screen', Boolean(peer.remote.screen));
  tile.querySelector('.tile-mic').innerHTML = peer.remote.mic ? '' : icons.micOff;
  const connection = peer.pc.connectionState;
  const status = { new: '接続中…', connecting: '接続中…', disconnected: '再接続中…', failed: '接続できません' }[connection] ?? '';
  tile.querySelector('.tile-status').textContent = status;
  if (peer.stream.getTracks().length && video.paused) {
    video.play().catch(() => {
      if (!tile.querySelector('[data-call="play"]')) {
        tile.insertAdjacentHTML('beforeend', `<button class="tile-play" data-call="play">${icons.phone} タップして音声をオン</button>`);
      }
    });
  }
}

/** 1秒ごとの通話時間表示 */
export function tickCall() {
  if (!active) return;
  const text = active.joined ? formatDuration(Date.now() - active.startedAt) : '';
  const timer = $('#callTimer');
  if (timer) timer.textContent = text || '準備中';
  $('#callPill .call-pill-time').textContent = text || '接続中';
}
