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

module.exports = { longDate, shortDate, time12 };
