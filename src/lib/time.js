'use strict';
// Time zone helpers built on Intl (no libraries).

function parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
  return out;
}

// "YYYY-MM-DD HH:MM" in the given zone (used for display and CSV export).
function formatDateTime(iso, timeZone) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = parts(d, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function formatDate(iso, timeZone) {
  return formatDateTime(iso, timeZone).slice(0, 10);
}

// "Nov 18, 2026" in the given zone (friendly display; CSV export keeps the ISO-style formats).
function formatDateFriendly(iso, timeZone) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

function todayIn(timeZone, now = new Date()) {
  const p = parts(now, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

// Offset (ms) of `timeZone` from UTC at instant `date`.
function offsetAt(date, timeZone) {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// UTC instant for local midnight of `ymd` (YYYY-MM-DD) in `timeZone`.
function zonedMidnightUtc(ymd, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(guess)) return null;
  let t = guess - offsetAt(new Date(guess), timeZone);
  t = guess - offsetAt(new Date(t), timeZone); // second pass settles DST edges
  return new Date(t);
}

function isValidYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function daysSince(iso, now = new Date()) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86400000));
}

module.exports = { formatDateTime, formatDate, formatDateFriendly, todayIn, zonedMidnightUtc, isValidYmd, daysSince };
