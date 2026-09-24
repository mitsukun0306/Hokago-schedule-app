const monthLabel = document.querySelector('#monthLabel');
const calendarGrid = document.querySelector('#calendarGrid');
const upcomingList = document.querySelector('#upcomingList');
const modal = document.querySelector('#modal');
const eventForm = document.querySelector('#eventForm');
const eventDate = document.querySelector('#eventDate');

let viewDate = new Date(2025, 4, 1);
let selectedDate = '2025-05-14';
let events = [
  { date: '2025-05-14', time: '16:30', title: '図書館で勉強', category: 'study' },
  { date: '2025-05-16', time: '17:00', title: '美術部', category: 'club' },
  { date: '2025-05-17', time: '12:00', title: '駅前でランチ', category: 'food' },
  { date: '2025-05-21', time: '16:00', title: '映画を見に行く', category: 'play' },
  { date: '2025-05-23', time: '18:30', title: 'みんなでごはん', category: 'food' },
  { date: '2025-05-27', time: '16:30', title: 'テスト勉強会', category: 'study' }
];

const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
const formatDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function renderCalendar() {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  monthLabel.textContent = `${year}年 ${monthNames[month]}`;
  calendarGrid.innerHTML = '';
  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const previousMonthDays = new Date(year, month, 0).getDate();
  const cells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
  for (let index = 0; index < cells; index += 1) {
    const dayOffset = index - firstDay;
    const dayNumber = dayOffset + 1;
    const date = new Date(year, month, dayNumber);
    const inMonth = dayNumber > 0 && dayNumber <= daysInMonth;
    const dateKey = formatDate(date);
    const day = document.createElement('div');
    day.className = `day${inMonth ? '' : ' muted'}${dateKey === selectedDate ? ' selected-day' : ''}`;
    const displayNumber = inMonth ? dayNumber : dayOffset < 0 ? previousMonthDays + dayOffset : dayNumber - daysInMonth;
    day.innerHTML = `<span class="day-number">${displayNumber}</span>`;
    events.filter((event) => event.date === dateKey).forEach((event) => {
      day.insertAdjacentHTML('beforeend', `<span class="event ${event.category}"><small class="event-time">${event.time}</small>${event.title}</span>`);
    });
    if (inMonth) day.addEventListener('click', () => { selectedDate = dateKey; openEventModal(dateKey); renderCalendar(); });
    calendarGrid.appendChild(day);
  }
  renderUpcoming();
}

function renderUpcoming() {
  const upcoming = events.filter((event) => event.date >= formatDate(new Date(2025, 4, 1))).sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`)).slice(0, 3);
  upcomingList.innerHTML = upcoming.map((event) => {
    const date = new Date(`${event.date}T00:00:00`);
    return `<div class="upcoming-item"><div class="upcoming-date"><strong>${date.getDate()}</strong>${weekdays[date.getDay()]}曜日</div><div class="upcoming-info"><strong>${event.title}</strong><span>${event.time} · ${event.category === 'study' ? '勉強' : event.category === 'club' ? '部活' : event.category === 'food' ? 'ごはん' : '遊び'}</span></div></div>`;
  }).join('');
}

function openEventModal(date = selectedDate) { modal.hidden = false; eventDate.value = date; document.querySelector('#eventTitle').focus(); }
document.querySelector('#openModal').addEventListener('click', () => openEventModal());
document.querySelector('#closeModal').addEventListener('click', () => { modal.hidden = true; });
modal.addEventListener('click', (event) => { if (event.target === modal) modal.hidden = true; });
document.querySelector('#prevMonth').addEventListener('click', () => { viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1); renderCalendar(); });
document.querySelector('#nextMonth').addEventListener('click', () => { viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1); renderCalendar(); });
document.querySelector('#todayButton').addEventListener('click', () => { viewDate = new Date(2025, 4, 1); renderCalendar(); });
eventForm.addEventListener('submit', (event) => { event.preventDefault(); events.push({ date: eventDate.value, time: document.querySelector('#eventTime').value || '終日', title: document.querySelector('#eventTitle').value, category: document.querySelector('#eventCategory').value }); selectedDate = eventDate.value; viewDate = new Date(`${selectedDate}T00:00:00`); viewDate.setDate(1); modal.hidden = true; eventForm.reset(); renderCalendar(); });
renderCalendar();