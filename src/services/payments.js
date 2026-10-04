'use strict';
const Stripe = require('stripe');
const config = require('../config');

let stripe;
function client() {
  if (!config.stripe.secretKey) return null;
  stripe ??= new Stripe(config.stripe.secretKey);
  return stripe;
}

const isLive = () => Boolean(client());

/**
 * Start payment for a held booking. Returns the URL to send the host to:
 * Stripe Checkout when configured, otherwise the built-in demo payment page.
 */
async function startCheckout(booking) {
  const s = client();
  if (!s) return `/bookings/${booking.id}/demo-pay`;
  // Stripe requires 30min–24h; align with our hold so a lapsed hold can't be paid.
  const expiresAt = Math.max(Date.parse(booking.hold_expires_at), Date.now() + 30 * 60_000 + 5_000);
  const session = await s.checkout.sessions.create({
    mode: 'payment',
    customer_email: booking.host_email,
    client_reference_id: String(booking.id),
    metadata: { booking_id: String(booking.id) },
    expires_at: Math.floor(expiresAt / 1000),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: booking.currency.toLowerCase(),
        unit_amount: booking.total_amount,
        product_data: {
          name: `${booking.title} – ${booking.venue_name}, ${booking.restaurant_name}`,
          description: `${booking.event_date} · ${booking.guest_count} guests · ${booking.menu_name}`,
        },
      },
    }],
    success_url: `${config.baseUrl}/bookings/${booking.id}/payment-return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/bookings/${booking.id}/checkout`,
  });
  return session.url;
}

/** Fetch a Checkout Session and report whether it paid for the given booking. */
async function verifySession(sessionId, bookingId) {
  const s = client();
  if (!s || !sessionId) return null;
  const session = await s.checkout.sessions.retrieve(sessionId);
  const paid = session.payment_status === 'paid' && session.metadata?.booking_id === String(bookingId);
  return paid ? { provider: 'stripe', ref: String(session.payment_intent || session.id) } : null;
}

/** Verify and decode a Stripe webhook. Throws on a bad signature. */
function parseWebhook(rawBody, signature) {
  const s = client();
  if (!s || !config.stripe.webhookSecret) throw new Error('Stripe webhook not configured');
  return s.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

module.exports = { isLive, startCheckout, verifySession, parseWebhook };
