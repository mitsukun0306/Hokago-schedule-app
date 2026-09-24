// カレンダー（月表示・週表示）と右側のパネル
import { state, notify, visibleEvents, groupList, myEvents } from './state.js';
import {
  $, esc, WEEKDAYS, CATEGORIES, parseKey, toKey, addDays, todayKey, weekStart, formatDateJa, relativeDay,
  formatTimeRange, expandEvents, span, fromMinutes, storage,
} from './utils.js';
import { openEventForm, openEventDetail } from './events.js';
import { openAvailability } from './groups.js';
import { avatarStack, icons } from './ui.js';

const HOUR_HEIGHT = 44;
const MAX_CHIPS = 3;

export function initCalendar() {
  $('#prevPeriod').addEventListener('click', () => move(-1));
  $('#nextPeriod').addEventListener('click', () => move(1));
  $('#todayButton').addEventListener('click', () => {
    state.cursor = todayKey();
    state.selectedDate = todayKey();
    notify();
  });
  $('#viewToggle').addEventListener('click', (e) => {
    const mode = e.target.closest('[data-mode]')?.dataset.mode;
    if (!mode || mode === state.calendarMode) return;
    state.calendarMode = mode;
    storage.set('afterclass.calendarMode', mode);
    scrollWeekOnRender = true;
    notify();
  });
  $('#sourceFilter').addEventListener('click', (e) => {
    const source = e.target.closest('[data-source]')?.dataset.source;
    if (!source) return;
    state.sourceFilter = source;
    notify();
  });
  $('#openEventForm').addEventListener('click', () => openEventForm());
  $('#calendarBody').addEventListener('click', onCalendarClick);
  $('#calendarBody').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-date], [data-event]')) {
      e.preventDefault();
      onCalendarClick(e);
    }
  });
  $('#sidePanel').addEventListener('click', (e) => {
    const eventButton = e.target.closest('[data-event]');
    if (eventButton) return openEventDetail(eventButton.dataset.event, eventButton.dataset.date);
    if (e.target.closest('#addOnSelected')) return openEventForm({ date: state.selectedDate });
    if (e.target.closest('#checkAvailability')) return openAvailability({ date: state.selectedDate });
    return undefined;
  });
}

let scrollWeekOnRender = true;

function move(direction) {
  if (state.calendarMode === 'week') {
    state.cursor = addDays(state.cursor, direction * 7);
  } else {
    const date = parseKey(state.cursor);
    state.cursor = toKey(new Date(date.getFullYear(), date.getMonth() + direction, 1));
  }
  notify();
}

function onCalendarClick(e) {
  const chip = e.target.closest('[data-event]');
  if (chip) {
    e.stopPropagation();
    openEventDetail(chip.dataset.event, chip.dataset.date);
    return;
  }
  const slot = e.target.closest('[data-slot]');
  if (slot) {
    const hour = Number(slot.dataset.hour);
    openEventForm({ date: slot.dataset.slot, start: fromMinutes(hour * 60), end: fromMinutes(Math.min(hour * 60 + 60, 23 * 60 + 59)) });
    return;
  }
  const day = e.target.closest('[data-date]');
  if (!day) return;
  if (state.selectedDate === day.dataset.date && !day.classList.contains('muted')) {
    openEventForm({ date: day.dataset.date });
    return;
  }
  state.selectedDate = day.dataset.date;
  if (day.classList.contains('muted')) state.cursor = day.dataset.date;
  notify();
}

export function renderCalendar() {
  renderFilter();
  renderModeToggle();
  if (state.calendarMode === 'week') renderWeek();
  else renderMonth();
  renderSidePanel();
}

function renderModeToggle() {
  $('#viewToggle').querySelectorAll('[data-mode]').forEach((button) => {
    const selected = button.dataset.mode === state.calendarMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected);
  });
}

function renderFilter() {
  const options = [['all', 'すべて', null], ['personal', '自分だけ', null], ...groupList().map((g) => [g.id, g.name, g.color])];
  $('#sourceFilter').innerHTML = options
    .map(([id, label, color]) => `<button class="filter-chip ${state.sourceFilter === id ? 'active' : ''}" data-source="${esc(id)}" ${color ? `style="--group:${esc(color)}"` : ''}>${color ? '<i></i>' : ''}${esc(label)}</button>`)
    .join('');
}

function chip(instance) {
  const group = instance.groupId ? state.groups.get(instance.groupId) : null;
  const declined = instance.groupId && instance.rsvp?.[state.me.id] === 'no';
  return `<button class="event ${esc(instance.category)} ${declined ? 'declined' : ''}" data-event="${esc(instance.id)}" data-date="${instance.instanceDate}" title="${esc(`${formatTimeRange(instance)} ${instance.title}`)}">
    ${group ? `<i class="group-dot" style="background:${esc(group.color)}"></i>` : ''}<small class="event-time">${esc(instance.allDay ? '終日' : instance.start)}</small>${esc(instance.title)}</button>`;
}

