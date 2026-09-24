// 予定の一覧・検索・出欠管理・書き出し
import { state, groupList, myEvents } from './state.js';
import {
  $, esc, CATEGORIES, RSVP_LABELS, WEEKDAYS, parseKey, addDays, todayKey, weekStart, relativeDay,
  formatTimeRange, expandEvents, repeatText, toICS, downloadFile,
} from './utils.js';
import { openEventForm, openEventDetail, setRsvp } from './events.js';
import { icons, toast } from './ui.js';

const filters = { query: '', period: 'upcoming', source: 'all', category: 'all', status: 'all' };

const PERIODS = {
  today: { label: '今日', range: (t) => [t, t] },
  upcoming: { label: 'これから（90日）', range: (t) => [t, addDays(t, 90)] },
  week: { label: '今週', range: (t) => [weekStart(t), addDays(weekStart(t), 6)] },
  month: { label: '今月', range: (t) => [`${t.slice(0, 7)}-01`, lastOfMonth(t)] },
  past: { label: '過去（90日）', range: (t) => [addDays(t, -90), addDays(t, -1)] },
};

function lastOfMonth(key) {
  const date = parseKey(key);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return `${key.slice(0, 7)}-${String(last.getDate()).padStart(2, '0')}`;
}

export function initSchedule() {
  const root = $('#view-schedule');
  root.addEventListener('input', (e) => {
    const name = e.target.dataset.filter;
    if (!name) return;
    filters[name] = e.target.value;
    renderList();
  });
  root.addEventListener('click', (e) => {
    if (e.target.closest('#scheduleAdd')) return openEventForm();
    if (e.target.closest('#exportIcs')) return exportCalendar();
    const stat = e.target.closest('[data-stat]');
    if (stat) {
      Object.assign(filters, JSON.parse(stat.dataset.stat));
      syncControls();
      return renderList();
    }
    const rsvp = e.target.closest('[data-rsvp]');
    if (rsvp) {
      const event = state.events.get(rsvp.dataset.id);
      const status = event?.rsvp?.[state.me.id] === rsvp.dataset.rsvp ? 'none' : rsvp.dataset.rsvp;
      return setRsvp(rsvp.dataset.id, status, rsvp);
    }
    const item = e.target.closest('[data-event]');
    if (item) return openEventDetail(item.dataset.event, item.dataset.date);
    return undefined;
  });
}

function syncControls() {
  const root = $('#view-schedule');
  root.querySelectorAll('[data-filter]').forEach((control) => {
    if (control !== document.activeElement) control.value = filters[control.dataset.filter];
  });
}

