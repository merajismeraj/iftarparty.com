'use strict';
const express = require('express');
const svc = require('../services/bookings');

const MAX_PARTY = 10;

module.exports = (db) => {
  const router = express.Router();

  function load(token) {
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return null;
    const guest = db.prepare('SELECT * FROM guests WHERE rsvp_token = ?').get(token);
    if (!guest) return null;
    const booking = svc.getDetailed(db, guest.booking_id);
    // Guests of a cancelled party still see what happened instead of a dead link.
    return ['confirmed', 'cancelled'].includes(booking?.status) && (booking.status === 'confirmed' || booking.cancelled_at) ? { guest, booking } : null;
  }

  const gone = (res) => res.status(404).render('error', { title: 'Invitation not found', message: 'This invitation link is invalid or the event was cancelled.' });

  router.get('/rsvp/:token', (req, res) => {
    const ctx = load(req.params.token);
    if (!ctx) return gone(res);
    res.set('Referrer-Policy', 'no-referrer');
    res.render('rsvp', { title: ctx.booking.title, ...ctx, cancelled: ctx.booking.status === 'cancelled', closed: ctx.booking.event_date < svc.todayISO(), maxParty: MAX_PARTY, bare: true });
  });

  router.post('/rsvp/:token', (req, res) => {
    const ctx = load(req.params.token);
    if (!ctx) return gone(res);
    if (ctx.booking.status !== 'confirmed' || ctx.booking.event_date < svc.todayISO()) return res.redirect(303, `/rsvp/${req.params.token}`);
    const status = ['yes', 'no', 'maybe'].includes(req.body.status) ? req.body.status : null;
    if (!status) return res.redirect(`/rsvp/${req.params.token}`);
    const size = status === 'no' ? 0 : Math.min(MAX_PARTY, Math.max(1, Number.parseInt(req.body.party_size, 10) || 1));
    const note = String(req.body.note || '').trim().slice(0, 500);
    db.prepare(`UPDATE guests SET rsvp_status = ?, party_size = ?, note = ?, responded_at = datetime('now') WHERE id = ?`)
      .run(status, size, note, ctx.guest.id);
    req.flash('success', status === 'yes' ? 'JazakAllah khair! Your host has been told you’re coming.'
      : status === 'maybe' ? 'Thanks – we’ve let your host know you might make it.'
        : 'Thanks for letting your host know. You can change your reply any time before the event.');
    res.redirect(303, `/rsvp/${req.params.token}`);
  });

  return router;
};
