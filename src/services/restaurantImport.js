'use strict';
/**
 * Admin bulk upload of restaurants from a CSV sheet.
 *
 * One row = one restaurant, optionally with a venue and/or a set menu. Repeat the owner_email on
 * further rows to add more venues or menus to the same restaurant. If the email already belongs to
 * a restaurant partner, the rows add to their existing restaurant. Owners sign in with Google
 * using that email (no password is created).
 *
 * The import is all-or-nothing: any row error and nothing is written.
 */
const { parse } = require('csv-parse/sync');
const { transaction } = require('../db');
const money = require('./money');
const { normalizeEmail, normalizePhone } = require('./guestlist');

const COLUMNS = [
  'restaurant_name', 'owner_name', 'owner_email', 'owner_phone', 'city', 'area', 'address', 'cuisine', 'description',
  'venue_name', 'venue_min_pax', 'venue_max_pax', 'venue_hire_fee', 'venue_extra_time_fee', 'venue_amenities', 'venue_description',
  'menu_name', 'menu_price_per_person', 'menu_min_pax', 'menu_diet', 'menu_items',
];
const REQUIRED = ['restaurant_name', 'owner_name', 'owner_email', 'owner_phone', 'city'];
const DIETS = ['veg', 'non-veg', 'mixed'];
const MAX_ROWS = 500;

const SAMPLE = [
  ['Noor Kitchen', 'Ayesha Khan', 'ayesha@noorkitchen.in', '9876543210', 'Hyderabad', 'Banjara Hills', 'Road No. 12, Banjara Hills', 'Hyderabadi, Mughlai', 'Family-run since 1998.',
    'Rooftop Lounge', '20', '80', '5000', '1500', 'Open air|Prayer area', 'Sunset views over the lake.',
    'Royal Iftar Platter', '899', '20', 'non-veg', 'Dates & Rooh Afza|Fruit chaat|Chicken haleem|Mutton biryani|Phirni'],
  ['Noor Kitchen', 'Ayesha Khan', 'ayesha@noorkitchen.in', '9876543210', 'Hyderabad', '', '', '', '',
    'Banquet Hall', '50', '200', '15000', '3000', 'Air-conditioned|Valet parking', '',
    'Veg Iftar Thali', '599', '20', 'veg', 'Dates|Fruit chaat|Veg haleem|Veg biryani|Sheer khurma'],
  ['Al Madina Grill', 'Imran Shaikh', 'imran@almadina.in', '+91 98200 11223', 'Mumbai', 'Mohammed Ali Road', '', 'Mughlai, Grill', '',
    'Main Dining', '15', '60', '0', '0', 'Air-conditioned', '',
    '', '', '', '', ''],
];

const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const templateCsv = () => `${[COLUMNS, ...SAMPLE].map((r) => r.map(cell).join(',')).join('\n')}\n`;

const text = (v, max) => String(v ?? '').trim().slice(0, max);
const int = (v) => (/^\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : NaN);
const list = (v) => text(v, 4000).split('|').map((s) => s.trim()).filter(Boolean);