function renderMonth() {
  const cursor = parseKey(state.cursor);
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  $('#periodLabel').textContent = `${year}年 ${month + 1}月`;
  const first = toKey(new Date(year, month, 1));
  const gridStart = weekStart(first);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leading = (new Date(year, month, 1).getDay() + 6) % 7;
  const cells = Math.ceil((leading + daysInMonth) / 7) * 7;
  const gridEnd = addDays(gridStart, cells - 1);
  const byDate = groupByDate(expandEvents(visibleEvents(), gridStart, gridEnd));
  const today = todayKey();

  let html = '<div class="weekday-row">' + ['月', '火', '水', '木', '金', '土', '日'].map((d, i) => `<span class="${i >= 5 ? 'weekend' : ''}">${d}</span>`).join('') + '</div><div class="calendar-grid">';
  for (let i = 0; i < cells; i += 1) {
    const key = addDays(gridStart, i);
    const date = parseKey(key);
    const list = byDate.get(key) ?? [];
    const classes = ['day'];
    if (date.getMonth() !== month) classes.push('muted');
    if (key === today) classes.push('today');
    if (key === state.selectedDate) classes.push('selected-day');
    if (i % 7 >= 5) classes.push('weekend');
    html += `<div class="${classes.join(' ')}" data-date="${key}" role="button" tabindex="0" aria-label="${esc(formatDateJa(key))} 予定${list.length}件">
      <span class="day-number">${date.getDate()}</span>
      ${list.slice(0, MAX_CHIPS).map(chip).join('')}
      ${list.length > MAX_CHIPS ? `<span class="more-events">ほか${list.length - MAX_CHIPS}件</span>` : ''}
      ${list.length ? `<span class="dot-summary" aria-hidden="true">${list.slice(0, 4).map((e) => `<i class="${esc(e.category)}"></i>`).join('')}</span>` : ''}
    </div>`;
  }
  html += '</div>';
  $('#calendarBody').className = 'calendar-body month';
  $('#calendarBody').innerHTML = html;
}

