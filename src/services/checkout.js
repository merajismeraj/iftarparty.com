'use strict';
/**
 * Payment orchestration on top of the gateway adapter: the `payments` table is the ledger,
 * every order and refund is recorded there, and money taken that can't buy a booking is
 * refunded automatically.
 */
const config = require('../config');
const payments = require('./payments');
const bookings = require('./bookings');
const notify = require('./notify');
const fmt = require('./format');
const money = require('./money');
const invites = require('./invites');

/** Create a gateway order for a held booking. Returns { orderId, sessionId, demo }. */
async function startPayment(db, booking, host) {
  const orderId = payments.newOrderId(booking.id);
  const prov = payments.provider();
  const paymentId = Number(db.prepare(
    'INSERT INTO payments (booking_id, provider, order_id, amount, currency) VALUES (?, ?, ?, ?, ?)'
  ).run(booking.id, prov, orderId, booking.total_amount, booking.currency).lastInsertRowid);
  try {
    const order = await payments.createOrder({
      orderId,
      amount: booking.total_amount,
      currency: booking.currency,
      customer: { id: `host_${host.id}`, name: host.name, email: host.email, phone: host.phone },
      returnUrl: `${config.baseUrl}/bookings/${booking.id}/payment-return?order_id={order_id}`,
      notifyUrl: `${config.baseUrl}/webhooks/cashfree`,
      expiresAt: booking.hold_expires_at,
      note: `${booking.title} – ${booking.venue_name}, ${booking.event_date}`,
    });
    return { orderId, sessionId: order.sessionId, demo: prov === 'demo' };
  } catch (err) {
    db.prepare(`UPDATE payments SET status = 'failed' WHERE id = ?`).run(paymentId);
    throw err;
  }
}

/**
 * Reconcile one order. Safe to call repeatedly and concurrently (return URL + webhook).
 * Returns { state, bookingId } where state is one of:
 *   confirmed | unpaid | unknown | mismatch | duplicate_refunded | conflict_refunded | cancelled_refunded
 */
async function settleOrder(db, orderId) {
  const p = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
  if (!p) return { state: 'unknown', bookingId: null };

  if (p.status !== 'paid') {
    let ref = null;
    if (p.provider === 'cashfree') {
      const order = await payments.getOrder(orderId);
      if (order.status !== 'PAID') return { state: 'unpaid', bookingId: p.booking_id };
      if (order.amount !== p.amount || order.currency !== p.currency) {
        console.error(`[payment ${orderId}] amount mismatch: paid ${order.amount} ${order.currency}, expected ${p.amount} ${p.currency}`);
        return { state: 'mismatch', bookingId: p.booking_id };
      }
      ref = order.ref;
    }
    db.prepare(`UPDATE payments SET status = 'paid', paid_at = datetime('now'), provider_ref = COALESCE(?, provider_ref)
                WHERE id = ? AND status <> 'paid'`).run(ref, p.id);
  }

  const b = db.prepare('SELECT status, payment_ref FROM bookings WHERE id = ?').get(p.booking_id);
  if (b.status === 'confirmed' && b.payment_ref && b.payment_ref !== orderId) {
    await autoRefund(db, p.id, 'Duplicate payment – booking was already paid');
    return { state: 'duplicate_refunded', bookingId: p.booking_id };
  }
  const r = bookings.confirmPayment(db, p.booking_id, { provider: p.provider, ref: orderId });
  if (r.ok) return { state: 'confirmed', bookingId: p.booking_id };
  await autoRefund(db, p.id, r.conflict ? 'Venue taken after payment hold expired' : 'Booking was cancelled before payment completed');
  return { state: r.conflict ? 'conflict_refunded' : 'cancelled_refunded', bookingId: p.booking_id };
}

async function autoRefund(db, paymentId, reason) {
  try {
    const p = db.prepare('SELECT amount FROM payments WHERE id = ?').get(paymentId);
    await refundPayment(db, paymentId, p.amount, reason);
  } catch (err) {
    // Already claimed by a concurrent settle, or the gateway failed (left as 'failed' for an admin to retry).
    console.error(`[refund] payment ${paymentId}: ${err.message}`);
  }
}

/**
 * Refund a paid ledger entry. The claim (refund_status -> pending) is taken synchronously before
 * calling the gateway, so concurrent callers can never refund twice.
 */
