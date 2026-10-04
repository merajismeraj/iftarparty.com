'use strict';
/**
 * Cashfree Payment Gateway adapter (PG API, x-api-version 2023-08-01).
 * https://docs.cashfree.com/reference/pg-new-apis-endpoint
 *
 * Flow: create an order server-side -> hand payment_session_id to the Cashfree JS SDK, which
 * redirects to Cashfree's hosted checkout (UPI, cards, netbanking, wallets) -> Cashfree sends the
 * host back to return_url and posts a signed webhook to notify_url -> we re-fetch the order and
 * only trust order_status === 'PAID' with a matching amount.
 *
 * Without credentials every call is simulated ("demo" provider) so the full flow works locally.
 */
const crypto = require('node:crypto');
const config = require('../config');

const HOSTS = { sandbox: 'https://sandbox.cashfree.com/pg', production: 'https://api.cashfree.com/pg' };

class PaymentError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isLive = () => Boolean(config.cashfree.appId && config.cashfree.secretKey);
const provider = () => (isLive() ? 'cashfree' : 'demo');
const sdkMode = () => config.cashfree.env;

async function cf(method, path, body) {
  const res = await fetch(`${HOSTS[config.cashfree.env]}${path}`, {
    method,
    headers: {
      'x-client-id': config.cashfree.appId,
      'x-client-secret': config.cashfree.secretKey,
      'x-api-version': config.cashfree.apiVersion,
      'x-request-id': crypto.randomUUID(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new PaymentError(data.message || `Cashfree HTTP ${res.status}`, { status: res.status, code: data.code });
  }
  return data;
}

const toMajor = (minor) => Number((minor / 100).toFixed(2));
const toMinor = (major) => Math.round(Number(major) * 100);

/** Cashfree wants a 10-digit mobile for Indian customers. */
function cashfreePhone(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits;
}

/** Order ids embed the booking id so webhooks can be routed without extra state. */
function newOrderId(bookingId) {
  return `IP-${bookingId}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

function bookingIdFromOrder(orderId) {
  const m = /^IP-(\d+)-[a-z0-9]+$/.exec(String(orderId || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Create a payment order. Returns { orderId, sessionId } (sessionId is null in demo mode).
 * Cashfree requires order_expiry_time at least 15 minutes ahead.
 */
async function createOrder({ orderId, amount, currency, customer, returnUrl, notifyUrl, expiresAt, note }) {
  if (!isLive()) return { orderId, sessionId: null };
  const minExpiry = Date.now() + 16 * 60_000;
  const data = await cf('POST', '/orders', {
    order_id: orderId,
    order_amount: toMajor(amount),
    order_currency: currency,
    customer_details: {
      customer_id: customer.id,
      customer_name: customer.name,
      customer_email: customer.email,
      customer_phone: cashfreePhone(customer.phone),
    },
    order_meta: { return_url: returnUrl, notify_url: notifyUrl },
    order_expiry_time: new Date(Math.max(Date.parse(expiresAt), minExpiry)).toISOString(),
    order_note: String(note || '').slice(0, 200),
  });
  return { orderId: data.order_id, sessionId: data.payment_session_id };
}

/** Authoritative order state from Cashfree: { status: 'ACTIVE'|'PAID'|'EXPIRED'|..., amount, ref }. */
async function getOrder(orderId) {
  const data = await cf('GET', `/orders/${encodeURIComponent(orderId)}`);
  return { status: data.order_status, amount: toMinor(data.order_amount), currency: data.order_currency, ref: String(data.cf_order_id || '') };
}

/** Normalise Cashfree refund states to our ledger states. */
function refundState(cfStatus) {
  if (cfStatus === 'SUCCESS') return 'success';
  if (cfStatus === 'CANCELLED') return 'failed';
  return 'pending'; // PENDING, ONHOLD
}

/** Refund (part of) an order. Returns { status: 'pending'|'success'|'failed' }. Demo refunds succeed instantly. */
async function createRefund({ provider: prov, orderId, refundId, amount, note }) {
  if (prov === 'demo') return { status: 'success' };
  if (prov !== 'cashfree') throw new PaymentError(`This payment was taken via "${prov}" and must be refunded manually in that provider’s dashboard.`);
  if (!isLive()) throw new PaymentError('Cashfree credentials are not configured – cannot refund a Cashfree order.');
  const data = await cf('POST', `/orders/${encodeURIComponent(orderId)}/refunds`, {
    refund_amount: toMajor(amount),
    refund_id: refundId,
    refund_note: String(note || 'Refund').slice(0, 100),
    refund_speed: 'STANDARD',
  });
  return { status: refundState(data.refund_status) };
}

async function getRefund(orderId, refundId) {
  const data = await cf('GET', `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`);
  return { status: refundState(data.refund_status) };
}

/**
 * Verify a Cashfree webhook: signature = base64(HMAC-SHA256(timestamp + rawBody, secretKey)).
 * Rejects stale timestamps to blunt replays.
 */
function verifyWebhook(rawBody, timestamp, signature, { maxAgeMs = 10 * 60_000 } = {}) {
  if (!isLive() || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > maxAgeMs) return false;
  const expected = crypto.createHmac('sha256', config.cashfree.secretKey)
    .update(String(timestamp) + rawBody.toString('utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  PaymentError, isLive, provider, sdkMode, newOrderId, bookingIdFromOrder,
  createOrder, getOrder, createRefund, getRefund, verifyWebhook, cashfreePhone,
};