function renderWeek() {
  const start = weekStart(state.cursor);
  const end = addDays(start, 6);
  const startDate = parseKey(start);
  const endDate = parseKey(end);
  $('#periodLabel').textContent =
    startDate.getMonth() === endDate.getMonth()
      ? `${startDate.getFullYear()}年 ${startDate.getMonth() + 1}月${startDate.getDate()}日–${endDate.getDate()}日`
      : `${startDate.getMonth() + 1}月${startDate.getDate()}日–${endDate.getMonth() + 1}月${endDate.getDate()}日`;
  const byDate = groupByDate(expandEvents(visibleEvents(), start, end));
  const today = todayKey();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  const head = days
    .map((key, i) => {
      const date = parseKey(key);
      return `<button class="week-head ${key === today ? 'today' : ''} ${key === state.selectedDate ? 'selected' : ''} ${i >= 5 ? 'weekend' : ''}" data-date="${key}">
        <span>${WEEKDAYS[date.getDay()]}</span><strong>${date.getDate()}</strong></button>`;
    })
    .join('');
  const allDay = days
    .map((key) => `<div class="week-allday-cell">${(byDate.get(key) ?? []).filter((e) => e.allDay).map(chip).join('')}</div>`)
    .join('');
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="hour-label" style="height:${HOUR_HEIGHT}px"><span>${h ? `${h}:00` : ''}</span></div>`).join('');
  const columns = days
    .map((key) => {
      const timed = (byDate.get(key) ?? []).filter((e) => !e.allDay);
      const slots = Array.from({ length: 24 }, (_, h) => `<div class="hour-slot" data-slot="${key}" data-hour="${h}" style="height:${HOUR_HEIGHT}px" title="${h}:00 に予定を追加"></div>`).join('');
      const nowLine = key === today ? `<div class="now-line" style="top:${(new Date().getHours() * 60 + new Date().getMinutes()) * (HOUR_HEIGHT / 60)}px"></div>` : '';
      return `<div class="week-column ${key === state.selectedDate ? 'selected' : ''}">${slots}${layoutColumn(timed)}${nowLine}</div>`;
    })
    .join('');

  const previousScroll = $('#weekScroll')?.scrollTop;
  $('#calendarBody').className = 'calendar-body week';
  $('#calendarBody').innerHTML = `
    <div class="week-header"><div class="hour-gutter"></div>${head}</div>
    <div class="week-allday"><div class="hour-gutter"><span>終日</span></div>${allDay}</div>
    <div class="week-scroll" id="weekScroll"><div class="week-grid"><div class="hour-gutter">${hours}</div>${columns}</div></div>`;
  if (scrollWeekOnRender || previousScroll === undefined) {
    $('#weekScroll').scrollTop = HOUR_HEIGHT * 7.5;
    scrollWeekOnRender = false;
  } else {
    $('#weekScroll').scrollTop = previousScroll;
  }
}

/** 重なる予定を横に並べる */
function layoutColumn(events) {
  const items = events.map((e) => ({ event: e, span: span(e) })).sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  const placed = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const columns = Math.max(1, ...cluster.map((c) => c.column + 1));
    cluster.forEach((c) => placed.push({ ...c, columns }));
    cluster = [];
  };
  for (const item of items) {
    if (item.span[0] >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    const used = new Set(cluster.filter((c) => c.span[1] > item.span[0]).map((c) => c.column));
    let column = 0;
    while (used.has(column)) column += 1;
    cluster.push({ ...item, column });
    clusterEnd = Math.max(clusterEnd, item.span[1]);
  }
  flush();
  return placed
    .map(({ event, span: [start, end], column, columns }) => {
      const top = start * (HOUR_HEIGHT / 60);
      const height = Math.max((end - start) * (HOUR_HEIGHT / 60), 20);
      const group = event.groupId ? state.groups.get(event.groupId) : null;
      const declined = event.groupId && event.rsvp?.[state.me.id] === 'no';
      return `<button class="week-event ${esc(event.category)} ${declined ? 'declined' : ''}" data-event="${esc(event.id)}" data-date="${event.instanceDate}"
        style="top:${top}px;height:${height}px;left:calc(${(column / columns) * 100}% + 2px);width:calc(${100 / columns}% - 4px);${group ? `--group:${esc(group.color)}` : ''}">
        <strong>${esc(event.title)}</strong><small>${esc(formatTimeRange(event))}</small></button>`;
    })
    .join('');
}

function groupByDate(instances) {
  const map = new Map();
  for (const instance of instances) {
    if (!map.has(instance.instanceDate)) map.set(instance.instanceDate, []);
    map.get(instance.instanceDate).push(instance);
  }
  return map;
}

function upcomingItem(instance) {
  const date = parseKey(instance.instanceDate);
  const group = instance.groupId ? state.groups.get(instance.groupId) : null;
  return `<button class="upcoming-item" data-event="${esc(instance.id)}" data-date="${instance.instanceDate}">
    <div class="upcoming-date"><strong>${date.getDate()}</strong>${WEEKDAYS[date.getDay()]}曜日</div>
    <div class="upcoming-info"><strong>${esc(instance.title)}</strong>
      <span>${esc(relativeDay(instance.instanceDate) ? `${relativeDay(instance.instanceDate)} · ` : '')}${esc(formatTimeRange(instance))} · ${esc(CATEGORIES[instance.category]?.label ?? '')}${group ? ` · ${esc(group.name)}` : ''}</span>
    </div></button>`;
}

function renderSidePanel() {
  const selected = state.selectedDate;
  const dayEvents = expandEvents(visibleEvents(), selected, selected);
  const today = todayKey();
  const upcoming = expandEvents(myEvents(), today, addDays(today, 60))
    .filter((e) => e.instanceDate > today || e.allDay || !e.end || e.end >= new Date().toTimeString().slice(0, 5))
    .slice(0, 5);
  const friends = [...new Set(groupList().flatMap((g) => g.members))].filter((id) => id !== state.me.id);

  $('#sidePanel').innerHTML = `
    <div class="side-heading"><div><p class="eyebrow">${esc(relativeDay(selected) || 'SELECTED DAY')}</p><h2>${esc(formatDateJa(selected))}</h2></div>
      <button class="round-button" id="addOnSelected" aria-label="この日に予定を追加" title="この日に予定を追加">${icons.plus}</button></div>
    <div class="day-list">${dayEvents.length ? dayEvents.map(upcomingItem).join('') : '<p class="empty-text">予定はありません。<br>もう一度タップすると予定を追加できます。</p>'}</div>
    <div class="side-section"><p class="eyebrow">UP NEXT</p><h3>これからの予定</h3>
      <div class="upcoming-list">${upcoming.length ? upcoming.map(upcomingItem).join('') : '<p class="empty-text">60日以内の予定はありません</p>'}</div>
      <a class="text-button" href="#schedule">すべての予定を見る <span>→</span></a>
    </div>
    <div class="friends-box">
      <div class="friends-title"><h3>友だちの予定</h3><span>${friends.length}人</span></div>
      ${friends.length ? `<div class="friend-avatars">${avatarStack(friends, 6)}</div><p>みんなが空いている時間をチェックしよう。</p>
        <button class="ghost-button full" id="checkAvailability">${icons.clock} 空き時間を見る</button>`
        : '<p>グループを作って友だちを招待すると、空き時間を確認できます。</p><a class="ghost-button full" href="#groups">' + icons.users + ' グループへ</a>'}
    </div>`;
}