/** Parse + validate a CSV buffer. Returns { restaurants, errors, rowCount } without touching the database. */
function parseSheet(buffer) {
  let records;
  try {
    records = parse(buffer, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  } catch (err) {
    return { restaurants: [], errors: [{ line: 0, reason: `Could not read the file as CSV: ${err.message}` }], rowCount: 0 };
  }
  if (!records.length) return { restaurants: [], errors: [{ line: 0, reason: 'The file is empty.' }], rowCount: 0 };
  const header = records[0].map((h) => String(h).trim().toLowerCase().replace(/\*$/, '').replace(/\s+/g, '_'));
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) return { restaurants: [], errors: [{ line: 1, reason: `Missing column(s): ${missing.join(', ')}. Start from the sample sheet.` }], rowCount: 0 };
  const rows = records.slice(1);
  if (rows.length > MAX_ROWS) return { restaurants: [], errors: [{ line: 0, reason: `Too many rows (${rows.length}). Upload at most ${MAX_ROWS} at a time.` }], rowCount: rows.length };

  const errors = [];
  const byEmail = new Map();
  rows.forEach((cells, i) => {
    const line = i + 2;
    const r = Object.fromEntries(header.map((h, j) => [h, cells[j] ?? '']));
    const bad = (reason) => errors.push({ line, reason });
    const email = normalizeEmail(r.owner_email);
    const phone = normalizePhone(r.owner_phone);
    if (!text(r.restaurant_name, 120)) bad('restaurant_name is required.');
    if (!text(r.owner_name, 120)) bad('owner_name is required.');
    if (!email) bad(`owner_email “${text(r.owner_email, 80)}” is not a valid email.`);
    if (!phone) bad(`owner_phone “${text(r.owner_phone, 30)}” is not a valid mobile number.`);
    if (!text(r.city, 80)) bad('city is required.');
    if (!email) return;

    let rest = byEmail.get(email);
    if (!rest) {
      rest = {
        email, line, phone,
        owner: text(r.owner_name, 120), name: text(r.restaurant_name, 120), city: text(r.city, 80), area: text(r.area, 80),
        address: text(r.address, 300), cuisine: text(r.cuisine, 120), description: text(r.description, 1000),
        venues: [], menus: [],
      };
      byEmail.set(email, rest);
    } else if (text(r.restaurant_name, 120) && text(r.restaurant_name, 120).toLowerCase() !== rest.name.toLowerCase()) {
      bad(`${email} is already used for “${rest.name}” on line ${rest.line}; one owner email = one restaurant.`);
    }

    if (text(r.venue_name, 120)) {
      const v = {
        name: text(r.venue_name, 120), min_pax: int(r.venue_min_pax), max_pax: int(r.venue_max_pax),
        hire_fee: r.venue_hire_fee ? money.toMinor(r.venue_hire_fee) : 0,
        extra_time_fee: r.venue_extra_time_fee ? money.toMinor(r.venue_extra_time_fee) : 0,
        amenities: list(r.venue_amenities).join(', ').slice(0, 500), description: text(r.venue_description, 1000),
      };
      if (!(v.min_pax >= 1)) bad('venue_min_pax must be a whole number of at least 1.');
      else if (!(v.max_pax >= v.min_pax)) bad('venue_max_pax must be a whole number at least venue_min_pax.');
      if (!Number.isFinite(v.hire_fee)) bad('venue_hire_fee must be an amount (0 if included).');
      if (!Number.isFinite(v.extra_time_fee)) bad('venue_extra_time_fee must be an amount (0 if extra time isn’t offered).');
      if (rest.venues.some((x) => x.name.toLowerCase() === v.name.toLowerCase())) bad(`Venue “${v.name}” appears twice for ${email}.`);
      rest.venues.push(v);
    } else if (['venue_min_pax', 'venue_max_pax', 'venue_hire_fee'].some((c) => text(r[c], 20))) {
      bad('venue_name is required when venue details are filled in.');
    }

    if (text(r.menu_name, 120)) {
      const diet = text(r.menu_diet, 20).toLowerCase() || 'non-veg';
      const m = {
        name: text(r.menu_name, 120), price_per_person: money.toMinor(r.menu_price_per_person),
        min_pax: r.menu_min_pax ? int(r.menu_min_pax) : 1, diet, items: list(r.menu_items).join('\n'),
      };
      if (!(m.price_per_person > 0)) bad('menu_price_per_person must be more than 0.');
      if (!(m.min_pax >= 1)) bad('menu_min_pax must be a whole number of at least 1.');
      if (!DIETS.includes(diet)) bad('menu_diet must be veg, non-veg or mixed.');
      if (!m.items) bad('menu_items is required: dishes separated by |.');
      if (rest.menus.some((x) => x.name.toLowerCase() === m.name.toLowerCase())) bad(`Menu “${m.name}” appears twice for ${email}.`);
      rest.menus.push(m);
    } else if (['menu_price_per_person', 'menu_items'].some((c) => text(r[c], 20))) {
      bad('menu_name is required when menu details are filled in.');
    }
  });
  return { restaurants: [...byEmail.values()], errors, rowCount: rows.length };
}

