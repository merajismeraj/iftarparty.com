'use strict';
const express = require('express');
const money = require('../services/money');
const reviews = require('../services/reviews');
const packages = require('../services/packages');
const pricing = require('../services/pricing');
const settings = require('../services/settings');
const { isValidDate, todayISO, blockingBooking, upcomingReservations, expireStaleHolds } = require('../services/bookings');

const PAGE_SIZE = 12;
const SORTS = {
  price: 'from_price ASC',
  price_desc: 'from_price DESC',
  capacity: 'v.max_pax DESC',
  newest: 'v.id DESC',
  rating: 'rating IS NULL, rating DESC, review_count DESC',
};

/** Venue search across location, menu, price, capacity and date availability. */
function searchVenues(db, q, feePercent = 0) {
  const where = ['v.active = 1', 'm.active = 1', `r.status = 'approved'`];
  const params = [];
  const like = (s) => `%${String(s).trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  if (q.location?.trim()) {
    where.push(`(r.city LIKE ? ESCAPE '\\' OR r.area LIKE ? ESCAPE '\\' OR r.address LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')`);
    params.push(...Array(4).fill(like(q.location)));
  }
  if (q.menu?.trim()) {
    // Matches set-menu text and the dishes offered inside packages.
    where.push(`(m.name LIKE ? ESCAPE '\\' OR m.items LIKE ? ESCAPE '\\' OR m.description LIKE ? ESCAPE '\\' OR r.cuisine LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM menu_dishes md JOIN dishes d ON d.id = md.dish_id
                 WHERE md.menu_id = m.id AND d.active = 1 AND d.name LIKE ? ESCAPE '\\'))`);
    params.push(...Array(5).fill(like(q.menu)));
  }
  if (['veg', 'non-veg', 'mixed'].includes(q.diet)) {
    where.push('m.diet = ?');
    params.push(q.diet);
  }
  const guests = Number.parseInt(q.guests, 10);
  if (guests > 0) {
    where.push('v.min_pax <= ? AND v.max_pax >= ? AND m.min_pax <= ?');
    params.push(guests, guests, guests);
  }
  const budget = pricing.parseBudget(q, money.toMinor);
  if (budget?.type === 'guest') {
    where.push('m.price_per_person <= ?');
    params.push(budget.amount);
  } else if (budget?.type === 'total' && guests > 0) {
    // Full estimate before optional extras: (food + hall) plus the platform fee.
    where.push('(m.price_per_person * ? + v.hire_fee) * (100 + ?) <= ? * 100');
    params.push(guests, feePercent, budget.amount);
  }
  if (isValidDate(q.date)) {
    where.push(`NOT EXISTS (SELECT 1 FROM bookings b WHERE b.venue_id = v.id AND b.event_date = ?
      AND (b.status = 'confirmed' OR (b.status = 'pending_payment' AND b.hold_expires_at > ?)))`);
    params.push(q.date, new Date().toISOString());
  }

  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const order = SORTS[q.sort] || SORTS.price;
  const base = `FROM venues v
    JOIN restaurants r ON r.id = v.restaurant_id
    JOIN menus m ON m.restaurant_id = r.id
    WHERE ${where.join(' AND ')}`;

  const total = db.prepare(`SELECT COUNT(DISTINCT v.id) AS n ${base}`).get(...params).n;
  const rows = db.prepare(
    `SELECT v.id, v.name, v.min_pax, v.max_pax, v.hire_fee, v.description,
            r.name AS restaurant_name, r.area, r.city, r.cuisine,
            MIN(m.price_per_person) AS from_price, COUNT(DISTINCT m.id) AS menu_count,
            GROUP_CONCAT(DISTINCT m.name) AS menu_names,
            (SELECT ROUND(AVG(rv.rating), 1) FROM reviews rv WHERE rv.restaurant_id = r.id AND rv.status = 'approved') AS rating,
            (SELECT COUNT(*) FROM reviews rv WHERE rv.restaurant_id = r.id AND rv.status = 'approved') AS review_count,
            (SELECT filename FROM venue_images vi WHERE vi.venue_id = v.id ORDER BY sort_order, id LIMIT 1) AS image
     ${base}
     GROUP BY v.id ORDER BY ${order}, v.id DESC LIMIT ? OFFSET ?`
  ).all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);

  const budgetNeedsGuests = budget?.type === 'total' && !(guests > 0);
  return { rows, total: Number(total), page, pages: Math.max(1, Math.ceil(Number(total) / PAGE_SIZE)), budget, budgetNeedsGuests };
}

