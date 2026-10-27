'use strict';

/** "2027-02-20" -> "Saturday, 20 February 2027" (date-only values are treated as calendar dates, not instants). */
function longDate(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
}

function shortDate(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
}

/** "18:30" -> "6:30 PM" */
function time12(hhmm) {
  const [h, m] = String(hhmm || '18:00').split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** 90 -> "90 min", 120 -> "2 hr", 150 -> "2 hr 30 min" */
function duration(minutes) {
  const m = Number(minutes) || 0;
  if (m < 120 && m % 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} hr ${m % 60} min` : `${h} hr`;
}

/** ("18:15", 90) -> "6:15 PM – 7:45 PM" (wraps past midnight). */
function timeRange(start, minutes) {
  const [h, m] = String(start || '18:00').split(':').map(Number);
  const end = (h * 60 + m + (Number(minutes) || 0)) % (24 * 60);
  return `${time12(start)} – ${time12(`${Math.floor(end / 60)}:${String(end % 60).padStart(2, '0')}`)}`;
}

/** "Meraj Ahmed" -> "Meraj A." – the only form of a guest's or reviewer's name shown to others. */
function displayName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0] || 'Guest';
}

/** "Meraj Ahmed" -> "MA" */
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

module.exports = { longDate, shortDate, time12, duration, timeRange, displayName, initials };
