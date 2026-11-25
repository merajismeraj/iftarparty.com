'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, futureDate, seedMarketplace, signin, signinAdmin, request } = require('./helpers');
const pricing = require('../src/services/pricing');
const fmt = require('../src/services/format');
const sessions = require('../src/services/sessions');
const sunset = require('../src/services/sunset');

describe('time at the venue', () => {
  const { db, app } = makeApp();
  let fx;
  let host;

  before(async () => {
    fx = await seedMarketplace(db);
    host = await signin(app, 'host@fixture.test');
  });

  test('extra time is sold in 30-minute blocks on top of the included time', () => {
    assert.deepEqual(pricing.extraTime({ durationMinutes: '', includedMinutes: 90, feePerBlock: 0 }), { minutes: 90, blocks: 0, total: 0 });
    assert.deepEqual(pricing.extraTime({ durationMinutes: '150', includedMinutes: 90, feePerBlock: 2000 }), { minutes: 150, blocks: 2, total: 4000 });
    for (const bad of ['60', '100', '300', 'abc']) {
      assert.throws(() => pricing.extraTime({ durationMinutes: bad, includedMinutes: 90, feePerBlock: 2000 }), RangeError, bad);
    }
    assert.throws(() => pricing.extraTime({ durationMinutes: '120', includedMinutes: 90, feePerBlock: 0 }), /does not offer extra time/);
    assert.equal(pricing.durationOptions({ includedMinutes: 90, feePerBlock: 0 }).length, 1);
    assert.deepEqual(pricing.durationOptions({ includedMinutes: 90, feePerBlock: 100 }).at(-1), { minutes: 270, extra: 600 });
    const q = pricing.quote({ pricePerPerson: 1000, guestCount: 10, hireFee: 0, extraTimeTotal: 2000, feePercent: 10 });
    assert.equal(q.total, Math.round(12000 * 1.1));
    assert.equal(fmt.duration(90), '90 min');
    assert.equal(fmt.duration(150), '2 hr 30 min');
    assert.equal(fmt.timeRange('18:15', 90), '6:15 PM – 7:45 PM');
  });

  test('an Iftar booking starts 20 minutes before Maghrib and gets the included 90 minutes', async () => {
    const page = await host.get(`/venues/${fx.venueId}`).expect(200);
    assert.match(page.text, /Iftar only · 90 min/);
    const token = await csrf(host, `/venues/${fx.venueId}`);
    const date = futureDate(20);
    const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date, guests: '20', menu_id: fx.menuId }).expect(303);
    const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(res.headers.location.match(/bookings\/(\d+)/)[1]));
    assert.equal(b.session, 'iftar');
    assert.equal(b.duration_minutes, 90);
    assert.equal(b.extra_time_total, 0);
    const maghrib = sunset.maghrib(date, 'Mumbai');
    assert.equal(b.arrival_time, sessions.toHHMM(Math.floor((maghrib - 20) / 5) * 5));
  });

  test('a venue without an extra-time rate refuses longer bookings', async () => {
    const before = (await db.prepare('SELECT COUNT(*) n FROM bookings').get()).n;
    const token = await csrf(host, `/venues/${fx.venueId}`);
    const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date: futureDate(21), guests: '20', menu_id: fx.menuId, extra_minutes: '30' }).expect(303);
    assert.match(res.headers.location, /extra=30/);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM bookings').get()).n, before);
  });

  test('extra time is priced server-side, carries the platform fee and shows at checkout', async () => {
    await db.prepare('UPDATE venues SET extra_time_fee = 150000 WHERE id = ?').run(fx.venueId);
    const page = await host.get(`/venues/${fx.venueId}`).expect(200);
    assert.match(page.text, /data-duration/);
    assert.match(page.text, /value="60" data-extra="300000"/);
    const token = await csrf(host, `/venues/${fx.venueId}`);
    const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date: futureDate(22), guests: '20', menu_id: fx.menuId, extra_minutes: '60' }).expect(303);
    const id = Number(res.headers.location.match(/bookings\/(\d+)/)[1]);
    const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    assert.equal(b.duration_minutes, 150);
    assert.equal(b.extra_time_total, 300000);
    assert.equal(b.platform_fee, Math.round((b.food_total + b.hire_fee + b.extra_time_total) * 0.05));
    assert.equal(b.total_amount, b.food_total + b.hire_fee + b.extra_time_total + b.platform_fee);
    const checkout = await host.get(`/bookings/${id}/checkout`).expect(200);
    assert.match(checkout.text, /Extra time/);
    assert.match(checkout.text, /2 hr 30 min/);
    assert.match(checkout.text, /Iftar only/);
  });

  test('legacy total-duration forms still work for Iftar', async () => {
    const token = await csrf(host, `/venues/${fx.venueId}`);
    const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date: futureDate(23), guests: '20', menu_id: fx.menuId, duration_minutes: '120' }).expect(303);
    const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(res.headers.location.match(/bookings\/(\d+)/)[1]));
    assert.equal(b.duration_minutes, 120);
    assert.equal(b.extra_time_total, 150000);
  });

  test('admin changes the included time; bad values are rejected', async () => {
    const admin = await signinAdmin(app, db);
    let token = await csrf(admin, '/admin/settings');
    for (const bad of ['45', '0', '400']) {
      await admin.post('/admin/settings').type('form').send({ _csrf: token, platform_fee_percent: '5', included_minutes: bad }).expect(422);
    }
    token = await csrf(admin, '/admin/settings');
    await admin.post('/admin/settings').type('form').send({ _csrf: token, platform_fee_percent: '5', included_minutes: '120' }).expect(303);
    assert.match((await request(app).get(`/venues/${fx.venueId}`)).text, /Iftar only · 2 hr/);
    assert.ok(await db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'settings.update' AND detail LIKE '%included_minutes 90 → 120%'`).get());
  });
});
