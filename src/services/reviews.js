'use strict';
/**
 * Verified reviews: only the host of a confirmed booking whose Iftar has taken place can review,
 * once per booking. Every review (and every restaurant reply) is held for admin moderation
 * before it is shown publicly.
 */
const config = require('../config');
const notify = require('./notify');
const { todayISO } = require('./bookings');

class ReviewError extends Error {}

const SUB_RATINGS = ['food_rating', 'service_rating', 'ambience_rating'];

/** "Meraj Ahmed" -> "Meraj A." – never show a reviewer's full name publicly. */
const { displayName } = require('./format');

/** Why a host can't review this booking, or null if they can. */
function ineligibleReason(booking, hostId) {
  if (!booking || booking.host_id !== hostId) return 'You can only review your own bookings.';
  if (booking.status !== 'confirmed') return 'Only completed bookings can be reviewed.';
  if (booking.event_date >= todayISO()) return 'You can review the venue after your Iftar has taken place.';
  return null;
}

function forBooking(db, bookingId) {
  return db.prepare('SELECT * FROM reviews WHERE booking_id = ?').get(bookingId);
}

function parseRating(v, { required }) {
  const n = Number.parseInt(v, 10);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  if (required) throw new ReviewError('Please choose an overall rating from 1 to 5 stars.');
  return null;
}

