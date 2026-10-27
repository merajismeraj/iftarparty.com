'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const config = require('../src/config');
const { makeApp, seedMarketplace, paidBooking, futureDate, request } = require('./helpers');
const notify = require('../src/services/notify');
const invites = require('../src/services/invites');
const svc = require('../src/services/bookings');

const GRAPH = 'https://graph.facebook.com/';

describe('WhatsApp via Meta Cloud API', () => {
  const { db, app } = makeApp();
  const calls = [];
  let reply;
  let realFetch;
  let wamid = 0;

  before(() => {
    Object.assign(config.whatsapp, { token: 'EAAG-test', phoneNumberId: '1098765', apiVersion: 'v23.0', templateLang: 'en', appSecret: 'app-secret', verifyToken: 'verify-me' });
    realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (!String(url).startsWith(GRAPH)) return realFetch(url, opts);
      calls.push({ url: String(url), opts, body: JSON.parse(opts.body) });
      const r = reply || { status: 200, body: { messaging_product: 'whatsapp', messages: [{ id: `wamid.${++wamid}` }] } };
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    };
  });
  after(() => {
    global.fetch = realFetch;
    Object.assign(config.whatsapp, { token: '', phoneNumberId: '', appSecret: '', verifyToken: '' });
  });

  test('sends an approved template with cleaned body parameters', async () => {
    const r = await notify.sendWhatsApp({ to: '+91 98765-43210', params: ['Aisha', 'Iftar Party by Meraj', 'Fri 12 Mar\n6:15 pm', '', 'https://iftarparty.com/rsvp/x'] });
    assert.deepEqual(r, { status: 'sent', detail: 'wamid.1', providerId: 'wamid.1' });
    const c = calls.at(-1);
    assert.equal(c.url, 'https://graph.facebook.com/v23.0/1098765/messages');
    assert.equal(c.opts.headers.Authorization, 'Bearer EAAG-test');
    assert.equal(c.body.to, '919876543210');
    assert.equal(c.body.type, 'template');
    assert.equal(c.body.template.name, 'iftar_invite');
    assert.deepEqual(c.body.template.language, { code: 'en' });
    // Newlines and empty values are rejected by Meta (error 132018), so they are cleaned first.
    assert.deepEqual(c.body.template.components[0].parameters.map((p) => p.text),
      ['Aisha', 'Iftar Party by Meraj', 'Fri 12 Mar 6:15 pm', '-', 'https://iftarparty.com/rsvp/x']);
  });

  test('Meta errors are reported with their code so admins can act on them', async () => {
    reply = { status: 400, body: { error: { message: '(#131026) Message undeliverable', code: 131026, error_data: { details: 'Receiver is incapable of receiving this message' } } } };
    const r = await notify.sendWhatsApp({ to: '+919876543210', params: ['x'] });
    assert.deepEqual(r, { status: 'failed', detail: '(#131026) Receiver is incapable of receiving this message' });
    reply = null;
  });

  test('without credentials messages are logged, not sent', async () => {
    const saved = config.whatsapp.token;
    config.whatsapp.token = '';
    const before = calls.length;
    assert.equal(notify.whatsappEnabled(), false);
    assert.equal((await notify.sendWhatsApp({ to: '+919876543210', params: [], previewText: 'hi' })).status, 'logged');
    assert.equal(calls.length, before);
    config.whatsapp.token = saved;
  });

  let guestId;
  let bookingId;
  test('invites go out as templates and store the WhatsApp message id; cancellations use their own template', async () => {
    const fx = await seedMarketplace(db);
    bookingId = await paidBooking(db, { ...fx, date: futureDate(25) });
    guestId = (await db.prepare(`INSERT INTO guests (booking_id, name, phone, rsvp_token) VALUES (?, 'Aisha Khan', '+919811111111', ?)`)
      .run(bookingId, invites.newToken())).lastInsertRowid;
    await invites.sendInvites(db, await svc.getDetailed(db, bookingId), 'new');
    const msg = await db.prepare(`SELECT * FROM message_log WHERE guest_id = ? AND channel = 'whatsapp'`).get(guestId);
    assert.equal(msg.status, 'sent');
    assert.match(msg.provider_id, /^wamid\./);
    assert.equal(calls.at(-1).body.template.components[0].parameters.length, 5);

    await invites.sendCancellations(db, { ...(await svc.getDetailed(db, bookingId)), cancel_reason: 'Venue flooded' });
    assert.equal(calls.at(-1).body.template.name, 'iftar_cancelled');
    assert.equal(calls.at(-1).body.template.components[0].parameters.length, 4);
  });

  const sign = (raw, secret = 'app-secret') => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const statusEvent = (id, status, errors) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id, status, timestamp: '1', recipient_id: '919811111111', ...(errors ? { errors } : {}) }] } }] }] });
  const post = (raw, sig = sign(raw)) => request(app).post('/webhooks/whatsapp').set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw);

  test('webhook verification answers Meta only with the right token', async () => {
    const ok = await request(app).get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444').expect(200);
    assert.equal(ok.text, '1158201444');
    await request(app).get('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1').expect(403);
  });

  test('status webhooks: signed only; delivered → read; never downgraded; failures carry the reason', async () => {
    const msg = await db.prepare(`SELECT * FROM message_log WHERE guest_id = ? AND channel = 'whatsapp' AND kind = 'invite'`).get(guestId);
    const guestStatus = async () => (await db.prepare('SELECT whatsapp_status FROM guests WHERE id = ?').get(guestId)).whatsapp_status;

    await post(statusEvent(msg.provider_id, 'read'), sign('x', 'wrong')).expect(401);
    await post(statusEvent(msg.provider_id, 'read'), 'sha256=00').expect(401);
    assert.equal(await guestStatus(), 'sent');

    await post(statusEvent(msg.provider_id, 'delivered')).expect(200);
    assert.equal(await guestStatus(), 'delivered');
    await post(statusEvent(msg.provider_id, 'read')).expect(200);
    assert.equal(await guestStatus(), 'read');
    await post(statusEvent(msg.provider_id, 'delivered')).expect(200); // arrives late
    assert.equal(await guestStatus(), 'read');
    await post(statusEvent('wamid.unknown', 'read')).expect(200);   // not ours: ignored

    // A failed delivery on a fresh invite shows on the host's list and in Admin → Messages.
    await invites.sendInvites(db, await svc.getDetailed(db, bookingId), guestId);
    const latest = await db.prepare(`SELECT * FROM message_log WHERE guest_id = ? AND channel = 'whatsapp' AND kind = 'invite' ORDER BY id DESC LIMIT 1`).get(guestId);
    await post(statusEvent(latest.provider_id, 'failed', [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Receiver is not on WhatsApp' } }])).expect(200);
    assert.equal(await guestStatus(), 'failed');
    const failed = await db.prepare('SELECT status, detail FROM message_log WHERE id = ?').get(latest.id);
    assert.deepEqual({ ...failed }, { status: 'failed', detail: '(#131026) Receiver is not on WhatsApp' });
  });

  test('without an app secret the webhook accepts nothing', async () => {
    const saved = config.whatsapp.appSecret;
    config.whatsapp.appSecret = '';
    const raw = statusEvent('wamid.1', 'read');
    await post(raw, sign(raw, '')).expect(401);
    config.whatsapp.appSecret = saved;
  });
});
