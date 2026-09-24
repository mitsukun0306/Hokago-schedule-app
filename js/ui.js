import { $, esc } from './utils.js';
import { state, userColor, userName } from './state.js';

const svg = (body, size = 18) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  bell: svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>', 20),
  phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
  phoneOff: svg('<path d="M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.3 5.2 2 2 0 0 1 5.1 3h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L9 10.8"/><path d="M22 2 2 22"/>'),
  video: svg('<path d="m16 13 5.2 3.1a.5.5 0 0 0 .8-.4V8.3a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/>'),
  videoOff: svg('<path d="M10.7 6H14a2 2 0 0 1 2 2v3.3l1 1L22 8v8"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="m2 2 20 20"/>'),
  mic: svg('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>'),
  micOff: svg('<path d="m2 2 20 20"/><path d="M18.9 13.3A7 7 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.3V5a3 3 0 0 0-5.7-1.3"/><path d="M9 9v3a3 3 0 0 0 5.1 2.1"/><path d="M12 19v3"/>'),
  screen: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  minimize: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
  share: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.8 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  send: svg('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'),
  calendar: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  trash: svg('<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  clock: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  pin: svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'),
  repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  mail: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'),
};

export function avatar(userId, size = '') {
  const name = userName(userId);
  return `<span class="avatar ${size}" style="background:${esc(userColor(userId))}" title="${esc(name)}">${esc(name.slice(0, 1))}</span>`;
}

export function avatarStack(userIds, max = 5) {
  const shown = userIds.slice(0, max).map((id) => avatar(id, 'small')).join('');
  const rest = userIds.length > max ? `<span class="avatar small more">+${userIds.length - max}</span>` : '';
  return `<span class="avatar-stack">${shown}${rest}</span>`;
}

export function groupBadge(groupId) {
  if (!groupId) return '<span class="source-badge personal">自分だけ</span>';
  const group = state.groups.get(groupId);
  if (!group) return '';
  return `<span class="source-badge" style="--group:${esc(group.color)}">${esc(group.name)}</span>`;
}

// --- モーダル -----------------------------------------------------------------

let modalCleanup = null;
let lastFocus = null;

export function openModal(html, { wide = false, onClose } = {}) {
  closeModal();
  const backdrop = $('#modal');
  const dialog = $('.modal', backdrop);
  dialog.classList.toggle('wide', wide);
  // 前のモーダルのイベントリスナーを持ち越さないよう、中身の要素ごと作り直す
  const body = document.createElement('div');
  body.id = 'modalBody';
  body.innerHTML = html;
  $('#modalBody').replaceWith(body);
  lastFocus = document.activeElement;
  backdrop.hidden = false;
  document.body.classList.add('modal-open');
  modalCleanup = onClose ?? null;
  requestAnimationFrame(() => $('[autofocus]', dialog)?.focus());
  return $('#modalBody');
}

export function closeModal() {
  const backdrop = $('#modal');
  if (backdrop.hidden) return;
  backdrop.hidden = true;
  const empty = document.createElement('div');
  empty.id = 'modalBody';
  $('#modalBody').replaceWith(empty);
  document.body.classList.remove('modal-open');
  const cleanup = modalCleanup;
  modalCleanup = null;
  cleanup?.();
  lastFocus?.focus?.();
}

export const isModalOpen = () => !$('#modal').hidden;

export function confirmDialog({ title, message = '', confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = 'modal-backdrop confirm-layer';
    layer.innerHTML = `
      <div class="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle">
        <h2 id="confirmTitle">${esc(title)}</h2>
        ${message ? `<p class="confirm-message">${esc(message)}</p>` : ''}
        <div class="modal-actions">
          <button class="ghost-button" data-answer="no">キャンセル</button>
          <button class="primary-button ${danger ? 'danger' : ''}" data-answer="yes">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const finish = (answer) => {
      layer.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish(false);
      }
    };
    layer.addEventListener('click', (event) => {
      if (event.target === layer) return finish(false);
      const button = event.target.closest('[data-answer]');
      if (button) finish(button.dataset.answer === 'yes');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(layer);
    $('[data-answer="yes"]', layer).focus();
  });
}

// --- トースト -----------------------------------------------------------------

export function toast(message, { type = 'info', actions = [], duration = 3500 } = {}) {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.setAttribute('role', type === 'error' ? 'alert' : 'status');
  element.innerHTML = `<span class="toast-text">${esc(message)}</span>${actions
    .map((action, index) => `<button class="toast-action" data-index="${index}">${esc(action.label)}</button>`)
    .join('')}<button class="toast-close" aria-label="閉じる">${icons.x}</button>`;
  const dismiss = () => {
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 200);
  };
  element.addEventListener('click', (event) => {
    const actionButton = event.target.closest('.toast-action');
    if (actionButton) {
      actions[Number(actionButton.dataset.index)].onClick();
      dismiss();
    } else if (event.target.closest('.toast-close')) {
      dismiss();
    }
  });
  $('#toasts').appendChild(element);
  if (duration) setTimeout(dismiss, duration);
  return dismiss;
}

export const toastError = (error) => toast(error?.message ?? String(error), { type: 'error', duration: 5000 });

/** ボタンを押している間の二重送信を防ぐ */
export async function withBusy(button, task) {
  if (!button || button.disabled) return undefined;
  button.disabled = true;
  button.classList.add('busy');
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
  }
}
