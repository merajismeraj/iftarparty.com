'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeApp, csrf, futureDate, seedMarketplace, signin, request } = require('./helpers');
const config = require('../src/config');
const payments = require('../src/services/payments');

/** In-memory stand-in for the Cashfree PG API. */
function fakeCashfree() {
  const state = { orders: new Map(), refunds: [], calls: [], seq: 1 };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host !== 'sandbox.cashfree.com') return realFetch(url, opts);
    const body = opts.body ? JSON.parse(opts.body) : null;
    state.calls.push({ method: opts.method, path: u.pathname, body, headers: opts.headers });
    if (opts.headers['x-client-secret'] !== 'cf-secret') return json(401, { message: 'authentication Failed', code: 'request_failed' });
    let m;
    if (opts.method === 'POST' && u.pathname === '/pg/orders') {
      const o = { ...body, order_status: 'ACTIVE', cf_order_id: state.seq++ };
      state.orders.set(body.order_id, o);
      return json(200, { ...o, payment_session_id: `session_${body.order_id}` });
    }
    if ((m = u.pathname.match(/^\/pg\/orders\/([^/]+)$/)) && opts.method === 'GET') {
      const o = state.orders.get(decodeURIComponent(m[1]));
      return o ? json(200, o) : json(404, { message: 'order not found' });
    }
    if ((m = u.pathname.match(/^\/pg\/orders\/([^/]+)\/refunds$/)) && opts.method === 'POST') {
      state.refunds.push({ order_id: decodeURIComponent(m[1]), ...body });
      return json(200, { refund_id: body.refund_id, refund_status: 'PENDING' });
    }
    if ((m = u.pathname.match(/^\/pg\/orders\/([^/]+)\/refunds\/([^/]+)$/))) return json(200, { refund_status: 'SUCCESS' });
    return json(404, { message: 'no route' });
  };
  state.pay = (orderId, amount) => {
    const o = state.orders.get(orderId);
    o.order_status = 'PAID';
    if (amount !== undefined) o.order_amount = amount;
  };
  state.restore = () => { global.fetch = realFetch; };
  return state;
}

function sign(body, ts = String(Date.now())) {
  return { ts, sig: crypto.createHmac('sha256', 'cf-secret').update(ts + body).digest('base64') };
}

