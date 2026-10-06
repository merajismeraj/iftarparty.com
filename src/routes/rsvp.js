'use strict';
const express = require('express');
const svc = require('../services/bookings');
const packages = require('../services/packages');
const fmt = require('../services/format');

const MAX_PARTY = 10;

module.exports = (db) => {
  const router = express.Router();

  async function load(token) {
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return null;
    const guest = await db.prepare('SELECT * FROM guests WHERE rsvp_token = ?').get(token);
    if (!guest) return null;
    const booking = await svc.getDetailed(db, guest.booking_id);
    // Guests of a cancelled party still see what happened instead of a dead link.
    return ['confirmed', 'cancelled'].includes(booking?.status) && (booking.status === 'confirmed' || booking.cancelled_at) ? { guest, booking } : null;
  }

  const gone = (res) => res.status(404).render('error', { title: 'Invitation not found', message: 'This invitation link is invalid or the event was cancelled.' });

  /** Confirmed guests, privacy-safe: first name + last initial and party size only. */
  async function whoIsComing(booking, viewer) {
    if (!booking.show_guest_list || booking.status !== 'confirmed') return null;
    const rows = await db.prepare(
      `SELECT id, name, party_size FROM guests WHERE booking_id = ? AND rsvp_status = 'yes'
       ORDER BY responded_at, id`
    ).all(booking.id);
    const people = rows.map((g, i) => ({
      name: fmt.displayName(g.name), initials: fmt.initials(g.name), extra: Math.max(0, g.party_size - 1),
      you: g.id === viewer.id, tone: i % 8,
    }));
    // The viewer first, then everyone else in the order they replied.
    people.sort((a, b) => Number(b.you) - Number(a.you));
    return { people, heads: rows.reduce((sum, g) => sum + g.party_size, 0) };
  }

  router.get('/rsvp/:token', async (req, res) => {
    const ctx = await load(req.params.token);
    if (!ctx) return gone(res);
    res.set('Referrer-Policy', 'no-referrer');
    res.render('rsvp', { title: ctx.booking.title, ...ctx, dishes: await packages.bookingSelection(db, ctx.booking.id), coming: await whoIsComing(ctx.booking, ctx.guest), cancelled: ctx.booking.status === 'cancelled', closed: ctx.booking.event_date < svc.todayISO(), maxParty: MAX_PARTY, bare: true });
  });

  router.post('/rsvp/:token', async (req, res) => {
    const ctx = await load(req.params.token);
    if (!ctx) return gone(res);
    if (ctx.booking.status !== 'confirmed' || ctx.booking.event_date < svc.todayISO()) return res.redirect(303, `/rsvp/${req.params.token}`);
    const status = ['yes', 'no', 'maybe'].includes(req.body.status) ? req.body.status : null;
    if (!status) return res.redirect(`/rsvp/${req.params.token}`);
    const size = status === 'no' ? 0 : Math.min(MAX_PARTY, Math.max(1, Number.parseInt(req.body.party_size, 10) || 1));
    const note = String(req.body.note || '').trim().slice(0, 500);
    await db.prepare(`UPDATE guests SET rsvp_status = ?, party_size = ?, note = ?, responded_at = ts_now() WHERE id = ?`)
      .run(status, size, note, ctx.guest.id);
    req.flash('success', status === 'yes' ? 'JazakAllah khair! Your host has been told you’re coming.'
      : status === 'maybe' ? 'Thanks – we’ve let your host know you might make it.'
        : 'Thanks for letting your host know. You can change your reply any time before the event.');
    res.redirect(303, `/rsvp/${req.params.token}`);
  });

  return router;
};
