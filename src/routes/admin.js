'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const svc = require('../services/bookings');
const checkout = require('../services/checkout');
const payments = require('../services/payments');
const invites = require('../services/invites');
const settings = require('../services/settings');
const audit = require('../services/audit');
const money = require('../services/money');
const reviews = require('../services/reviews');

const PAGE_SIZE = 25;
const RESTAURANT_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
const BOOKING_STATUSES = ['confirmed', 'pending_payment', 'cancelled', 'expired'];

const like = (s) => `%${String(s).trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
const pageOf = (q) => Math.max(1, Number.parseInt(q.page, 10) || 1);
const pages = (total) => Math.max(1, Math.ceil(total / PAGE_SIZE));
const num = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));

function csvCell(v) {
  const s = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
}

module.exports = (db) => {
  const router = express.Router();
  router.use(requireAuth('admin'));
  router.use((req, res, next) => {
    res.locals.adminSection = req.path.split('/')[1] || 'overview';
    res.locals.pendingCount = db.prepare(`SELECT COUNT(*) n FROM restaurants WHERE status = 'pending'`).get().n;
    res.locals.reviewQueue = db.prepare(`SELECT COUNT(*) n FROM reviews WHERE status = 'pending' OR reply_status = 'pending'`).get().n;
    next();
  });

  const back = (req, fallback) => {
    const to = req.body?.back;
    return typeof to === 'string' && to.startsWith('/admin') ? to : fallback;
  };
  const notFound = (res, what) => res.status(404).render('error', { title: `${what} not found`, message: `That ${what.toLowerCase()} doesn’t exist.` });

  // ---------- Overview ----------
  router.get('/', (req, res) => {
    const today = svc.todayISO();
    const m = num(db.prepare(
      `SELECT
         (SELECT COALESCE(SUM(total_amount), 0) FROM bookings WHERE status = 'confirmed') AS gmv,
         (SELECT COALESCE(SUM(platform_fee), 0) FROM bookings WHERE status = 'confirmed') AS fees,
         (SELECT COUNT(*) FROM bookings WHERE status = 'confirmed') AS confirmed,
         (SELECT COUNT(*) FROM bookings WHERE status = 'confirmed' AND event_date >= :today) AS upcoming,
         (SELECT COALESCE(SUM(refund_amount), 0) FROM payments WHERE refund_status = 'success') AS refunded,
         (SELECT COUNT(*) FROM payments WHERE refund_status = 'pending') AS refunds_pending,
         (SELECT COUNT(*) FROM payments WHERE refund_status = 'failed') AS refunds_failed,
         (SELECT COUNT(*) FROM restaurants WHERE status = 'pending') AS restaurants_pending,
         (SELECT COUNT(*) FROM restaurants WHERE status = 'approved') AS restaurants_live,
         (SELECT COUNT(*) FROM reviews WHERE status = 'pending' OR reply_status = 'pending') AS reviews_pending,
         (SELECT COUNT(*) FROM users WHERE role = 'host') AS hosts,
         (SELECT COALESCE(SUM(total_amount - platform_fee), 0) FROM bookings
            WHERE status = 'confirmed' AND event_date < :today AND payout_status = 'unpaid') AS payouts_owed,
         (SELECT COUNT(*) FROM message_log WHERE status = 'failed' AND created_at >= datetime('now', '-7 days')) AS messages_failed,
         (SELECT COUNT(*) FROM guests g JOIN bookings b ON b.id = g.booking_id WHERE b.status = 'confirmed' AND b.event_date >= :today) AS guests_invited,
         (SELECT COUNT(*) FROM guests g JOIN bookings b ON b.id = g.booking_id WHERE b.status = 'confirmed' AND b.event_date >= :today AND g.rsvp_status = 'yes') AS guests_yes,
         (SELECT COUNT(*) FROM payments p JOIN bookings b ON b.id = p.booking_id
            WHERE p.status = 'paid' AND b.payment_ref IS NOT p.order_id AND p.refund_status = 'none') AS orphan_payments`
    ).get({ today }));
    const recent = db.prepare(
      `SELECT b.id, b.title, b.event_date, b.status, b.total_amount, b.currency, b.created_at, v.name AS venue_name, r.name AS restaurant_name
       FROM bookings b JOIN venues v ON v.id = b.venue_id JOIN restaurants r ON r.id = v.restaurant_id
       ORDER BY b.id DESC LIMIT 8`
    ).all();
    const pending = db.prepare(
      `SELECT r.*, u.name AS owner_name, (SELECT COUNT(*) FROM venues WHERE restaurant_id = r.id) AS venues
       FROM restaurants r JOIN users u ON u.id = r.owner_id WHERE r.status = 'pending' ORDER BY r.id LIMIT 5`
    ).all();
    const actions = db.prepare(
      `SELECT a.*, u.name AS admin_name FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 8`
    ).all();
    res.render('admin/overview', { title: 'Admin', m, recent, pending, actions, live: payments.isLive() });
  });

  // ---------- Restaurants ----------
  router.get('/restaurants', (req, res) => {
    const q = req.query;
    const where = ['1 = 1'];
    const params = [];
    if (RESTAURANT_STATUSES.includes(q.status)) { where.push('r.status = ?'); params.push(q.status); }
    if (q.q?.trim()) {
      where.push(`(r.name LIKE ? ESCAPE '\\' OR r.city LIKE ? ESCAPE '\\' OR r.area LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`);
      params.push(...Array(4).fill(like(q.q)));
    }
    const page = pageOf(q);
    const base = `FROM restaurants r JOIN users u ON u.id = r.owner_id WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...params).n;
    const rows = db.prepare(
      `SELECT r.*, u.name AS owner_name, u.email AS owner_email,
              (SELECT COUNT(*) FROM venues v WHERE v.restaurant_id = r.id AND v.active = 1) AS venues,
              (SELECT COUNT(*) FROM menus m WHERE m.restaurant_id = r.id AND m.active = 1) AS menus,
              (SELECT COUNT(*) FROM bookings b JOIN venues v ON v.id = b.venue_id WHERE v.restaurant_id = r.id AND b.status = 'confirmed') AS bookings,
              (SELECT COALESCE(SUM(b.total_amount), 0) FROM bookings b JOIN venues v ON v.id = b.venue_id WHERE v.restaurant_id = r.id AND b.status = 'confirmed') AS gmv
       ${base} ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC LIMIT ? OFFSET ?`
    ).all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/restaurants', { title: 'Restaurants', rows, q, page, pages: pages(total), total, statuses: RESTAURANT_STATUSES });
  });

  router.get('/restaurants/:id', (req, res) => {
    const r = db.prepare(
      `SELECT r.*, u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, u.status AS owner_status, u.id AS owner_id
       FROM restaurants r JOIN users u ON u.id = r.owner_id WHERE r.id = ?`
    ).get(req.params.id);
    if (!r) return notFound(res, 'Restaurant');
    const venues = db.prepare(
      `SELECT v.*, (SELECT filename FROM venue_images WHERE venue_id = v.id ORDER BY sort_order, id LIMIT 1) AS image,
              (SELECT COUNT(*) FROM venue_images WHERE venue_id = v.id) AS photos
       FROM venues v WHERE v.restaurant_id = ? ORDER BY v.id`
    ).all(r.id);
    const menus = db.prepare('SELECT * FROM menus WHERE restaurant_id = ? ORDER BY price_per_person').all(r.id);
    const bookings = db.prepare(
      `SELECT b.*, v.name AS venue_name FROM bookings b JOIN venues v ON v.id = b.venue_id
       WHERE v.restaurant_id = ? ORDER BY b.event_date DESC LIMIT 20`
    ).all(r.id);
    const upcoming = bookings.filter((b) => b.status === 'confirmed' && b.event_date >= svc.todayISO()).length;
    const log = db.prepare(
      `SELECT a.*, u.name AS admin_name FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id
       WHERE a.entity_type = 'restaurant' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 20`
    ).all(r.id);
    res.render('admin/restaurant', { title: r.name, r, venues, menus, bookings, upcoming, log, statuses: RESTAURANT_STATUSES });
  });

  router.post('/restaurants/:id/status', (req, res) => {
    const r = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(req.params.id);
    if (!r) return notFound(res, 'Restaurant');
    const status = req.body.status;
    if (!RESTAURANT_STATUSES.includes(status)) return res.redirect(`/admin/restaurants/${r.id}`);
    const note = String(req.body.note || '').trim().slice(0, 300);
    if (['rejected', 'suspended'].includes(status) && !note) {
      req.flash('error', 'Please give a reason – the restaurant sees it on their dashboard.');
      return res.redirect(back(req, `/admin/restaurants/${r.id}`));
    }
    db.prepare('UPDATE restaurants SET status = ?, status_note = ? WHERE id = ?').run(status, status === 'approved' ? '' : note, r.id);
    audit.log(db, req.user.id, `restaurant.${status}`, 'restaurant', r.id, note);
    req.flash('success', `${r.name} is now ${status}.${status === 'approved' ? ' Its halls appear in search.' : ''}`);
    res.redirect(back(req, `/admin/restaurants/${r.id}`));
  });

  router.post('/venues/:id/toggle', (req, res) => {
    const v = db.prepare('SELECT * FROM venues WHERE id = ?').get(req.params.id);
    if (!v) return notFound(res, 'Hall');
    db.prepare('UPDATE venues SET active = 1 - active WHERE id = ?').run(v.id);
    audit.log(db, req.user.id, v.active ? 'venue.hide' : 'venue.show', 'restaurant', v.restaurant_id, `${v.name} (#${v.id})`);
    req.flash('success', `${v.name} is now ${v.active ? 'hidden from' : 'visible in'} search.`);
    res.redirect(`/admin/restaurants/${v.restaurant_id}`);
  });

  // ---------- Bookings ----------
  function bookingFilters(q) {
    const where = ['1 = 1'];
    const params = [];
    if (BOOKING_STATUSES.includes(q.status)) { where.push('b.status = ?'); params.push(q.status); }
    if (q.refund === 'pending' || q.refund === 'failed') {
      where.push('EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.refund_status = ?)');
      params.push(q.refund);
    } else if (q.refund === 'orphan') {
      where.push(`EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status = 'paid'
                  AND b.payment_ref IS NOT p.order_id AND p.refund_status = 'none')`);
    }
    if (svc.isValidDate(q.from)) { where.push('b.event_date >= ?'); params.push(q.from); }
    if (svc.isValidDate(q.to)) { where.push('b.event_date <= ?'); params.push(q.to); }
    if (q.q?.trim()) {
      const id = Number.parseInt(String(q.q).replace(/^#/, ''), 10);
      where.push(`(b.id = ? OR b.title LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\'
                   OR r.name LIKE ? ESCAPE '\\' OR b.payment_ref LIKE ? ESCAPE '\\')`);
      params.push(Number.isFinite(id) ? id : -1, ...Array(5).fill(like(q.q)));
    }
    return {
      sql: `FROM bookings b JOIN venues v ON v.id = b.venue_id JOIN restaurants r ON r.id = v.restaurant_id
            JOIN users u ON u.id = b.host_id JOIN menus m ON m.id = b.menu_id WHERE ${where.join(' AND ')}`,
      params,
    };
  }

  router.get('/bookings', (req, res) => {
    svc.expireStaleHolds(db);
    const q = req.query;
    const f = bookingFilters(q);
    const page = pageOf(q);
    const total = db.prepare(`SELECT COUNT(*) n ${f.sql}`).get(...f.params).n;
    const sums = num(db.prepare(`SELECT COALESCE(SUM(b.total_amount), 0) AS gmv, COALESCE(SUM(b.platform_fee), 0) AS fees ${f.sql} AND b.status = 'confirmed'`).get(...f.params));
    const rows = db.prepare(
      `SELECT b.*, v.name AS venue_name, r.name AS restaurant_name, u.name AS host_name, u.email AS host_email,
              (SELECT COUNT(*) FROM guests g WHERE g.booking_id = b.id) AS invited,
              (SELECT COUNT(*) FROM guests g WHERE g.booking_id = b.id AND g.rsvp_status = 'yes') AS yes
       ${f.sql} ORDER BY b.id DESC LIMIT ? OFFSET ?`
    ).all(...f.params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/bookings', { title: 'Bookings', rows, q, page, pages: pages(total), total, sums, statuses: BOOKING_STATUSES });
  });

  router.get('/bookings.csv', (req, res) => {
    const f = bookingFilters(req.query);
    const rows = db.prepare(
      `SELECT b.id, b.title, b.event_date, b.status, u.name AS host, u.email AS host_email, r.name AS restaurant, v.name AS hall,
              m.name AS menu, b.guest_count, b.food_total, b.hire_fee, b.addons_total, b.platform_fee, b.total_amount, b.currency,
              b.payment_ref, b.paid_at, b.payout_status, b.payout_ref, b.cancel_reason
       ${f.sql} ORDER BY b.id`
    ).all(...f.params);
    const cols = ['id', 'title', 'event_date', 'status', 'host', 'host_email', 'restaurant', 'hall', 'menu', 'guest_count',
      'food_total', 'hire_fee', 'addons_total', 'platform_fee', 'total_amount', 'currency', 'payment_ref', 'paid_at', 'payout_status', 'payout_ref', 'cancel_reason'];
    const amount = new Set(['food_total', 'hire_fee', 'addons_total', 'platform_fee', 'total_amount']);
    const lines = [cols.join(',')].concat(rows.map((r) => cols.map((c) => csvCell(amount.has(c) ? money.toMajor(r[c]).toFixed(2) : r[c])).join(',')));
    res.type('text/csv').attachment(`iftarparty-bookings-${svc.todayISO()}.csv`).send(`${lines.join('\n')}\n`);
  });

  router.get('/bookings/:id', (req, res) => {
    const b = svc.getDetailed(db, req.params.id);
    if (!b) return notFound(res, 'Booking');
    const ledger = db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY id').all(b.id);
    const messages = db.prepare(
      `SELECT ml.channel, ml.status, COUNT(*) AS n FROM message_log ml JOIN guests g ON g.id = ml.guest_id
       WHERE g.booking_id = ? GROUP BY ml.channel, ml.status`
    ).all(b.id);
    const log = db.prepare(
      `SELECT a.*, u.name AS admin_name FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id
       WHERE a.entity_type = 'booking' AND a.entity_id = ? ORDER BY a.id DESC`
    ).all(b.id);
    res.render('admin/booking', {
      title: `Booking #${b.id}`, b, ledger, addons: svc.bookingAddons(db, b.id), dishes: require('../services/packages').bookingSelection(db, b.id), rsvp: svc.rsvpSummary(db, b.id), messages, log,
      paid: checkout.bookingPayment(db, b), today: svc.todayISO(),
    });
  });

  router.post('/bookings/:id/cancel', async (req, res) => {
    const b = svc.getDetailed(db, req.params.id);
    if (!b) return notFound(res, 'Booking');
    const reason = String(req.body.reason || '').trim();
    if (!reason) {
      req.flash('error', 'A cancellation reason is required – it is emailed to the host.');
      return res.redirect(`/admin/bookings/${b.id}#cancel`);
    }
    let refund = 0;
    if (req.body.refund === 'full') refund = b.total_amount;
    else if (req.body.refund === 'partial') refund = money.toMinor(req.body.amount);
    if (!Number.isFinite(refund) || refund < 0) {
      req.flash('error', 'Enter a valid refund amount.');
      return res.redirect(`/admin/bookings/${b.id}#cancel`);
    }
    try {
      const notifyGuests = req.body.notify_guests === 'on';
      const { refundStatus, guestsNotified } = await checkout.cancelBooking(db, b.id, { reason, refundAmount: refund, notifyGuests });
      audit.log(db, req.user.id, 'booking.cancel', 'booking', b.id,
        `${reason}${refund ? ` · refund ${money.format(refund, b.currency)} (${refundStatus})` : ' · no refund'} · ${notifyGuests ? `${guestsNotified} guest(s) notified` : 'guests not notified'}`);
      req.flash('success', `Booking cancelled${refund ? ` and ${money.format(refund, b.currency)} refund ${refundStatus === 'success' ? 'completed' : 'initiated'}` : ''}. The host has been emailed${guestsNotified ? ` and ${guestsNotified} guest${guestsNotified === 1 ? '' : 's'} notified` : ''}; the night is free again.`);
    } catch (err) {
      if (!(err instanceof svc.BookingError || err instanceof payments.PaymentError)) throw err;
      audit.log(db, req.user.id, 'booking.cancel_failed', 'booking', b.id, err.message);
      req.flash('error', `Not cancelled: ${err.message}`);
    }
    res.redirect(`/admin/bookings/${b.id}`);
  });

  // Re-check the latest gateway order for a booking stuck in "pending payment".
  router.post('/bookings/:id/verify', async (req, res) => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!b) return notFound(res, 'Booking');
    const orders = db.prepare(`SELECT order_id FROM payments WHERE booking_id = ? AND status = 'created' ORDER BY id DESC`).all(b.id);
    const results = [];
    try {
      for (const o of orders) results.push(`${o.order_id}: ${(await checkout.settleOrder(db, o.order_id)).state}`);
    } catch (err) {
      if (!(err instanceof payments.PaymentError)) throw err;
      results.push(`gateway error – ${err.message}`);
    }
    audit.log(db, req.user.id, 'booking.verify_payment', 'booking', b.id, results.join('; ') || 'no open orders');
    req.flash('info', results.length ? `Payment check: ${results.join('; ')}` : 'No open payment orders for this booking.');
    res.redirect(`/admin/bookings/${b.id}`);
  });

  router.post('/payments/:id/refund-refresh', async (req, res) => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!p) return notFound(res, 'Payment');
    try {
      const status = await checkout.refreshRefund(db, p.id);
      req.flash('info', `Refund status: ${status}.`);
    } catch (err) {
      if (!(err instanceof payments.PaymentError)) throw err;
      req.flash('error', `Couldn’t reach Cashfree: ${err.message}`);
    }
    res.redirect(`/admin/bookings/${p.booking_id}`);
  });

  router.post('/payments/:id/refund-retry', async (req, res) => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!p) return notFound(res, 'Payment');
    // Orphan payments (duplicate/late) that never got refunded have refund_amount 0 – refund in full.
    const amount = p.refund_amount || p.amount;
    try {
      const status = await checkout.refundPayment(db, p.id, amount, p.refund_reason || 'Refund retried by admin');
      audit.log(db, req.user.id, 'payment.refund', 'booking', p.booking_id, `${p.order_id} · ${money.format(amount, p.currency)} (${status})`);
      req.flash('success', `Refund of ${money.format(amount, p.currency)} ${status === 'success' ? 'completed' : 'initiated'}.`);
    } catch (err) {
      if (!(err instanceof svc.BookingError || err instanceof payments.PaymentError)) throw err;
      req.flash('error', `Refund failed: ${err.message}`);
    }
    res.redirect(`/admin/bookings/${p.booking_id}`);
  });

  // ---------- Payouts ----------
  router.get('/payouts', (req, res) => {
    const today = svc.todayISO();
    const owed = db.prepare(
      `SELECT r.id, r.name, r.city, r.payout_name, r.payout_upi, r.payout_account, r.payout_ifsc,
              COUNT(b.id) AS bookings, SUM(b.total_amount - b.platform_fee) AS amount,
              GROUP_CONCAT(b.id) AS booking_ids, MIN(b.event_date) AS oldest
       FROM bookings b JOIN venues v ON v.id = b.venue_id JOIN restaurants r ON r.id = v.restaurant_id
       WHERE b.status = 'confirmed' AND b.event_date < ? AND b.payout_status = 'unpaid'
       GROUP BY r.id ORDER BY oldest`
    ).all(today);
    const upcoming = num(db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount - platform_fee), 0) AS amount FROM bookings
       WHERE status = 'confirmed' AND event_date >= ? AND payout_status = 'unpaid'`
    ).get(today));
    const history = db.prepare(
      `SELECT b.payout_ref, MAX(b.payout_at) AS paid_at, r.name, COUNT(*) AS bookings, SUM(b.total_amount - b.platform_fee) AS amount
       FROM bookings b JOIN venues v ON v.id = b.venue_id JOIN restaurants r ON r.id = v.restaurant_id
       WHERE b.payout_status = 'paid' GROUP BY b.payout_ref, r.id ORDER BY paid_at DESC LIMIT 30`
    ).all();
    res.render('admin/payouts', { title: 'Payouts', owed, upcoming, history });
  });

  router.post('/payouts', (req, res) => {
    const restaurantId = Number(req.body.restaurant_id);
    const reference = String(req.body.reference || '').trim().slice(0, 100);
    const ids = String(req.body.booking_ids || '').split(',').map(Number).filter(Number.isInteger);
    if (!reference) {
      req.flash('error', 'Enter the UTR / transfer reference so the payout can be reconciled.');
      return res.redirect('/admin/payouts');
    }
    // Only mark the exact bookings shown on screen, and only if still eligible.
    const placeholders = ids.map(() => '?').join(',') || 'NULL';
    const info = db.prepare(
      `UPDATE bookings SET payout_status = 'paid', payout_ref = ?, payout_at = datetime('now')
       WHERE id IN (${placeholders}) AND status = 'confirmed' AND payout_status = 'unpaid' AND event_date < ?
         AND venue_id IN (SELECT id FROM venues WHERE restaurant_id = ?)`
    ).run(reference, ...ids, svc.todayISO(), restaurantId);
    audit.log(db, req.user.id, 'payout.mark_paid', 'restaurant', restaurantId, `${info.changes} booking(s) · ref ${reference}`);
    req.flash('success', `Marked ${info.changes} booking${info.changes === 1 ? '' : 's'} as paid out (ref ${reference}).`);
    res.redirect('/admin/payouts');
  });

  // ---------- Users ----------
  router.get('/users', (req, res) => {
    const q = req.query;
    const where = ['1 = 1'];
    const params = [];
    if (['host', 'restaurant', 'admin'].includes(q.role)) { where.push('u.role = ?'); params.push(q.role); }
    if (['active', 'suspended'].includes(q.status)) { where.push('u.status = ?'); params.push(q.status); }
    if (q.q?.trim()) {
      where.push(`(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\')`);
      params.push(...Array(3).fill(like(q.q)));
    }
    const page = pageOf(q);
    const base = `FROM users u WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...params).n;
    const rows = db.prepare(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.created_at,
              (SELECT COUNT(*) FROM bookings b WHERE b.host_id = u.id AND b.status = 'confirmed') AS bookings,
              (SELECT id FROM restaurants r WHERE r.owner_id = u.id) AS restaurant_id
       ${base} ORDER BY u.id DESC LIMIT ? OFFSET ?`
    ).all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/users', { title: 'Users', rows, q, page, pages: pages(total), total });
  });

  router.post('/users/:id/status', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) return notFound(res, 'User');
    const status = req.body.status === 'suspended' ? 'suspended' : 'active';
    if (u.role === 'admin') {
      req.flash('error', 'Admin accounts can’t be suspended from the portal. Use the command line.');
    } else {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, u.id);
      audit.log(db, req.user.id, `user.${status === 'suspended' ? 'suspend' : 'reactivate'}`, 'user', u.id, `${u.email}${req.body.note ? ` · ${req.body.note}` : ''}`);
      req.flash('success', `${u.name} is ${status === 'suspended' ? 'suspended and signed out' : 'active again'}.`);
    }
    res.redirect(back(req, '/admin/users'));
  });

  // ---------- Messages ----------
  router.get('/messages', (req, res) => {
    const q = req.query;
    const where = ['1 = 1'];
    const params = [];
    if (['failed', 'sent', 'logged'].includes(q.status)) { where.push('ml.status = ?'); params.push(q.status); }
    if (['email', 'whatsapp'].includes(q.channel)) { where.push('ml.channel = ?'); params.push(q.channel); }
    if (['invite', 'cancellation'].includes(q.kind)) { where.push('ml.kind = ?'); params.push(q.kind); }
    const page = pageOf(q);
    const base = `FROM message_log ml LEFT JOIN guests g ON g.id = ml.guest_id LEFT JOIN bookings b ON b.id = g.booking_id WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...params).n;
    const rows = db.prepare(
      `SELECT ml.*, g.name AS guest_name, g.booking_id, b.title, b.event_date, b.status AS booking_status ${base} ORDER BY ml.id DESC LIMIT ? OFFSET ?`
    ).all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    const health = db.prepare(
      `SELECT channel, status, COUNT(*) AS n FROM message_log WHERE created_at >= datetime('now', '-7 days') GROUP BY channel, status`
    ).all();
    res.render('admin/messages', { title: 'Messages', rows, q, page, pages: pages(total), total, health });
  });

  router.post('/guests/:id/resend', async (req, res) => {
    const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(req.params.id);
    if (!g) return notFound(res, 'Guest');
    const b = svc.getDetailed(db, g.booking_id);
    if (b.status !== 'confirmed' || b.event_date < svc.todayISO()) {
      req.flash('error', 'That party is no longer active.');
    } else {
      await invites.sendInvites(db, b, g.id);
      audit.log(db, req.user.id, 'guest.resend', 'booking', b.id, g.name);
      req.flash('success', `Invite re-sent to ${g.name}.`);
    }
    res.redirect(back(req, '/admin/messages?status=failed'));
  });

  // ---------- Reviews moderation ----------
  router.get('/reviews', (req, res) => {
    const q = req.query;
    const status = ['pending', 'approved', 'rejected', 'all'].includes(q.status) ? q.status : 'pending';
    const where = [];
    const params = [];
    if (status === 'pending') where.push(`(rv.status = 'pending' OR rv.reply_status = 'pending')`);
    else if (status !== 'all') { where.push('rv.status = ?'); params.push(status); }
    if (q.q?.trim()) {
      where.push(`(r.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR rv.body LIKE ? ESCAPE '\\')`);
      params.push(...Array(3).fill(like(q.q)));
    }
    const page = pageOf(q);
    const base = `FROM reviews rv JOIN users u ON u.id = rv.host_id JOIN restaurants r ON r.id = rv.restaurant_id
                  JOIN venues v ON v.id = rv.venue_id JOIN bookings b ON b.id = rv.booking_id
                  ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...params).n;
    const rows = db.prepare(
      `SELECT rv.*, u.name AS host_name, u.email AS host_email, r.name AS restaurant_name, v.name AS venue_name, b.event_date,
              (SELECT COUNT(*) FROM reviews x WHERE x.host_id = rv.host_id) AS host_reviews
       ${base} ORDER BY rv.updated_at ASC, rv.id ASC LIMIT ? OFFSET ?`
    ).all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/reviews', { title: 'Reviews', rows, q: { ...q, status }, page, pages: pages(total), total });
  });

  router.post('/reviews/:id/moderate', async (req, res) => {
    try {
      const status = await reviews.moderate(db, Number(req.params.id), { decision: req.body.decision, note: req.body.note });
      audit.log(db, req.user.id, `review.${status}`, 'review', Number(req.params.id), req.body.note || '');
      req.flash('success', `Review ${status}.`);
    } catch (err) {
      if (!(err instanceof reviews.ReviewError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(back(req, '/admin/reviews'));
  });

  router.post('/reviews/:id/reply-moderate', async (req, res) => {
    try {
      const status = await reviews.moderateReply(db, Number(req.params.id), { decision: req.body.decision, note: req.body.note });
      audit.log(db, req.user.id, `review_reply.${status}`, 'review', Number(req.params.id), req.body.note || '');
      req.flash('success', `Reply ${status}.`);
    } catch (err) {
      if (!(err instanceof reviews.ReviewError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(back(req, '/admin/reviews'));
  });

  // ---------- Settings & audit ----------
  /** Consistent snapshot of the live SQLite database (VACUUM INTO), streamed as a download. */
  router.get('/backup', (req, res, next) => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(os.tmpdir(), `iftarparty-${stamp}-${process.pid}.db`);
    try {
      db.prepare('VACUUM INTO ?').run(file);
    } catch (err) {
      return next(err);
    }
    audit.log(db, req.user.id, 'database.backup', 'system', 0, '');
    res.download(file, `iftarparty-${stamp}.db`, () => fs.rm(file, { force: true }, () => {}));
  });

  router.get('/settings', (req, res) => {
    res.render('admin/settings', { title: 'Settings', fee: settings.feePercent(db), minDishes: settings.minPackageDishes(db), live: payments.isLive(), wa: require('../services/notify').whatsappProvider(), errors: [] });
  });

  router.post('/settings', (req, res) => {
    const fee = Number(req.body.platform_fee_percent);
    // Each field is optional so older forms/scripts can update one setting at a time.
    const minDishes = req.body.min_package_dishes === undefined ? settings.minPackageDishes(db) : Number(req.body.min_package_dishes);
    const errors = [];
    if (!Number.isFinite(fee) || fee < 0 || fee > 30) errors.push('Platform fee must be between 0 and 30%.');
    if (!Number.isInteger(minDishes) || minDishes < 1 || minDishes > 30) errors.push('Minimum dishes per package must be a whole number from 1 to 30.');
    if (errors.length) {
      return res.status(422).render('admin/settings', {
        title: 'Settings', fee: req.body.platform_fee_percent, minDishes: req.body.min_package_dishes, live: payments.isLive(), wa: require('../services/notify').whatsappProvider(), errors,
      });
    }
    const before = { fee: settings.feePercent(db), min: settings.minPackageDishes(db) };
    settings.set(db, 'platform_fee_percent', Math.round(fee * 100) / 100);
    settings.set(db, 'min_package_dishes', minDishes);
    audit.log(db, req.user.id, 'settings.update', 'settings', null,
      `platform_fee_percent ${before.fee} → ${fee}; min_package_dishes ${before.min} → ${minDishes}`);
    req.flash('success', 'Settings saved. New bookings use the updated fee; existing bookings keep theirs.');
    res.redirect('/admin/settings');
  });

  router.get('/audit', (req, res) => {
    const page = pageOf(req.query);
    const total = db.prepare('SELECT COUNT(*) n FROM admin_actions').get().n;
    const rows = db.prepare(
      `SELECT a.*, u.name AS admin_name FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT ? OFFSET ?`
    ).all(PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.render('admin/audit', { title: 'Audit log', rows, q: req.query, page, pages: pages(total), total });
  });

  return router;
};