describe('Cashfree payments', () => {
  const { db, app } = makeApp();
  let cf;
  let fx;
  let host;

  before(async () => {
    Object.assign(config.cashfree, { appId: 'cf-app', secretKey: 'cf-secret', env: 'sandbox' });
    cf = fakeCashfree();
    fx = seedMarketplace(db);
    host = await signin(app, 'host@fixture.test');
  });
  after(() => {
    cf.restore();
    Object.assign(config.cashfree, { appId: '', secretKey: '' });
  });

  async function reserve(agent, date, guests = 20) {
    const token = await csrf(agent, `/venues/${fx.venueId}`);
    const res = await agent.post(`/venues/${fx.venueId}/reserve`).type('form').send({ _csrf: token, date, guests, menu_id: fx.menuId }).expect(302);
    return Number(res.headers.location.match(/bookings\/(\d+)/)[1]);
  }
  async function pay(agent, bookingId) {
    const token = await csrf(agent, `/bookings/${bookingId}/checkout`);
    const res = await agent.post(`/bookings/${bookingId}/pay`).type('form').send({ _csrf: token }).expect(200);
    return { res, orderId: [...cf.orders.keys()].pop() };
  }

  test('creates a Cashfree order and hands the session to the JS SDK', async () => {
    const id = await reserve(host, futureDate(40));
    const { res, orderId } = await pay(host, id);
    const call = cf.calls.find((c) => c.method === 'POST' && c.path === '/pg/orders');
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    assert.equal(call.headers['x-api-version'], '2023-08-01');
    assert.equal(call.body.order_amount, b.total_amount / 100);
    assert.equal(call.body.order_currency, 'INR');
    assert.equal(call.body.customer_details.customer_phone, '9812312312');
    assert.equal(call.body.order_meta.return_url, `http://test.local/bookings/${id}/payment-return?order_id={order_id}`);
    assert.equal(call.body.order_meta.notify_url, 'http://test.local/webhooks/cashfree');
    assert.ok(Date.parse(call.body.order_expiry_time) >= Date.now() + 15 * 60_000);
    assert.match(res.text, /data-cashfree-session="session_IP-/);
    assert.match(res.text, /sdk\.cashfree\.com\/js\/v3\/cashfree\.js/);
    assert.match(res.headers['content-security-policy'], /script-src 'self' https:\/\/sdk\.cashfree\.com/);
    assert.equal(db.prepare('SELECT provider, status FROM payments WHERE order_id = ?').get(orderId).provider, 'cashfree');

    // Return before paying → not confirmed
    await host.get(`/bookings/${id}/payment-return?order_id=${orderId}`).expect(302);
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'pending_payment');

    // Paid → confirmed, ledger updated
    cf.pay(orderId);
    const done = await host.get(`/bookings/${id}/payment-return?order_id=${orderId}`).expect(302);
    assert.match(done.headers.location, new RegExp(`/bookings/${id}\\?welcome=1`));
    const after = db.prepare('SELECT status, payment_ref, payment_provider FROM bookings WHERE id = ?').get(id);
    assert.deepEqual({ ...after }, { status: 'confirmed', payment_ref: orderId, payment_provider: 'cashfree' });
    assert.equal(db.prepare('SELECT status FROM payments WHERE order_id = ?').get(orderId).status, 'paid');
  });

  test('an amount mismatch never confirms the booking', async () => {
    const id = await reserve(host, futureDate(41));
    const { orderId } = await pay(host, id);
    cf.pay(orderId, 1);
    await host.get(`/bookings/${id}/payment-return?order_id=${orderId}`).expect(302);
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'pending_payment');
  });

  test('a return URL carrying another booking’s order is ignored', async () => {
    const id = await reserve(host, futureDate(42));
    await host.get(`/bookings/${id}/payment-return?order_id=IP-1-abc`).expect(302);
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'pending_payment');
  });

  test('webhook: rejects bad signatures, confirms on PAYMENT_SUCCESS, refunds a duplicate payment', async () => {
    const id = await reserve(host, futureDate(43));
    const first = (await pay(host, id)).orderId;
    const second = (await pay(host, id)).orderId; // host opened checkout twice
    cf.pay(first);
    cf.pay(second);

    const body = (orderId) => JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: orderId }, payment: { payment_status: 'SUCCESS' } } });
    let b = body(first);
    await request(app).post('/webhooks/cashfree').set('content-type', 'application/json')
      .set('x-webhook-timestamp', String(Date.now())).set('x-webhook-signature', 'forged').send(b).expect(401);
    let s = sign(b);
    await request(app).post('/webhooks/cashfree').set('content-type', 'application/json')
      .set('x-webhook-timestamp', s.ts).set('x-webhook-signature', s.sig).send(b).expect(200);
    assert.equal(db.prepare('SELECT payment_ref FROM bookings WHERE id = ?').get(id).payment_ref, first);

    b = body(second);
    s = sign(b);
    await request(app).post('/webhooks/cashfree').set('content-type', 'application/json')
      .set('x-webhook-timestamp', s.ts).set('x-webhook-signature', s.sig).send(b).expect(200);
    const dup = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(second);
    assert.equal(dup.refund_status, 'pending');
    assert.equal(dup.refund_amount, dup.amount);
    assert.deepEqual(cf.refunds.map((r) => r.order_id), [second]);

    // Refund webhook completes it; replaying the success webhook does not refund twice.
    const rb = JSON.stringify({ type: 'REFUND_STATUS_WEBHOOK', data: { refund: { order_id: second, refund_id: dup.refund_id, refund_status: 'SUCCESS' } } });
    s = sign(rb);
    await request(app).post('/webhooks/cashfree').set('content-type', 'application/json')
      .set('x-webhook-timestamp', s.ts).set('x-webhook-signature', s.sig).send(rb).expect(200);
    assert.equal(db.prepare('SELECT refund_status FROM payments WHERE order_id = ?').get(second).refund_status, 'success');
    s = sign(b);
    await request(app).post('/webhooks/cashfree').set('content-type', 'application/json')
      .set('x-webhook-timestamp', s.ts).set('x-webhook-signature', s.sig).send(b).expect(200);
    assert.equal(cf.refunds.length, 1);
  });

  test('a payment that lands after the hold lapsed and the night was re-sold is auto-refunded', async () => {
    const date = futureDate(44);
    const id = await reserve(host, date);
    const { orderId } = await pay(host, id);
    db.prepare(`UPDATE bookings SET hold_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(id);

    seedMarketplace(db, { hostEmail: 'rival@fixture.test' });
    const rival = await signin(app, 'rival@fixture.test');
    const rivalId = await reserve(rival, date);
    const rivalOrder = (await pay(rival, rivalId)).orderId;
    cf.pay(rivalOrder);
    await rival.get(`/bookings/${rivalId}/payment-return?order_id=${rivalOrder}`).expect(302);

    cf.pay(orderId);
    await host.get(`/bookings/${id}/payment-return?order_id=${orderId}`).expect(302);
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'cancelled');
    assert.equal(db.prepare('SELECT refund_status FROM payments WHERE order_id = ?').get(orderId).refund_status, 'pending');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM bookings WHERE venue_id = ? AND event_date = ? AND status = 'confirmed'`).get(fx.venueId, date).n, 1);
  });

  test('gateway outage on order creation is reported, not a 500', async () => {
    const id = await reserve(host, futureDate(45));
    config.cashfree.secretKey = 'wrong';
    try {
      const token = await csrf(host, `/bookings/${id}/checkout`);
      const res = await host.post(`/bookings/${id}/pay`).type('form').send({ _csrf: token }).expect(302);
      assert.equal(res.headers.location, `/bookings/${id}/checkout`);
    } finally {
      config.cashfree.secretKey = 'cf-secret';
    }
  });
});

describe('Cashfree webhook signature', () => {
  beforeEach(() => Object.assign(config.cashfree, { appId: 'cf-app', secretKey: 'cf-secret' }));
  after(() => Object.assign(config.cashfree, { appId: '', secretKey: '' }));

  test('accepts a fresh valid signature, rejects stale or tampered ones', () => {
    const body = '{"a":1}';
    const { ts, sig } = sign(body);
    assert.ok(payments.verifyWebhook(Buffer.from(body), ts, sig));
    assert.ok(!payments.verifyWebhook(Buffer.from('{"a":2}'), ts, sig));
    const old = sign(body, String(Date.now() - 60 * 60_000));
    assert.ok(!payments.verifyWebhook(Buffer.from(body), old.ts, old.sig));
  });

  test('order ids round-trip the booking id', () => {
    assert.equal(payments.bookingIdFromOrder(payments.newOrderId(42)), 42);
    assert.equal(payments.bookingIdFromOrder('IP-42-../x'), null);
    assert.equal(payments.cashfreePhone('+919812312312'), '9812312312');
  });
});
