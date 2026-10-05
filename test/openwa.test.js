'use strict';
require('./helpers');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const notify = require('../src/services/notify');

describe('WhatsApp via OpenWA', () => {
  const calls = [];
  let realFetch;
  let reply = { status: 201, body: { id: 'msg_1' } };

  before(() => {
    Object.assign(config.whatsapp, { provider: 'openwa' });
    Object.assign(config.whatsapp.openwa, { url: 'http://openwa.test:2785/api/', apiKey: 'k-123', sessionId: 'iftar', minIntervalMs: 20 });
    realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      calls.push({ url, opts, at: Date.now() });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
    };
  });
  after(() => {
    global.fetch = realFetch;
    Object.assign(config.whatsapp.openwa, { url: '', apiKey: '', sessionId: '' });
  });

  test('sends the personalised text to the OpenWA send-text endpoint', async () => {
    assert.equal(notify.whatsappProvider(), 'openwa');
    const r = await notify.sendWhatsApp({ to: '+919876543210', params: ['x'], previewText: 'Assalamu Alaikum Aisha,\nYou’re invited!' });
    assert.deepEqual(r, { status: 'sent', detail: 'msg_1' });
    const c = calls.at(-1);
    assert.equal(c.url, 'http://openwa.test:2785/api/sessions/iftar/messages/send-text');
    assert.equal(c.opts.method, 'POST');
    assert.equal(c.opts.headers['X-API-Key'], 'k-123');
    assert.deepEqual(JSON.parse(c.opts.body), { chatId: '919876543210@c.us', text: 'Assalamu Alaikum Aisha,\nYou’re invited!' });
  });

  test('paces consecutive sends instead of bursting', async () => {
    calls.length = 0;
    await Promise.all([1, 2, 3].map((n) => notify.sendWhatsApp({ to: `+91987654321${n}`, params: [], previewText: 'hi' })));
    assert.equal(calls.length, 3);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 20, 'gap between sends');
  });

  test('reports gateway errors so the admin can retry', async () => {
    reply = { status: 409, body: { message: 'Session not connected – scan the QR code' } };
    const r = await notify.sendWhatsApp({ to: '+919876543210', params: [], previewText: 'hi' });
    assert.deepEqual(r, { status: 'failed', detail: 'Session not connected – scan the QR code' });
    reply = { status: 201, body: { id: 'msg_2' } };
  });

  test('without OpenWA settings messages are only logged', async () => {
    const saved = config.whatsapp.openwa.url;
    config.whatsapp.openwa.url = '';
    assert.equal(notify.whatsappProvider(), 'demo');
    assert.equal((await notify.sendWhatsApp({ to: '+919876543210', params: [], previewText: 'hi' })).status, 'logged');
    config.whatsapp.openwa.url = saved;
  });
});