/** Create or update the host's review. Any edit sends it back to the moderation queue. */
function submit(db, booking, hostId, body) {
  const reason = ineligibleReason(booking, hostId);
  if (reason) throw new ReviewError(reason);
  const text = String(body.body || '').trim();
  if (text.length < 20) throw new ReviewError('Please write at least 20 characters about your experience.');
  if (text.length > 2000) throw new ReviewError('Please keep your review under 2,000 characters.');
  const r = {
    rating: parseRating(body.rating, { required: true }),
    title: String(body.title || '').trim().slice(0, 120),
    body: text,
  };
  SUB_RATINGS.forEach((k) => { r[k] = parseRating(body[k], { required: false }); });

  const existing = forBooking(db, booking.id);
  if (existing) {
    db.prepare(
      `UPDATE reviews SET rating = ?, food_rating = ?, service_rating = ?, ambience_rating = ?, title = ?, body = ?,
         status = 'pending', moderation_note = '', moderated_at = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(r.rating, r.food_rating, r.service_rating, r.ambience_rating, r.title, r.body, existing.id);
    return { id: existing.id, updated: true, wasPublished: existing.status === 'approved' };
  }
  const id = Number(db.prepare(
    `INSERT INTO reviews (booking_id, restaurant_id, venue_id, host_id, rating, food_rating, service_rating, ambience_rating, title, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(booking.id, booking.restaurant_id, booking.venue_id, hostId, r.rating, r.food_rating, r.service_rating,
    r.ambience_rating, r.title, r.body).lastInsertRowid);
  return { id, updated: false, wasPublished: false };
}

/** Published rating summary for a restaurant. */
function summary(db, restaurantId) {
  const row = db.prepare(
    `SELECT COUNT(*) AS count, AVG(rating) AS avg, AVG(food_rating) AS food, AVG(service_rating) AS service,
            AVG(ambience_rating) AS ambience,
            SUM(rating = 5) AS r5, SUM(rating = 4) AS r4, SUM(rating = 3) AS r3, SUM(rating = 2) AS r2, SUM(rating = 1) AS r1
     FROM reviews WHERE restaurant_id = ? AND status = 'approved'`
  ).get(restaurantId);
  const out = { count: Number(row.count) };
  ['avg', 'food', 'service', 'ambience'].forEach((k) => { out[k] = row[k] == null ? null : Math.round(row[k] * 10) / 10; });
  out.distribution = [5, 4, 3, 2, 1].map((n) => ({ stars: n, count: Number(row[`r${n}`] || 0) }));
  return out;
}

function published(db, restaurantId, limit = 20) {
  return db.prepare(
    `SELECT rv.*, u.name AS host_name, v.name AS venue_name, b.event_date, b.guest_count
     FROM reviews rv JOIN users u ON u.id = rv.host_id JOIN venues v ON v.id = rv.venue_id JOIN bookings b ON b.id = rv.booking_id
     WHERE rv.restaurant_id = ? AND rv.status = 'approved'
     ORDER BY rv.created_at DESC, rv.id DESC LIMIT ?`
  ).all(restaurantId, limit).map((r) => ({ ...r, author: displayName(r.host_name) }));
}

function detailed(db, reviewId) {
  return db.prepare(
    `SELECT rv.*, u.name AS host_name, u.email AS host_email, r.name AS restaurant_name, v.name AS venue_name,
            o.email AS owner_email, b.event_date, b.title AS booking_title
     FROM reviews rv JOIN users u ON u.id = rv.host_id JOIN restaurants r ON r.id = rv.restaurant_id
     JOIN users o ON o.id = r.owner_id JOIN venues v ON v.id = rv.venue_id JOIN bookings b ON b.id = rv.booking_id
     WHERE rv.id = ?`
  ).get(reviewId);
}

const mail = (to, subject, text) => notify.sendEmail({ to, subject, text, html: `<p style="font-family:Arial,sans-serif;white-space:pre-line">${String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</p>` });

/** Approve or reject a review. Rejection requires a note, which the host sees. */
async function moderate(db, reviewId, { decision, note }) {
  const rv = detailed(db, reviewId);
  if (!rv) throw new ReviewError('Review not found.');
  if (!['approve', 'reject'].includes(decision)) throw new ReviewError('Unknown decision.');
  const clean = String(note || '').trim().slice(0, 300);
  if (decision === 'reject' && !clean) throw new ReviewError('Give the host a reason for rejecting their review.');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  db.prepare(`UPDATE reviews SET status = ?, moderation_note = ?, moderated_at = datetime('now') WHERE id = ?`).run(status, clean, rv.id);

  const venueUrl = `${config.baseUrl}/venues/${rv.venue_id}#reviews`;
  if (status === 'approved') {
    await mail(rv.host_email, 'Your review is live', `JazakAllah khair for reviewing ${rv.restaurant_name}. Your review is now published:\n${venueUrl}`);
    await mail(rv.owner_email, `New ${rv.rating}★ review for ${rv.restaurant_name}`, `A host reviewed ${rv.venue_name}. Read it and reply from your dashboard:\n${config.baseUrl}/restaurant/reviews`);
  } else {
    await mail(rv.host_email, 'Your review needs changes', `Your review of ${rv.restaurant_name} wasn't published.\nReason: ${clean}\n\nYou can edit and resubmit it here:\n${config.baseUrl}/bookings/${rv.booking_id}/review`);
  }
  return status;
}

/** Restaurant replies to a published review; the reply is moderated too. */
function submitReply(db, reviewId, restaurantId, text) {
  const rv = db.prepare('SELECT * FROM reviews WHERE id = ? AND restaurant_id = ?').get(reviewId, restaurantId);
  if (!rv) throw new ReviewError('Review not found.');
  if (rv.status !== 'approved') throw new ReviewError('You can only reply to published reviews.');
  const reply = String(text || '').trim();
  if (reply.length < 2 || reply.length > 1000) throw new ReviewError('Replies must be between 2 and 1,000 characters.');
  db.prepare(`UPDATE reviews SET reply = ?, reply_status = 'pending', reply_note = '', reply_at = datetime('now') WHERE id = ?`).run(reply, rv.id);
}

async function moderateReply(db, reviewId, { decision, note }) {
  const rv = detailed(db, reviewId);
  if (!rv || rv.reply_status === 'none') throw new ReviewError('Reply not found.');
  if (!['approve', 'reject'].includes(decision)) throw new ReviewError('Unknown decision.');
  const clean = String(note || '').trim().slice(0, 300);
  if (decision === 'reject' && !clean) throw new ReviewError('Give the restaurant a reason for rejecting their reply.');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE reviews SET reply_status = ?, reply_note = ? WHERE id = ?').run(status, clean, rv.id);
  if (status === 'rejected') {
    await mail(rv.owner_email, 'Your review reply needs changes', `Your reply to a review of ${rv.restaurant_name} wasn't published.\nReason: ${clean}\n\nEdit it here: ${config.baseUrl}/restaurant/reviews`);
  }
  return status;
}

module.exports = {
  ReviewError, SUB_RATINGS, displayName, ineligibleReason, forBooking, submit, summary, published, detailed,
  moderate, submitReply, moderateReply,
};