async function refundPayment(db, paymentId, amount, reason) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p || p.status !== 'paid') throw new bookings.BookingError('Only a completed payment can be refunded.');
  if (!(Number.isInteger(amount) && amount > 0 && amount <= p.amount)) {
    throw new bookings.BookingError(`Refund must be between ${money.format(1, p.currency)} and ${money.format(p.amount, p.currency)}.`);
  }
  const refundId = `RF-${p.id}-${Date.now().toString(36)}`;
  const claimed = db.prepare(
    `UPDATE payments SET refund_status = 'pending', refund_id = ?, refund_amount = ?, refund_reason = ?
     WHERE id = ? AND refund_status IN ('none', 'failed')`
  ).run(refundId, amount, String(reason || '').slice(0, 300), p.id).changes;
  if (!claimed) throw new bookings.BookingError('This payment has already been refunded.');
  try {
    const r = await payments.createRefund({ provider: p.provider, orderId: p.order_id, refundId, amount, note: reason });
    db.prepare(`UPDATE payments SET refund_status = ?, refunded_at = CASE WHEN ? = 'success' THEN datetime('now') END WHERE id = ?`)
      .run(r.status, r.status, p.id);
    return r.status;
  } catch (err) {
    db.prepare(`UPDATE payments SET refund_status = 'failed' WHERE id = ?`).run(p.id);
    throw err;
  }
}

/** Poll the gateway for a pending refund's final state. */
async function refreshRefund(db, paymentId) {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p || p.refund_status !== 'pending' || p.provider !== 'cashfree') return p?.refund_status;
  const r = await payments.getRefund(p.order_id, p.refund_id);
  db.prepare(`UPDATE payments SET refund_status = ?, refunded_at = CASE WHEN ? = 'success' THEN datetime('now') END WHERE id = ?`)
    .run(r.status, r.status, p.id);
  return r.status;
}

/** Record a refund status pushed by Cashfree's REFUND_STATUS_WEBHOOK. */
function applyRefundWebhook(db, { orderId, refundId, cfStatus }) {
  const status = cfStatus === 'SUCCESS' ? 'success' : cfStatus === 'CANCELLED' ? 'failed' : 'pending';
  db.prepare(`UPDATE payments SET refund_status = ?, refunded_at = CASE WHEN ? = 'success' THEN datetime('now') ELSE refunded_at END
              WHERE order_id = ? AND refund_id = ?`).run(status, status, orderId, refundId);
}

/** The ledger entry that paid for a confirmed booking. */
function bookingPayment(db, booking) {
  return booking.payment_ref ? db.prepare('SELECT * FROM payments WHERE order_id = ?').get(booking.payment_ref) : null;
}

/**
 * Cancel a booking (admin). Refunds first; if the gateway refuses, nothing is cancelled.
 * Frees the venue for that night, emails the host and (optionally) tells invited guests.
 */
async function cancelBooking(db, bookingId, { reason, refundAmount, notifyGuests = true }) {
  const b = bookings.getDetailed(db, bookingId);
  if (!b || !['confirmed', 'pending_payment'].includes(b.status)) throw new bookings.BookingError('Only active bookings can be cancelled.');
  let refundStatus = null;
  if (b.status === 'confirmed' && refundAmount > 0) {
    const p = bookingPayment(db, b);
    if (!p) throw new bookings.BookingError('No payment on record for this booking – cancel without a refund.');
    refundStatus = await refundPayment(db, p.id, refundAmount, reason || 'Booking cancelled');
  }
  db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?`)
    .run(String(reason || '').slice(0, 500), b.id);

  if (b.status === 'confirmed') {
    const refundLine = refundAmount > 0 ? `A refund of ${money.format(refundAmount, b.currency)} has been initiated to your original payment method (usually 5–7 working days).` : 'No refund applies to this cancellation.';
    const guestLine = notifyGuests ? 'We have let your invited guests know by WhatsApp and email.' : 'Your guests have not been notified – please let them know.';
    const text = `Assalamu Alaikum ${b.host_name.split(' ')[0]},\n\nYour booking "${b.title}" at ${b.venue_name}, ${b.restaurant_name} on ${fmt.longDate(b.event_date)} has been cancelled.\n${reason ? `\nReason: ${reason}\n` : ''}\n${refundLine}\n${guestLine}\n\nIf you have questions, reply to this email.\n\n– IftarParty`;
    await notify.sendEmail({ to: b.host_email, subject: `Booking cancelled: ${b.title}`, text, html: `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>` });
  }
  let guestsNotified = 0;
  if (b.status === 'confirmed' && notifyGuests && b.event_date >= bookings.todayISO()) {
    guestsNotified = await invites.sendCancellations(db, bookings.getDetailed(db, b.id));
  }
  return { refundStatus, guestsNotified };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { startPayment, settleOrder, refundPayment, refreshRefund, applyRefundWebhook, bookingPayment, cancelBooking };
