export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const pad = (n) => String(n).padStart(2, '0');
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export const CATEGORIES = {
  study: { label: '勉強' },
  play: { label: '遊び' },
  club: { label: '部活' },
  food: { label: 'ごはん' },
  other: { label: 'その他' },
};

export const REPEAT_LABELS = { none: '繰り返さない', daily: '毎日', weekly: '毎週', monthly: '毎月' };
export const REMINDER_LABELS = { 0: 'なし', 5: '5分前', 10: '10分前', 30: '30分前', 60: '1時間前', 1440: '前日' };
export const RSVP_LABELS = { yes: '参加', maybe: '未定', no: '不参加' };

// --- 日付 ----------------------------------------------------------------------

export const toKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const parseKey = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const todayKey = () => toKey(new Date());
export const addDays = (key, n) => {
  const date = parseKey(key);
  date.setDate(date.getDate() + n);
  return toKey(date);
};
export const daysBetween = (a, b) => Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 86400000);
const ymd = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return [y, m - 1, d];
};
/** 月曜始まりの週の月曜日 */
export const weekStart = (key) => {
  const date = parseKey(key);
  return addDays(key, -((date.getDay() + 6) % 7));
};
export const toMinutes = (time) => {
  if (!time) return null;
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};
export const fromMinutes = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export function formatDateJa(key, { year = false, weekday = true } = {}) {
  const date = parseKey(key);
  const base = `${year ? `${date.getFullYear()}年` : ''}${date.getMonth() + 1}月${date.getDate()}日`;
  return weekday ? `${base}(${WEEKDAYS[date.getDay()]})` : base;
}

export function relativeDay(key) {
  const diff = daysBetween(todayKey(), key);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === 2) return 'あさって';
  if (diff === -1) return '昨日';
  return '';
}

export function formatTimeRange(event) {
  if (event.allDay) return '終日';
  return event.end ? `${event.start}–${event.end}` : `${event.start}〜`;
}

export function formatClock(ms) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function repeatText(event) {
  if (!event.repeat || event.repeat === 'none') return '';
  const date = parseKey(event.date);
  const rule = {
    daily: '毎日',
    weekly: `毎週${WEEKDAYS[date.getDay()]}曜日`,
    monthly: `毎月${date.getDate()}日`,
  }[event.repeat];
  return event.repeatUntil ? `${rule}（${formatDateJa(event.repeatUntil, { weekday: false })}まで）` : rule;
}

// --- 繰り返し予定の展開 --------------------------------------------------------

/** 期間 [from, to]（両端含む）に入る予定の発生日を返す */
export function occurrences(event, from, to) {
  const last = event.repeat !== 'none' && event.repeatUntil && event.repeatUntil < to ? event.repeatUntil : to;
  if (event.date > last) return [];
  if (!event.repeat || event.repeat === 'none') return event.date >= from ? [event.date] : [];
  const dates = [];
  if (event.repeat === 'daily' || event.repeat === 'weekly') {
    const step = event.repeat === 'daily' ? 1 : 7;
    const gap = daysBetween(event.date, from);
    let key = gap > 0 ? addDays(event.date, Math.ceil(gap / step) * step) : event.date;
    while (key <= last) {
      dates.push(key);
      key = addDays(key, step);
    }
  } else if (event.repeat === 'monthly') {
    const [y, m, d] = ymd(event.date);
    const [fy, fm] = ymd(from);
    let offset = Math.max(0, (fy - y) * 12 + (fm - m));
    for (;;) {
      const date = new Date(y, m + offset, d);
      offset += 1;
      if (date.getDate() !== d) continue; // 31日がない月などは飛ばす
      const key = toKey(date);
      if (key > last) break;
      if (key >= from) dates.push(key);
    }
  }
  return dates;
}

export function expandEvents(events, from, to) {
  const instances = [];
  for (const event of events) {
    for (const date of occurrences(event, from, to)) {
      instances.push({ ...event, instanceDate: date, key: `${event.id}@${date}` });
    }
  }
  return instances.sort(compareInstances);
}

export function compareInstances(a, b) {
  return (
    a.instanceDate.localeCompare(b.instanceDate) ||
    Number(b.allDay) - Number(a.allDay) ||
    (a.start || '').localeCompare(b.start || '') ||
    a.title.localeCompare(b.title)
  );
}

/** 時間帯 [start, end)（分）。終了未設定は1時間とみなす */
export function span(event) {
  const start = toMinutes(event.start);
  const end = event.end ? toMinutes(event.end) : Math.min(start + 60, 24 * 60);
  return [start, end];
}

export function overlaps(a, b) {
  if (a.allDay || b.allDay) return false;
  const [as, ae] = span(a);
  const [bs, be] = span(b);
  return as < be && bs < ae;
}

// --- iCalendar (.ics) ----------------------------------------------------------

const icsText = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
const compact = (key) => key.replace(/-/g, '');

function foldLine(line) {
  const encoder = new TextEncoder();
  const parts = [];
  let current = '';
  for (const char of line) {
    if (encoder.encode(current + char).length > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function toICS(events, { groupName } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Afterclass//JA', 'CALSCALE:GREGORIAN', 'X-WR-TIMEZONE:Asia/Tokyo'];
  for (const event of events) {
    lines.push('BEGIN:VEVENT', `UID:${event.id}@afterclass`, `DTSTAMP:${stamp}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${compact(event.date)}`, `DTEND;VALUE=DATE:${compact(addDays(event.date, 1))}`);
    } else {
      const [, end] = span(event);
      const endDate = end >= 24 * 60 ? addDays(event.date, 1) : event.date;
      const endTime = end >= 24 * 60 ? '00:00' : fromMinutes(end);
      lines.push(`DTSTART:${compact(event.date)}T${event.start.replace(':', '')}00`);
      lines.push(`DTEND:${compact(endDate)}T${endTime.replace(':', '')}00`);
    }
    if (event.repeat && event.repeat !== 'none') {
      const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' }[event.repeat];
      lines.push(`RRULE:FREQ=${freq}${event.repeatUntil ? `;UNTIL=${compact(event.repeatUntil)}T235959` : ''}`);
    }
    lines.push(`SUMMARY:${icsText(event.title)}`);
    if (event.location) lines.push(`LOCATION:${icsText(event.location)}`);
    const description = [groupName && `グループ: ${groupName}`, event.memo].filter(Boolean).join('\n');
    if (description) lines.push(`DESCRIPTION:${icsText(description)}`);
    if (event.reminder) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(event.title)}`, `TRIGGER:-PT${event.reminder}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export function linkify(escapedText) {
  return escapedText.replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

export const storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* プライベートモード等では保存しない */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  },
};