/**
 * Check against the database (existing owners) and, unless dryRun, write everything in one transaction.
 * Returns { created, extended, venues, menus, errors, plan }.
 */
async function importSheet(db, buffer, { status = 'approved', dryRun = false } = {}) {
  const { restaurants, errors, rowCount } = parseSheet(buffer);
  const plan = [];
  for (const r of restaurants) {
    const user = await db.prepare('SELECT u.id, u.role, r.id AS restaurant_id, r.name AS restaurant FROM users u LEFT JOIN restaurants r ON r.owner_id = u.id WHERE lower(u.email) = ?').get(r.email);
    if (user && (user.role !== 'restaurant' || !user.restaurant_id)) {
      errors.push({ line: r.line, reason: `${r.email} is already registered as ${user.role === 'admin' ? 'an admin' : 'a host'}; use a different owner email.` });
      continue;
    }
    if (user) {
      const taken = new Set((await db.prepare('SELECT lower(name) AS n FROM venues WHERE restaurant_id = ?').all(user.restaurant_id)).map((x) => x.n));
      for (const v of r.venues) if (taken.has(v.name.toLowerCase())) errors.push({ line: r.line, reason: `${user.restaurant} already has a venue called “${v.name}”.` });
      const menus = new Set((await db.prepare('SELECT lower(name) AS n FROM menus WHERE restaurant_id = ?').all(user.restaurant_id)).map((x) => x.n));
      for (const m of r.menus) if (menus.has(m.name.toLowerCase())) errors.push({ line: r.line, reason: `${user.restaurant} already has a menu called “${m.name}”.` });
    }
    plan.push({ ...r, existing: user ? { userId: user.id, restaurantId: user.restaurant_id, name: user.restaurant } : null });
  }
  errors.sort((a, b) => a.line - b.line);
  const summary = {
    rowCount, plan, errors,
    created: plan.filter((p) => !p.existing).length, extended: plan.filter((p) => p.existing).length,
    venues: plan.reduce((n, p) => n + p.venues.length, 0), menus: plan.reduce((n, p) => n + p.menus.length, 0),
  };
  if (dryRun || errors.length || !plan.length) return summary;

  await transaction(db, async () => {
    for (const p of plan) {
      let restaurantId = p.existing?.restaurantId;
      if (!restaurantId) {
        const userId = Number((await db.prepare("INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, '', 'restaurant')")
          .run(p.owner, p.email, p.phone)).lastInsertRowid);
        restaurantId = Number((await db.prepare('INSERT INTO restaurants (owner_id, name, description, cuisine, address, area, city, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(userId, p.name, p.description, p.cuisine, p.address, p.area, p.city, p.phone, status)).lastInsertRowid);
      }
      for (const v of p.venues) {
        await db.prepare('INSERT INTO venues (restaurant_id, name, description, amenities, min_pax, max_pax, hire_fee, extra_time_fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(restaurantId, v.name, v.description, v.amenities, v.min_pax, v.max_pax, v.hire_fee, v.extra_time_fee);
      }
      for (const m of p.menus) {
        await db.prepare("INSERT INTO menus (restaurant_id, kind, name, items, diet, price_per_person, min_pax) VALUES (?, 'set', ?, ?, ?, ?, ?)")
          .run(restaurantId, m.name, m.items, m.diet, m.price_per_person, m.min_pax);
      }
    }
  });
  return summary;
}

module.exports = { importSheet, parseSheet, templateCsv, COLUMNS, REQUIRED, MAX_ROWS };
