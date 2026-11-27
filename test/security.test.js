'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { makeApp, csrf, futureDate, seedMarketplace, signin } = require('./helpers');
const config = require('../src/config');

/** Load src/config.js in a fresh process with the given environment and return selected fields. */
function configWith(env) {
  const out = execFileSync(process.execPath, ['-e', `const c=require(${JSON.stringify(path.join(__dirname, '../src/config'))});process.stdout.write(JSON.stringify({s:c.sessionSecret,d:c.databaseUrl,k:c.supabase.serviceKey,p:c.demoPayments}))`],
    { env: { PATH: process.env.PATH, ...env } });
  return JSON.parse(out);
}

describe('production safety', () => {
  test('previews never get production data access, sessions or demo payments in production', () => {
    const shared = { SESSION_SECRET: 's3cret', POSTGRES_URL: 'postgres://prod', SUPABASE_SERVICE_ROLE_KEY: 'svc', VERCEL: '1', NODE_ENV: 'production' };
    const prod = configWith({ ...shared, VERCEL_ENV: 'production', DEMO_MODE: 'false' });
    const preview = configWith({ ...shared, VERCEL_ENV: 'preview', DEMO_MODE: 'true' });
    assert.deepEqual(prod, { s: 's3cret', d: 'postgres://prod', k: 'svc', p: false });
    assert.notEqual(preview.s, 's3cret', 'a preview cookie must not be valid on production');
    assert.equal(preview.d, '');
    assert.equal(preview.k, '');
    assert.equal(preview.p, true);
  });

  describe('without payment keys in production', () => {
    const { db, app } = makeApp();
    let fx;
    let host;
    before(async () => {
      fx = await seedMarketplace(db);
      host = await signin(app, 'host@fixture.test');
      config.demoPayments = false;
    });
    after(() => { config.demoPayments = true; });

    test('a booking cannot be confirmed through the demo payment page', async () => {
      let token = await csrf(host, `/venues/${fx.venueId}`);
      const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
        .send({ _csrf: token, date: futureDate(40), guests: '20', menu_id: fx.menuId }).expect(303);
      const id = Number(res.headers.location.match(/bookings\/(\d+)/)[1]);
      token = await csrf(host, `/bookings/${id}/checkout`);
      const pay = await host.post(`/bookings/${id}/pay`).type('form').send({ _csrf: token }).expect(303);
      assert.equal(pay.headers.location, `/bookings/${id}/checkout`);
      assert.match((await host.get(`/bookings/${id}/checkout`)).text, /Online payment isn’t available yet/);
      token = await csrf(host, `/bookings/${id}/checkout`);
      await host.post(`/bookings/${id}/demo-pay`).type('form').send({ _csrf: token, order_id: 'x' }).expect(404);
      assert.equal((await db.prepare('SELECT status FROM bookings WHERE id = ?').get(id)).status, 'pending_payment');
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM payments WHERE booking_id = ?').get(id)).n, 0);
    });
  });
});
