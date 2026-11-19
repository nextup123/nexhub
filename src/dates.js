'use strict';

// Calendar days are plain 'YYYY-MM-DD' strings in the company's time zone (Asia/Kolkata by
// default), so "today" is the same for everyone in the factory whatever the server's clock says.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function todayIn(tz, at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
/** Minutes since midnight in the company's time zone. */
function minutesIn(tz, at = new Date()) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).split(':').map(Number);
  return h * 60 + m;
}
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 0 = Sunday … 6 = Saturday */
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
function eachDay(from, to, max = 400) {
  const out = [];
  for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

module.exports = { isDate, todayIn, minutesIn, addDays, weekday, eachDay, monthRange };
