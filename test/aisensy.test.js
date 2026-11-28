'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const notify = require('../src/services/notify');

describe('WhatsApp through AiSensy API campaigns', () => {
  const realFetch = global.fetch;
  let calls = [];
  let reply = { status: 200, body: '{"success":"true"}' };
  before(() => {
    config.whatsapp.aisensy.apiKey = 'test-key';
    global.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return new Response(reply.body, { status: reply.status });
    };
  });
  after(() => {
    config.whatsapp.aisensy.apiKey = '';
    global.fetch = realFetch;
  });

  test('AiSensy takes priority and sends the invite campaign with the template variables in order', async () => {
    assert.equal(notify.whatsappProvider(), 'aisensy');
    calls = [];
    const r = await notify.sendWhatsApp({
      to: '+91 98765-43210', name: 'Aisha Khan',
      params: ['Aisha', 'Iftar Party by Meraj', 'Fri 20 Feb, 6:00 PM – 7:30 PM', 'Rooftop, Noor Kitchen\nBandra', 'https://iftarparty.com/r/abc'],
    });
    assert.equal(r.status, 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://backend.aisensy.com/campaign/t1/api/v2');
    assert.deepEqual(calls[0].body, {
      apiKey: 'test-key', campaignName: 'iftar_invite', destination: '+919876543210', userName: 'Aisha Khan', source: 'iftarparty.com',
      templateParams: ['Aisha', 'Iftar Party by Meraj', 'Fri 20 Feb, 6:00 PM – 7:30 PM', 'Rooftop, Noor Kitchen Bandra', 'https://iftarparty.com/r/abc'],
    });
  });

  test('cancellations use the cancel campaign', async () => {
    calls = [];
    await notify.sendWhatsApp({ to: '919811111111', name: 'Omar', params: ['Omar', 'Party', 'Fri', 'Venue'], template: config.whatsapp.cancelTemplateName });
    assert.equal(calls[0].body.campaignName, 'iftar_cancelled');
  });

  test('errors are reported with AiSensy’s reason', async () => {
    reply = { status: 400, body: '{"message":"Campaign not live"}' };
    const r = await notify.sendWhatsApp({ to: '919811111111', name: 'Omar', params: ['Omar'] });
    assert.deepEqual(r, { status: 'failed', detail: 'AiSensy HTTP 400: Campaign not live' });
    reply = { status: 200, body: '{}' };
  });
});

describe('admin WhatsApp test button', () => {
  const { makeApp, csrf, signinAdmin, signupHost } = require('./helpers');
  const { db, app } = makeApp();
  const realFetch = global.fetch;
  let calls = [];
  before(() => {
    config.whatsapp.aisensy.apiKey = 'test-key';
    global.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); };
  });
  after(() => { config.whatsapp.aisensy.apiKey = ''; global.fetch = realFetch; });

  test('sends one sample invitation, reports the result and is admin-only', async () => {
    const admin = await signinAdmin(app, db);
    let token = await csrf(admin, '/admin/settings');
    await admin.post('/admin/settings/whatsapp-test').type('form').send({ _csrf: token, phone: '12' }).expect(303);
    assert.equal(calls.length, 0);
    token = await csrf(admin, '/admin/settings');
    await admin.post('/admin/settings/whatsapp-test').type('form').send({ _csrf: token, phone: '98765 43210' }).expect(303);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].destination, '+919876543210');
    assert.equal(calls[0].campaignName, 'iftar_invite');
    assert.equal(calls[0].templateParams.length, 5);
    assert.match((await admin.get('/admin/settings')).text, /Test sent to \+919876543210/);
    assert.ok(await db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'whatsapp.test' AND detail LIKE '+91987654XXXX: sent%'`).get());

    const host = await signupHost(app, 'Some Host', 'h@x.test');
    token = await csrf(host, '/');
    await host.post('/admin/settings/whatsapp-test').type('form').send({ _csrf: token, phone: '9876543210' }).expect(403);
    assert.equal(calls.length, 1);
  });
});
