'use strict';
const config = require('../config');
const { transaction } = require('../db');
const pricing = require('./pricing');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

class BookingError extends Error {}

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isValidDate(s) {
  if (!DATE_RE.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Release venue holds whose payment window has lapsed. */
function expireStaleHolds(db) {
  db.prepare(
    `UPDATE bookings SET status = 'expired'
     WHERE status = 'pending_payment' AND hold_expires_at <= ?`
  ).run(new Date().toISOString());
}

/** The booking (confirmed, or still-held) occupying a venue on a date, if any. */
function blockingBooking(db, venueId, date) {
  return db
    .prepare(
      `SELECT b.*, u.name AS host_name FROM bookings b JOIN users u ON u.id = b.host_id
       WHERE b.venue_id = ? AND b.event_date = ?
         AND (b.status = 'confirmed' OR (b.status = 'pending_payment' AND b.hold_expires_at > ?))
       LIMIT 1`
    )
    .get(venueId, date, new Date().toISOString());
}

/** Upcoming confirmed reservations for a venue, labelled "Iftar Party by <host>". */
function upcomingReservations(db, venueId) {
  return db
    .prepare(
      `SELECT b.event_date, b.title FROM bookings b
       WHERE b.venue_id = ? AND b.status = 'confirmed' AND b.event_date >= ?
       ORDER BY b.event_date LIMIT 60`
    )
    .all(venueId, todayISO());
}

function partyTitle(hostName) {
  return `Iftar Party by ${String(hostName).trim()}`;
}

/**
 * Validate a reservation request and place a time-limited hold on the venue.
 * Runs in a single synchronous transaction, so two hosts cannot hold the same night.
 */
function createHold(db, { venueId, menuId, hostId, eventDate, guestCount, arrivalTime }) {
  const guests = Number.parseInt(guestCount, 10);
  if (!isValidDate(eventDate)) throw new BookingError('Please choose a valid date.');
  if (eventDate < todayISO()) throw new BookingError('Please choose a date in the future.');
  if (!Number.isInteger(guests) || guests < 1) throw new BookingError('Please enter the number of guests.');
  const time = TIME_RE.test(arrivalTime || '') ? arrivalTime : '18:00';

  return transaction(db, () => {
    expireStaleHolds(db);
    const venue = db.prepare('SELECT * FROM venues WHERE id = ? AND active = 1').get(venueId);
    if (!venue) throw new BookingError('This venue is no longer available.');
    const menu = db
      .prepare('SELECT * FROM menus WHERE id = ? AND restaurant_id = ? AND active = 1')
      .get(menuId, venue.restaurant_id);
    if (!menu) throw new BookingError('Please choose a menu offered by this restaurant.');
    if (guests < venue.min_pax || guests > venue.max_pax) {
      throw new BookingError(`${venue.name} hosts between ${venue.min_pax} and ${venue.max_pax} guests.`);
    }
    if (guests < menu.min_pax) throw new BookingError(`The ${menu.name} menu needs at least ${menu.min_pax} guests.`);
    if (blockingBooking(db, venue.id, eventDate)) {
      throw new BookingError('Sorry, this venue is already reserved for that evening. Please pick another date.');
    }

    const host = db.prepare('SELECT name FROM users WHERE id = ?').get(hostId);
    const q = pricing.quote({ pricePerPerson: menu.price_per_person, guestCount: guests, hireFee: venue.hire_fee });
    const holdExpires = new Date(Date.now() + config.holdMinutes * 60_000).toISOString();
    const info = db
      .prepare(
        `INSERT INTO bookings (venue_id, menu_id, host_id, event_date, arrival_time, guest_count, title,
           price_per_person, food_total, hire_fee, platform_fee, total_amount, currency, hold_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(venue.id, menu.id, hostId, eventDate, time, guests, partyTitle(host.name),
        q.pricePerPerson, q.foodTotal, q.hireFee, q.platformFee, q.total, config.currency, holdExpires);
    return Number(info.lastInsertRowid);
  });
}

/**
 * Mark a booking paid. Idempotent. Returns { ok, conflict }.
 * conflict=true means payment landed after the hold lapsed and someone else took the night.
 */
function confirmPayment(db, bookingId, { provider, ref }) {
  return transaction(db, () => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!b) throw new BookingError('Booking not found.');
    if (b.status === 'confirmed') return { ok: true, conflict: false };
    if (b.status === 'cancelled') return { ok: false, conflict: false };
    const other = blockingBooking(db, b.venue_id, b.event_date);
    if (other && other.id !== b.id) {
      db.prepare(`UPDATE bookings SET status = 'cancelled', payment_provider = ?, payment_ref = ? WHERE id = ?`)
        .run(provider, ref, b.id);
      console.error(`[booking ${b.id}] paid after hold lapsed and night was taken – refund ${ref} via ${provider}`);
      return { ok: false, conflict: true };
    }
    db.prepare(
      `UPDATE bookings SET status = 'confirmed', payment_provider = ?, payment_ref = ?, paid_at = datetime('now')
       WHERE id = ?`
    ).run(provider, ref, b.id);
    return { ok: true, conflict: false };
  });
}

/** Full booking with venue, restaurant and menu details. */
function getDetailed(db, bookingId) {
  return db
    .prepare(
      `SELECT b.*, v.name AS venue_name, v.restaurant_id, r.name AS restaurant_name, r.address, r.area, r.city,
              r.phone AS restaurant_phone, m.name AS menu_name, m.items AS menu_items, m.diet,
              u.name AS host_name, u.email AS host_email, u.phone AS host_phone,
              (SELECT filename FROM venue_images WHERE venue_id = v.id ORDER BY sort_order, id LIMIT 1) AS image
       FROM bookings b
       JOIN venues v ON v.id = b.venue_id
       JOIN restaurants r ON r.id = v.restaurant_id
       JOIN menus m ON m.id = b.menu_id
       JOIN users u ON u.id = b.host_id
       WHERE b.id = ?`
    )
    .get(bookingId);
}

function rsvpSummary(db, bookingId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS invited,
              COALESCE(SUM(rsvp_status = 'yes'), 0) AS yes,
              COALESCE(SUM(rsvp_status = 'no'), 0) AS no,
              COALESCE(SUM(rsvp_status = 'maybe'), 0) AS maybe,
              COALESCE(SUM(rsvp_status = 'pending'), 0) AS pending,
              COALESCE(SUM(CASE WHEN rsvp_status = 'yes' THEN party_size ELSE 0 END), 0) AS headcount
       FROM guests WHERE booking_id = ?`
    )
    .get(bookingId);
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}

module.exports = {
  BookingError, todayISO, isValidDate, expireStaleHolds, blockingBooking, upcomingReservations,
  partyTitle, createHold, confirmPayment, getDetailed, rsvpSummary,
};
