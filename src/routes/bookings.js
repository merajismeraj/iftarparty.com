'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { guestList: guestListUpload } = require('../middleware/uploads');
const svc = require('../services/bookings');
const payments = require('../services/payments');
const checkout = require('../services/checkout');
const { normalizePhone } = require('../services/guestlist');
const invites = require('../services/invites');
const { parseGuestList } = require('../services/guestlist');
const { transaction } = require('../db');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function csvCell(v) {
  const s = String(v ?? '');
  // Neutralise spreadsheet formula injection and quote every cell.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

module.exports = (db) => {
  const router = express.Router();
  const host = requireAuth('host');

  /** Load a booking owned by the signed-in host, or render 404. */
  function ownBooking(req, res) {
    const b = svc.getDetailed(db, req.params.id);
    if (!b || b.host_id !== req.user.id) {
      res.status(404).render('error', { title: 'Booking not found', message: 'We couldn’t find that booking on your account.' });
      return null;
    }
    return b;
  }

  // Step 1: hold the venue for the chosen night.
  router.post('/venues/:id/reserve', host, (req, res) => {
    try {
      const id = svc.createHold(db, {
        venueId: Number(req.params.id), menuId: Number(req.body.menu_id), hostId: req.user.id,
        eventDate: req.body.date, guestCount: req.body.guests, arrivalTime: req.body.arrival_time,
      });
      res.redirect(`/bookings/${id}/checkout`);
    } catch (err) {
      if (!(err instanceof svc.BookingError)) throw err;
      req.flash('error', err.message);
      const qs = new URLSearchParams({ date: req.body.date || '', guests: req.body.guests || '', menu: req.body.menu_id || '' });
      res.redirect(`/venues/${req.params.id}?${qs}#reserve`);
    }
  });

  // Step 2: review the price and pay.
  router.get('/bookings/:id/checkout', host, (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    if (b.status === 'confirmed') return res.redirect(`/bookings/${b.id}`);
    const expired = b.status !== 'pending_payment' || b.hold_expires_at <= new Date().toISOString();
    res.render('host/checkout', { title: 'Review & pay', b, expired });
  });

  router.post('/bookings/:id/pay', host, async (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    if (b.status === 'confirmed') return res.redirect(`/bookings/${b.id}`);
    if (b.status !== 'pending_payment' || b.hold_expires_at <= new Date().toISOString()) {
      req.flash('error', 'Your hold on this venue expired. Please reserve again.');
      return res.redirect(`/venues/${b.venue_id}?date=${b.event_date}&guests=${b.guest_count}&menu=${b.menu_id}`);
    }
    // The gateway needs a mobile number; collect it once for accounts created without one.
    if (!req.user.phone) {
      const phone = normalizePhone(req.body.phone);
      if (!phone) {
        req.flash('error', 'Please enter a valid mobile number to continue to payment.');
        return res.redirect(`/bookings/${b.id}/checkout`);
      }
      db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.user.id);
      req.user.phone = phone;
    }
    let start;
    try {
      start = await checkout.startPayment(db, b, req.user);
    } catch (err) {
      if (!(err instanceof payments.PaymentError)) throw err;
      console.error(`[payment] create order for booking ${b.id} failed:`, err.message);
      req.flash('error', 'We couldn’t reach the payment gateway. Please try again in a moment.');
      return res.redirect(`/bookings/${b.id}/checkout`);
    }
    if (start.demo) return res.redirect(303, `/bookings/${b.id}/demo-pay?order=${encodeURIComponent(start.orderId)}`);
    res.render('host/cashfree', { title: 'Redirecting to payment', b, sessionId: start.sessionId, mode: payments.sdkMode() });
  });

  // Cashfree sends the host back here; the order is re-fetched server-side, never trusted from the URL.
  router.get('/bookings/:id/payment-return', host, async (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    const orderId = String(req.query.order_id || '');
    if (payments.bookingIdFromOrder(orderId) !== b.id) return res.redirect(`/bookings/${b.id}/checkout`);
    let result;
    try {
      result = await checkout.settleOrder(db, orderId);
    } catch (err) {
      if (!(err instanceof payments.PaymentError)) throw err;
      req.flash('info', 'We’re confirming your payment with the bank. This page will update shortly – please don’t pay again.');
      return res.redirect(`/bookings/${b.id}/checkout`);
    }
    return afterSettle(req, res, b, result);
  });

  // Built-in payment simulator, available only when Cashfree is not configured.
  router.get('/bookings/:id/demo-pay', host, (req, res) => {
    if (payments.isLive()) return res.redirect(`/bookings/${req.params.id}/checkout`);
    const b = ownBooking(req, res);
    if (!b) return;
    if (b.status === 'confirmed') return res.redirect(`/bookings/${b.id}`);
    res.render('host/demo-pay', { title: 'Payment', b, orderId: String(req.query.order || '') });
  });

  router.post('/bookings/:id/demo-pay', host, async (req, res) => {
    if (payments.isLive()) return res.status(404).end();
    const b = ownBooking(req, res);
    if (!b) return;
    const p = db.prepare(`SELECT * FROM payments WHERE order_id = ? AND booking_id = ? AND provider = 'demo'`).get(String(req.body.order_id || ''), b.id);
    if (!p) {
      req.flash('error', 'Payment session not found. Please start payment again.');
      return res.redirect(`/bookings/${b.id}/checkout`);
    }
    return afterSettle(req, res, b, await checkout.settleOrder(db, p.order_id));
  });

  function afterSettle(req, res, b, result) {
    switch (result.state) {
      case 'confirmed':
        req.flash('success', `Reserved! ${b.venue_name} now shows “${b.title}” on ${b.event_date}. Next: add your guest list.`);
        return res.redirect(`/bookings/${b.id}?welcome=1#guests`);
      case 'unpaid':
        req.flash('error', 'Payment was not completed. You can try again while your hold lasts.');
        return res.redirect(`/bookings/${b.id}/checkout`);
      case 'duplicate_refunded':
        req.flash('info', 'This booking was already paid, so your second payment is being refunded in full.');
        return res.redirect(`/bookings/${b.id}`);
      case 'conflict_refunded':
        req.flash('error', 'Payment received, but the venue was taken after your hold expired. A full refund has been initiated.');
        return res.redirect('/my-parties');
      case 'cancelled_refunded':
        req.flash('error', 'This reservation was cancelled before payment completed. A full refund has been initiated.');
        return res.redirect('/my-parties');
      default:
        req.flash('error', 'We couldn’t verify this payment. Our team has been alerted – please contact support before paying again.');
        return res.redirect(`/bookings/${b.id}/checkout`);
    }
  }

  router.post('/bookings/:id/cancel', host, (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    if (b.status === 'pending_payment') {
      db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(b.id);
      req.flash('success', 'Reservation hold released.');
    }
    res.redirect('/my-parties');
  });

  // ---- Host dashboard ----
  router.get('/my-parties', host, (req, res) => {
    svc.expireStaleHolds(db);
    const rows = db.prepare(
      `SELECT b.id FROM bookings b WHERE b.host_id = ?
         AND (b.status IN ('confirmed', 'pending_payment') OR (b.status = 'cancelled' AND b.cancelled_at IS NOT NULL))
       ORDER BY b.status = 'cancelled', b.event_date < ?, b.event_date`
    ).all(req.user.id, svc.todayISO());
    const parties = rows.map((r) => {
      const b = svc.getDetailed(db, r.id);
      const notified = b.status === 'cancelled' ? db.prepare(
        `SELECT COUNT(DISTINCT ml.guest_id) AS n FROM message_log ml JOIN guests g ON g.id = ml.guest_id
         WHERE g.booking_id = ? AND ml.kind = 'cancellation'`
      ).get(b.id).n : 0;
      return { ...b, rsvp: svc.rsvpSummary(db, b.id), payment: checkout.bookingPayment(db, b), notified };
    });
    res.render('host/parties', { title: 'My Iftar parties', parties, today: svc.todayISO() });
  });

  router.get('/bookings/:id', host, (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    if (b.status === 'pending_payment') return res.redirect(`/bookings/${b.id}/checkout`);
    if (b.status !== 'confirmed') return res.redirect('/my-parties');
    const guests = db.prepare(
      `SELECT * FROM guests WHERE booking_id = ?
       ORDER BY CASE rsvp_status WHEN 'yes' THEN 0 WHEN 'maybe' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, name`
    ).all(b.id);
    res.render('host/party', {
      title: b.title, b, guests, rsvp: svc.rsvpSummary(db, b.id), welcome: req.query.welcome === '1',
      preview: guests[0] ? invites.buildInvite(b, guests[0]) : invites.buildInvite(b, { name: 'Guest', rsvp_token: 'preview' }),
      past: b.event_date < svc.todayISO(),
    });
  });

  router.post('/bookings/:id/details', host, (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    const message = String(req.body.invite_message || '').trim().slice(0, 600);
    const time = TIME_RE.test(req.body.arrival_time || '') ? req.body.arrival_time : b.arrival_time;
    db.prepare('UPDATE bookings SET invite_message = ?, arrival_time = ? WHERE id = ?').run(message, time, b.id);
    req.flash('success', 'Invitation updated.');
    res.redirect(`/bookings/${b.id}#invite`);
  });

  // Step 3: upload the invite list (CSV file or pasted rows) and optionally send immediately.
  router.post('/bookings/:id/guests', host, guestListUpload.single('file'), async (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    if (b.status !== 'confirmed') return res.redirect(`/bookings/${b.id}`);
    const text = req.file ? req.file.buffer.toString('utf8') : String(req.body.list || '');
    let parsed;
    try {
      parsed = parseGuestList(text);
    } catch (err) {
      req.flash('error', `We couldn’t read that file: ${err.message}. Use the CSV template (name, email, mobile).`);
      return res.redirect(`/bookings/${b.id}#guests`);
    }

    const existing = db.prepare('SELECT email, phone FROM guests WHERE booking_id = ?').all(b.id);
    const known = new Set(existing.flatMap((g) => [g.email, g.phone]).filter(Boolean));
    const fresh = parsed.guests.filter((g) => !(g.email && known.has(g.email)) && !(g.phone && known.has(g.phone)));
    const skipped = parsed.guests.length - fresh.length;

    transaction(db, () => {
      const ins = db.prepare('INSERT INTO guests (booking_id, name, email, phone, rsvp_token) VALUES (?, ?, ?, ?, ?)');
      fresh.forEach((g) => ins.run(b.id, g.name, g.email, g.phone, invites.newToken()));
    });

    const notes = [];
    if (fresh.length) notes.push(`${fresh.length} guest${fresh.length === 1 ? '' : 's'} added`);
    if (skipped) notes.push(`${skipped} already on your list`);
    if (parsed.errors.length) {
      notes.push(`${parsed.errors.length} row${parsed.errors.length === 1 ? '' : 's'} skipped (${parsed.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.reason}`).join('; ')}${parsed.errors.length > 3 ? '…' : ''})`);
    }
    if (!fresh.length && !parsed.errors.length && !skipped) notes.push('No guests found – add one per line as: name, email, mobile');

    if (fresh.length && req.body.send_now === 'on' && !(b.event_date < svc.todayISO())) {
      const sent = await invites.sendInvites(db, b, 'new');
      notes.push(`invites sent to ${sent} via WhatsApp/email`);
    }
    req.flash(parsed.errors.length || !fresh.length ? 'info' : 'success', `${notes.join(' · ')}.`);
    res.redirect(`/bookings/${b.id}#guests`);
  });

  router.post('/bookings/:id/invites', host, async (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    if (b.status !== 'confirmed' || b.event_date < svc.todayISO()) return res.redirect(`/bookings/${b.id}`);
    const scope = req.body.scope === 'pending' ? 'pending' : 'new';
    const sent = await invites.sendInvites(db, b, scope);
    req.flash(sent ? 'success' : 'info', sent
      ? `${scope === 'pending' ? 'Reminders' : 'Invites'} sent to ${sent} guest${sent === 1 ? '' : 's'}.`
      : scope === 'pending' ? 'Everyone has already replied.' : 'All guests have already been invited.');
    res.redirect(`/bookings/${b.id}#guests`);
  });

  router.post('/bookings/:id/guests/:guestId/resend', host, async (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    const sent = await invites.sendInvites(db, b, Number(req.params.guestId));
    req.flash(sent ? 'success' : 'error', sent ? 'Invite re-sent.' : 'Guest not found.');
    res.redirect(`/bookings/${b.id}#guests`);
  });

  router.post('/bookings/:id/guests/:guestId/delete', host, (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    db.prepare('DELETE FROM guests WHERE id = ? AND booking_id = ?').run(req.params.guestId, b.id);
    req.flash('success', 'Guest removed.');
    res.redirect(`/bookings/${b.id}#guests`);
  });

  router.get('/bookings/:id/guests.csv', host, (req, res) => {
    const b = ownBooking(req, res);
    if (!b) return;
    const rows = db.prepare('SELECT name, email, phone, rsvp_status, party_size, note, responded_at FROM guests WHERE booking_id = ? ORDER BY name').all(b.id);
    const lines = [['name', 'email', 'mobile', 'rsvp', 'party_size', 'note', 'responded_at'].join(',')]
      .concat(rows.map((r) => [r.name, r.email, r.phone, r.rsvp_status, r.party_size, r.note, r.responded_at].map(csvCell).join(',')));
    res.type('text/csv').attachment(`iftar-rsvps-${b.event_date}.csv`).send(`${lines.join('\n')}\n`);
  });

  return router;
};
