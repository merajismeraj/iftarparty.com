'use strict';
/**
 * Booking sessions. A host books one of three time-boxed sessions; each shows only its own menus:
 *   iftar        Iftar only      – starts 20 min before Maghrib, runs the platform's included time
 *   iftar_dinner Iftar & Dinner  – Iftar start through the end of the venue's dinner service (combo menus)
 *   dinner       Dinner only     – the venue's own dinner start and length
 * Times are minutes after local midnight; a dinner that runs past midnight simply exceeds 1440.
 * Two sessions on the same night are allowed when their windows (including any extra time) do not overlap.
 */
const sunset = require('./sunset');

const SESSIONS = [
  { key: 'iftar', label: 'Iftar only', meal: 'iftar', blurb: 'Break the fast together' },
  { key: 'iftar_dinner', label: 'Iftar & Dinner', meal: 'combo', blurb: 'From Iftar straight through dinner' },
  { key: 'dinner', label: 'Dinner only', meal: 'dinner', blurb: 'A relaxed dinner after Taraweeh' },
];
const BY_KEY = new Map(SESSIONS.map((s) => [s.key, s]));
const MEALS = [['iftar', 'Iftar'], ['dinner', 'Dinner'], ['combo', 'Iftar & Dinner combo']];
const MEAL_KEYS = MEALS.map(([k]) => k);
const IFTAR_LEAD = 20; // guests arrive this many minutes before Maghrib
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const toHHMM = (min) => { const m = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

function isSession(key) { return BY_KEY.has(key); }
function get(key) { return BY_KEY.get(key) || BY_KEY.get('iftar'); }
function mealLabel(meal) { return (MEALS.find(([k]) => k === meal) || MEALS[0])[1]; }
function normalizeMeal(v) { return MEAL_KEYS.includes(v) ? v : 'iftar'; }

/** Dinner start as minutes; early-morning starts (before noon) belong to the same night, after midnight. */
function dinnerStartMin(venue) {
  const s = TIME_RE.test(venue.dinner_start || '') ? venue.dinner_start : '21:30';
  const m = toMin(s);
  return m < 12 * 60 ? m + 1440 : m;
}

/**
 * The three session windows for a venue on a date: { key, label, meal, start (HH:MM), startMin, minutes, maghrib }.
 * includedMinutes is the platform's included time, used for Iftar only.
 */
function windows(venue, city, date, includedMinutes) {
  const maghrib = sunset.maghrib(date, city);
  const iftarStart = Math.floor((maghrib - IFTAR_LEAD) / 5) * 5;
  const dStart = dinnerStartMin(venue);
  const dMinutes = Number(venue.dinner_minutes) > 0 ? Number(venue.dinner_minutes) : 120;
  const comboMinutes = Math.max(includedMinutes, dStart + dMinutes - iftarStart);
  const span = { iftar: [iftarStart, includedMinutes], iftar_dinner: [iftarStart, comboMinutes], dinner: [dStart, dMinutes] };
  return SESSIONS.map((s) => ({ ...s, startMin: span[s.key][0], start: toHHMM(span[s.key][0]), minutes: span[s.key][1], maghrib: toHHMM(maghrib) }));
}

/** [start, end) of an existing booking, in minutes after midnight of its event date. */
function interval(b) {
  let start = toMin(TIME_RE.test(b.arrival_time || '') ? b.arrival_time : '18:00');
  if (b.session === 'dinner' && start < 12 * 60) start += 1440;
  return [start, start + (Number(b.duration_minutes) || 0)];
}

const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];

/** Active (confirmed or still-held) bookings for a venue on a date. */
async function activeBookings(db, venueId, date) {
  return await db.prepare(
    `SELECT b.*, u.name AS host_name FROM bookings b JOIN users u ON u.id = b.host_id
     WHERE b.venue_id = ? AND b.event_date = ?
       AND (b.status = 'confirmed' OR (b.status = 'pending_payment' AND b.hold_expires_at > ?))
     ORDER BY b.id`
  ).all(venueId, date, new Date().toISOString());
}

/** The first active booking whose time overlaps [startMin, startMin + minutes), ignoring exceptId. */
function clash(bookings, startMin, minutes, exceptId) {
  const want = [startMin, startMin + minutes];
  return bookings.find((b) => b.id !== exceptId && overlaps(want, interval(b))) || null;
}

/** Restaurant-local "now" as { date: YYYY-MM-DD, min } in Indian Standard Time. */
function nowIST(now = Date.now()) {
  const d = new Date(now + 330 * 60_000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/**
 * Per-session availability for a venue on a date. `meals` is the set of meal types the restaurant offers
 * (a session without a matching active menu is not offered).
 */
async function availability(db, venue, date, { includedMinutes, meals }) {
  const booked = await activeBookings(db, venue.id, date);
  const now = nowIST();
  return windows(venue, venue.city, date, includedMinutes).map((w) => {
    const offered = meals.has(w.meal);
    const started = date < now.date || (date === now.date && w.startMin <= now.min);
    const b = offered && !started ? clash(booked, w.startMin, w.minutes) : null;
    let reason = null;
    if (!offered) reason = 'Not offered here';
    else if (started) reason = 'Already started';
    else if (b) reason = b.status === 'confirmed' ? `Reserved · ${b.title}` : 'On hold – payment in progress';
    return { ...w, offered, available: offered && !started && !b, reason };
  });
}

module.exports = {
  SESSIONS, MEALS, MEAL_KEYS, IFTAR_LEAD, isSession, get, mealLabel, normalizeMeal,
  windows, interval, clash, activeBookings, availability, nowIST, toMin, toHHMM,
};