export function renderSchedule() {
  const root = $('#view-schedule');
  if (!root.dataset.ready) {
    root.dataset.ready = '1';
    root.innerHTML = `
      <section class="intro-row">
        <div><p class="eyebrow">SCHEDULE <span></span> MANAGE</p><h1>予定をまとめて、<br><em>ちゃんと管理。</em></h1></div>
        <div class="intro-actions">
          <button class="ghost-button" id="exportIcs">${icons.download} カレンダーに書き出す</button>
          <button class="primary-button" id="scheduleAdd"><span>＋</span> 予定を追加</button>
        </div>
      </section>
      <div class="stats-row" id="scheduleStats"></div>
      <div class="card schedule-card">
        <div class="schedule-toolbar">
          <label class="search-field">${icons.search}<input type="search" data-filter="query" placeholder="予定・場所・メモを検索" aria-label="予定を検索"></label>
          <select data-filter="period" aria-label="期間">${Object.entries(PERIODS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('')}</select>
          <select data-filter="source" aria-label="共有先" id="scheduleSource"></select>
          <select data-filter="category" aria-label="カテゴリー"><option value="all">すべてのカテゴリー</option>${Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}">${c.label}</option>`).join('')}</select>
          <select data-filter="status" aria-label="出欠"><option value="all">出欠：すべて</option><option value="pending">未回答のみ</option><option value="yes">参加する予定</option><option value="maybe">未定</option><option value="no">不参加</option></select>
        </div>
        <div id="scheduleList" class="schedule-list"></div>
      </div>`;
  }
  const sourceSelect = $('#scheduleSource');
  if (filters.source !== 'all' && filters.source !== 'personal' && !state.groups.has(filters.source)) filters.source = 'all';
  sourceSelect.innerHTML = `<option value="all">すべての予定</option><option value="personal">自分だけ</option>${groupList().map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}`;
  syncControls();
  renderStats();
  renderList();
}

function renderStats() {
  const today = todayKey();
  const mine = myEvents();
  const todayCount = expandEvents(mine, today, today).length;
  const weekCount = expandEvents(mine, weekStart(today), addDays(weekStart(today), 6)).length;
  const pending = [...state.events.values()].filter(
    (e) => e.groupId && !e.rsvp?.[state.me.id] && (e.repeat !== 'none' ? !e.repeatUntil || e.repeatUntil >= today : e.date >= today),
  ).length;
  const stat = (label, value, filter, accent = '') =>
    `<button class="stat ${accent}" data-stat='${esc(JSON.stringify(filter))}'><span>${label}</span><strong>${value}</strong></button>`;
  $('#scheduleStats').innerHTML =
    stat('今日の予定', todayCount, { period: 'today', status: 'all', query: '' }) +
    stat('今週の予定', weekCount, { period: 'week', status: 'all', query: '' }) +
    stat('出欠の回答待ち', pending, { period: 'upcoming', status: 'pending', query: '' }, pending ? 'alert' : '') +
    `<a class="stat" href="#groups"><span>参加中のグループ</span><strong>${state.groups.size}</strong></a>`;
}

function matches(event) {
  const me = state.me.id;
  if (filters.source === 'personal' && event.groupId) return false;
  if (!['all', 'personal'].includes(filters.source) && event.groupId !== filters.source) return false;
  if (filters.category !== 'all' && event.category !== filters.category) return false;
  if (filters.status !== 'all') {
    if (!event.groupId) return filters.status === 'yes';
    const status = event.rsvp?.[me];
    if (filters.status === 'pending' ? status : status !== filters.status) return false;
  }
  const query = filters.query.trim().toLowerCase();
  if (query && ![event.title, event.location, event.memo].some((text) => text?.toLowerCase().includes(query))) return false;
  return true;
}

function renderList() {
  const [from, to] = PERIODS[filters.period].range(todayKey());
  let instances = expandEvents([...state.events.values()].filter(matches), from, to);
  if (filters.period === 'past') instances = instances.reverse();
  const list = $('#scheduleList');
  if (!instances.length) {
    list.innerHTML = `<div class="empty-state">${icons.calendar}<p>${filters.query || filters.status !== 'all' || filters.category !== 'all' ? '条件に合う予定はありません' : 'この期間の予定はまだありません'}</p><button class="ghost-button" id="scheduleAdd">${icons.plus} 予定を追加</button></div>`;
    return;
  }
  let html = '';
  let currentDate = null;
  for (const instance of instances) {
    if (instance.instanceDate !== currentDate) {
      if (currentDate) html += '</ul>';
      currentDate = instance.instanceDate;
      const date = parseKey(currentDate);
      const relative = relativeDay(currentDate);
      html += `<h3 class="list-date ${date.getDay() === 0 || date.getDay() === 6 ? 'weekend' : ''}"><strong>${date.getMonth() + 1}/${date.getDate()}</strong> ${WEEKDAYS[date.getDay()]}曜日${relative ? `<em>${relative}</em>` : ''}</h3><ul class="schedule-items">`;
    }
    html += scheduleItem(instance);
  }
  html += '</ul>';
  list.innerHTML = html;
}

function scheduleItem(instance) {
  const me = state.me.id;
  const group = instance.groupId ? state.groups.get(instance.groupId) : null;
  const myStatus = instance.rsvp?.[me];
  const yes = group ? group.members.filter((id) => instance.rsvp?.[id] === 'yes').length : 0;
  return `<li class="schedule-item ${myStatus === 'no' ? 'declined' : ''}">
    <button class="schedule-main" data-event="${esc(instance.id)}" data-date="${instance.instanceDate}">
      <span class="schedule-time">${esc(formatTimeRange(instance))}</span>
      <span class="schedule-bar ${esc(instance.category)}"></span>
      <span class="schedule-info">
        <strong>${esc(instance.title)}</strong>
        <span class="schedule-meta">
          <span class="category-badge ${esc(instance.category)}">${esc(CATEGORIES[instance.category]?.label ?? '')}</span>
          ${group ? `<span class="source-badge" style="--group:${esc(group.color)}">${esc(group.name)}</span>` : '<span class="source-badge personal">自分だけ</span>'}
          ${instance.location ? `<span>${icons.pin}${esc(instance.location)}</span>` : ''}
          ${instance.repeat !== 'none' ? `<span>${icons.repeat}${esc(repeatText(instance))}</span>` : ''}
          ${group ? `<span>${icons.users}参加 ${yes}/${group.members.length}</span>` : ''}
        </span>
      </span>
    </button>
    ${group ? `<div class="mini-rsvp" role="group" aria-label="出欠">${Object.entries(RSVP_LABELS).map(([key, label]) => `<button class="rsvp-button small ${key} ${myStatus === key ? 'active' : ''}" data-rsvp="${key}" data-id="${esc(instance.id)}" aria-pressed="${myStatus === key}">${label}</button>`).join('')}</div>` : ''}
  </li>`;
}

function exportCalendar() {
  const events = [...state.events.values()].filter(matches);
  if (!events.length) {
    toast('書き出す予定がありません', { type: 'error' });
    return;
  }
  downloadFile(`afterclass-${todayKey()}.ics`, toICS(events), 'text/calendar;charset=utf-8');
  toast(`${events.length}件の予定を書き出しました。Google カレンダーや iPhone のカレンダーに読み込めます`, { type: 'success', duration: 5000 });
}
