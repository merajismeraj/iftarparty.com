'use strict';
/**
 * Budget/tier packages. A package is a menu (kind = 'package') with a per-guest price and
 * per-course quotas – e.g. Gold ₹950: choose 3 starters, 2 mains, 1 dessert – over an
 * eligible list of the restaurant's dishes. Premium dishes can be limited to higher tiers
 * simply by leaving them out of the cheaper packages.
 */
const { BookingError, todayISO } = require('./bookings');
const settings = require('./settings');

const COURSES = [
  ['openers', 'Iftar openers'],
  ['starters', 'Starters'],
  ['mains', 'Mains & curries'],
  ['rice', 'Biryani & rice'],
  ['breads', 'Breads'],
  ['desserts', 'Desserts'],
  ['beverages', 'Beverages'],
];
const COURSE_KEYS = COURSES.map(([k]) => k);
const NOUNS = {
  openers: ['opener', 'openers'], starters: ['starter', 'starters'], mains: ['main', 'mains'], rice: ['biryani/rice', 'biryani/rice'],
  breads: ['bread', 'breads'], desserts: ['dessert', 'desserts'], beverages: ['drink', 'drinks'],
};
/** "3 starters", "1 dessert" */
const countOf = (course, n) => `${n} ${(NOUNS[course] || [course, course])[n === 1 ? 0 : 1]}`;
const courseLabel = (k) => (COURSES.find(([key]) => key === k) || [k, k])[1];

/** Hosts may change their dish picks until this many days before the Iftar. */
const EDIT_CUTOFF_DAYS = 2;

/** Rules for one package with the currently-active eligible dishes per course. */
async function load(db, menuId) {
  const rules = await db.prepare('SELECT course, choose FROM menu_rules WHERE menu_id = ?').all(menuId);
  const dishes = await db.prepare(
    `SELECT d.* FROM menu_dishes md JOIN dishes d ON d.id = md.dish_id
     WHERE md.menu_id = ? AND d.active = 1 ORDER BY d.diet DESC, d.name`
  ).all(menuId);
  return rules
    .sort((a, b) => COURSE_KEYS.indexOf(a.course) - COURSE_KEYS.indexOf(b.course))
    .map((r) => ({ ...r, label: courseLabel(r.course), dishes: dishes.filter((d) => d.course === r.course) }))
    .filter((r) => r.dishes.length);
}

/** Most dishes a host can pick in this package right now (quota capped by available dishes). */
function maxPicks(rules) {
  return rules.reduce((sum, r) => sum + Math.min(r.choose, r.dishes.length), 0);
}

/** "Choose 3 starters · 2 mains & curries · 1 dessert" */
function summary(rules) {
  return rules.map((r) => countOf(r.course, r.choose)).join(' · ');
}

/**
 * Check a host's picks against a package: every dish must be eligible and active, and each
 * course needs at least 1 and at most its quota. Returns the dish rows to snapshot.
 */
async function validateSelection(db, menu, rawIds) {
  const rules = await load(db, menu.id);
  const ids = [...new Set([].concat(rawIds || []).map(Number).filter(Number.isInteger))];
  const eligible = new Map(rules.flatMap((r) => r.dishes.map((d) => [d.id, d])));
  const picked = ids.map((id) => eligible.get(id));
  if (picked.some((d) => !d)) throw new BookingError(`One of the dishes you picked isn’t part of the ${menu.name} package any more. Please review your selection.`);
  const min = await settings.minPackageDishes(db);
  if (picked.length < min) {
    throw new BookingError(`Please pick at least ${min} dishes in total for the ${menu.name} – you picked ${picked.length}.`);
  }
  for (const r of rules) {
    const n = picked.filter((d) => d.course === r.course).length;
    if (n === 0) throw new BookingError(`Please choose your ${r.label.toLowerCase()} for the ${menu.name} (up to ${r.choose}).`);
    if (n > r.choose) throw new BookingError(`The ${menu.name} includes ${countOf(r.course, r.choose)} – you picked ${n}.`);
  }
  return picked;
}

