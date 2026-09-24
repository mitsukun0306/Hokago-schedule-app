import { storage } from './utils.js';

const TOKEN_KEY = 'afterclass.token';

export const clientId =
  globalThis.crypto?.randomUUID?.() ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export const auth = {
  get token() {
    return storage.get(TOKEN_KEY, null);
  },
  set(token) {
    storage.set(TOKEN_KEY, token);
  },
  clear() {
    storage.remove(TOKEN_KEY);
  },
};

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('サーバーに接続できません。通信状況を確認してください', 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || `エラーが発生しました (${response.status})`, response.status);
  return data;
}

/**
 * サーバーからのリアルタイム配信（SSE）を受け取る。
 * トークンを URL に載せないよう EventSource ではなく fetch のストリームで読む。
 */
export function connectStream({ onEvent, onOpen, onDisconnect, onUnauthorized }) {
  let stopped = false;
  let controller = null;

  async function run() {
    while (!stopped) {
      controller = new AbortController();
      let opened = false;
      try {
        const response = await fetch(`/api/stream?clientId=${encodeURIComponent(clientId)}`, {
          headers: { Authorization: `Bearer ${auth.token}`, Accept: 'text/event-stream' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status === 401) {
          onUnauthorized?.();
          return;
        }
        if (!response.ok || !response.body) throw new Error('stream failed');
        opened = true;
        onOpen?.();
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = chunk
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (data) {
              try {
                onEvent(JSON.parse(data));
              } catch (error) {
                console.error('stream event error', error);
              }
            }
          }
        }
      } catch {
        /* 下で再接続 */
      }
      if (stopped) return;
      onDisconnect?.(opened);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  run();
  return {
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