module.exports = (db) => {
  const router = express.Router();

  router.get('/', (req, res) => {
    const featured = searchVenues(db, { sort: 'newest' }).rows.slice(0, 6);
    const cities = db.prepare(
      `SELECT r.city, COUNT(*) AS n FROM venues v JOIN restaurants r ON r.id = v.restaurant_id
       WHERE v.active = 1 AND r.status = 'approved' AND r.city <> '' GROUP BY r.city ORDER BY n DESC LIMIT 8`
    ).all();
    res.render('home', { featured, cities, today: todayISO() });
  });

  router.get('/search', (req, res) => {
    expireStaleHolds(db);
    const result = searchVenues(db, req.query, settings.feePercent(db));
    res.render('search', { title: 'Find an Iftar venue', ...result, q: req.query, today: todayISO() });
  });

  router.get('/venues/:id', (req, res) => {
    const venue = db.prepare(
      `SELECT v.*, r.name AS restaurant_name, r.description AS restaurant_description, r.cuisine, r.status AS restaurant_status,
              r.address, r.area, r.city, r.phone AS restaurant_phone
       FROM venues v JOIN restaurants r ON r.id = v.restaurant_id WHERE v.id = ?`
    ).get(req.params.id);
    const privileged = venue && (venue.restaurant_id === req.restaurant?.id || req.user?.role === 'admin');
    if (!venue || (!privileged && (!venue.active || venue.restaurant_status !== 'approved'))) {
      return res.status(404).render('error', { title: 'Venue not found', message: 'This venue is not listed any more.' });
    }
    const images = db.prepare('SELECT * FROM venue_images WHERE venue_id = ? ORDER BY sort_order, id').all(venue.id);
    const budget = pricing.parseBudget(req.query, money.toMinor);
    const guestsQ = Number.parseInt(req.query.guests, 10) || 0;
    const feePct = settings.feePercent(db);
    const minDishes = settings.minPackageDishes(db);
    const menus = db.prepare('SELECT * FROM menus WHERE restaurant_id = ? AND active = 1 ORDER BY price_per_person').all(venue.restaurant_id)
      .map((m) => {
        const rules = m.kind === 'package' ? packages.load(db, m.id) : null;
        const fit = pricing.budgetFit(budget, { pricePerPerson: m.price_per_person, guestCount: guestsQ, hireFee: venue.hire_fee, feePercent: feePct });
        return { ...m, rules, fit };
      })
      // A package whose available dishes can't reach the platform minimum can't be booked.
      .filter((m) => m.kind === 'set' || packages.maxPicks(m.rules) >= minDishes);
    const pickedDishes = new Set([].concat(req.query.dish || []).map(String));
    const addons = db.prepare(
      `SELECT * FROM addons WHERE restaurant_id = ? AND active = 1
       ORDER BY CASE category WHEN 'food' THEN 0 WHEN 'decor' THEN 1 WHEN 'service' THEN 2 ELSE 3 END, price`
    ).all(venue.restaurant_id);
    const picked = new Set([].concat(req.query.addon || []).map(String));
    const reservations = upcomingReservations(db, venue.id);
    const date = isValidDate(req.query.date) ? req.query.date : '';
    const taken = date ? blockingBooking(db, venue.id, date) : null;
    res.render('venue', {
      title: `${venue.name} at ${venue.restaurant_name}`, venue, images, menus, addons, picked, pickedDishes, reservations, budget, minDishes,
      rating: reviews.summary(db, venue.restaurant_id), reviewList: reviews.published(db, venue.restaurant_id, 20),
      form: { date, guests: req.query.guests || '', menu_id: req.query.menu || '', arrival_time: '18:00' },
      taken, today: todayISO(),
    });
  });

  /** Lightweight availability check used by the venue page date picker. */
  router.get('/api/venues/:id/availability', (req, res) => {
    const { date } = req.query;
    if (!isValidDate(date)) return res.status(400).json({ error: 'invalid date' });
    expireStaleHolds(db);
    const b = blockingBooking(db, req.params.id, date);
    res.json({ date, available: !b, label: b ? (b.status === 'confirmed' ? b.title : 'On hold – payment in progress') : null });
  });

  router.get('/guest-list-template.csv', (req, res) => {
    res.type('text/csv').attachment('iftar-guest-list.csv')
      .send('name,email,mobile\nAisha Khan,aisha@example.com,+919876543210\nOmar Siddiqui,,9876501234\nFatima Rahman,fatima@example.com,\n');
  });

  return router;
};

module.exports.searchVenues = searchVenues;