async function saveSelection(db, bookingId, dishes) {
  await db.prepare('DELETE FROM booking_dishes WHERE booking_id = ?').run(bookingId);
  const ins = db.prepare('INSERT INTO booking_dishes (booking_id, dish_id, name, course, diet) VALUES (?, ?, ?, ?, ?)');
  for (const d of dishes) await ins.run(bookingId, d.id, d.name, d.course, d.diet);
}

/** A booking's dish picks grouped by course, in serving order. */
async function bookingSelection(db, bookingId) {
  const rows = await db.prepare('SELECT * FROM booking_dishes WHERE booking_id = ? ORDER BY id').all(bookingId);
  return COURSES.map(([course, label]) => ({ course, label, dishes: rows.filter((r) => r.course === course) }))
    .filter((g) => g.dishes.length);
}

function canEditSelection(booking) {
  if (booking.status !== 'confirmed' && booking.status !== 'pending_payment') return false;
  const cutoff = new Date(`${booking.event_date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - EDIT_CUTOFF_DAYS);
  return todayISO() <= cutoff.toISOString().slice(0, 10);
}

/**
 * Parse the restaurant's package definition from the menu form:
 * choose_<course> = quota, dishes_<course> = eligible dish ids. Returns { rules, dishIds, errors }.
 */
async function parseDefinition(db, restaurantId, body) {
  const own = new Map((await db.prepare('SELECT * FROM dishes WHERE restaurant_id = ?').all(restaurantId)).map((d) => [d.id, d]));
  const rules = [];
  const dishIds = [];
  const errors = [];
  for (const [course, label] of COURSES) {
    const choose = Number.parseInt(body[`choose_${course}`], 10) || 0;
    const ids = [...new Set([].concat(body[`dishes_${course}`] || []).map(Number))].filter((id) => own.get(id)?.course === course);
    if (choose < 1) continue;
    if (choose > 20) errors.push(`${label}: choose at most 20.`);
    if (ids.length < choose) errors.push(`${label}: tick at least ${choose} eligible dish${choose === 1 ? '' : 'es'} for guests to choose from.`);
    rules.push({ course, choose: Math.min(choose, 20) });
    dishIds.push(...ids);
  }
  if (!rules.length) errors.push('Set how many dishes guests choose in at least one course (e.g. 3 starters).');
  const min = await settings.minPackageDishes(db);
  const total = rules.reduce((sum, r) => sum + r.choose, 0);
  if (rules.length && total < min) {
    errors.push(`Hosts must pick at least ${min} dishes in total, but this package only allows ${total}. Raise the course limits.`);
  }
  return { rules, dishIds, errors };
}

async function saveDefinition(db, menuId, { rules, dishIds }) {
  await db.prepare('DELETE FROM menu_rules WHERE menu_id = ?').run(menuId);
  await db.prepare('DELETE FROM menu_dishes WHERE menu_id = ?').run(menuId);
  const r = db.prepare('INSERT INTO menu_rules (menu_id, course, choose) VALUES (?, ?, ?)');
  for (const x of rules) await r.run(menuId, x.course, x.choose);
  const d = db.prepare('INSERT INTO menu_dishes (menu_id, dish_id) VALUES (?, ?)');
  for (const id of dishIds) await d.run(menuId, id);
}

/** Current definition in form shape, for editing. */
async function definitionForForm(db, menuId) {
  const out = {};
  (await db.prepare('SELECT course, choose FROM menu_rules WHERE menu_id = ?').all(menuId)).forEach((r) => { out[`choose_${r.course}`] = r.choose; });
  (await db.prepare('SELECT d.id, d.course FROM menu_dishes md JOIN dishes d ON d.id = md.dish_id WHERE md.menu_id = ?').all(menuId))
    .forEach((d) => { (out[`dishes_${d.course}`] ||= []).push(d.id); });
  return out;
}

module.exports = {
  COURSES, COURSE_KEYS, courseLabel, countOf, EDIT_CUTOFF_DAYS, load, maxPicks, summary, validateSelection, saveSelection,
  bookingSelection, canEditSelection, parseDefinition, saveDefinition, definitionForForm,
};
