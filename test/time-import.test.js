'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, futureDate, seedMarketplace, signin, signinAdmin, request } = require('./helpers');
const pricing = require('../src/services/pricing');
const fmt = require('../src/services/format');
const restaurantImport = require('../src/services/restaurantImport');

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

  test('a booking gets the included 90 minutes by default', async () => {
    const page = await host.get(`/venues/${fx.venueId}`).expect(200);
    assert.match(page.text, /Includes 90 min at the venue/);
    const token = await csrf(host, `/venues/${fx.venueId}`);
    const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date: futureDate(20), guests: '20', menu_id: fx.menuId }).expect(302);
    const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(res.headers.location.match(/bookings\/(\d+)/)[1]));
    assert.equal(b.duration_minutes, 90);
    assert.equal(b.extra_time_total, 0);
  });

  test('a venue without an extra-time rate refuses longer bookings', async () => {
    const before = (await db.prepare('SELECT COUNT(*) n FROM bookings').get()).n;
    const token = await csrf(host, `/venues/${fx.venueId}`);
    const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date: futureDate(21), guests: '20', menu_id: fx.menuId, duration_minutes: '120' }).expect(302);
    assert.match(res.headers.location, /duration=120/);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM bookings').get()).n, before);
  });

  test('extra time is priced server-side, carries the platform fee and shows at checkout', async () => {
    await db.prepare('UPDATE venues SET extra_time_fee = 150000 WHERE id = ?').run(fx.venueId);
    const page = await host.get(`/venues/${fx.venueId}`).expect(200);
    assert.match(page.text, /data-duration/);
    assert.match(page.text, /value="150" data-extra="300000"/);
    const token = await csrf(host, `/venues/${fx.venueId}`);
    const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date: futureDate(22), guests: '20', menu_id: fx.menuId, duration_minutes: '150' }).expect(302);
    const id = Number(res.headers.location.match(/bookings\/(\d+)/)[1]);
    const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    assert.equal(b.duration_minutes, 150);
    assert.equal(b.extra_time_total, 300000);
    assert.equal(b.platform_fee, Math.round((b.food_total + b.hire_fee + b.extra_time_total) * 0.05));
    assert.equal(b.total_amount, b.food_total + b.hire_fee + b.extra_time_total + b.platform_fee);
    const checkout = await host.get(`/bookings/${id}/checkout`).expect(200);
    assert.match(checkout.text, /Extra time/);
    assert.match(checkout.text, /2 hr 30 min/);
  });

  test('admin changes the included time; bad values are rejected', async () => {
    const admin = await signinAdmin(app, db);
    let token = await csrf(admin, '/admin/settings');
    for (const bad of ['45', '0', '400']) {
      await admin.post('/admin/settings').type('form').send({ _csrf: token, platform_fee_percent: '5', included_minutes: bad }).expect(422);
    }
    token = await csrf(admin, '/admin/settings');
    await admin.post('/admin/settings').type('form').send({ _csrf: token, platform_fee_percent: '5', included_minutes: '120' }).expect(302);
    assert.match((await request(app).get(`/venues/${fx.venueId}`)).text, /2 hr \(included\)/);
    assert.ok(await db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'settings.update' AND detail LIKE '%included_minutes 90 → 120%'`).get());
  });
});

describe('admin bulk restaurant upload', () => {
  const { db, app } = makeApp();
  let admin;
  const upload = (agent, token, csv, fields = {}) => {
    let req = agent.post(`/admin/restaurants/import?_csrf=${encodeURIComponent(token)}`);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', Buffer.from(csv), 'restaurants.csv');
  };

  before(async () => {
    admin = await signinAdmin(app, db);
  });

  test('the sample sheet downloads and is itself a valid import', async () => {
    const res = await admin.get('/admin/restaurants/template.csv').expect(200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.equal(res.text.split('\n')[0], restaurantImport.COLUMNS.join(','));
    const parsed = restaurantImport.parseSheet(Buffer.from(res.text));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.restaurants.length, 2);
    assert.equal(parsed.restaurants[0].venues.length, 2);
    const page = await admin.get('/admin/restaurants').expect(200);
    assert.match(page.text, /href="\/admin\/restaurants\/import"/);
    const form = await admin.get('/admin/restaurants/import').expect(200);
    assert.match(form.text, /href="\/admin\/restaurants\/template.csv"/);
  });

  test('only admins can upload', async () => {
    await request(app).get('/admin/restaurants/template.csv').expect(302);
  });

  test('check shows problems per line and imports nothing', async () => {
    const csv = [
      restaurantImport.COLUMNS.join(','),
      'Good Place,Ali,ali@good.test,9820000001,Pune,,,,,Hall,10,50,0,0,,,,,,,',
      'Bad Place,Sara,not-an-email,123,,,,,,Hall,60,50,abc,0,,,Menu,0,,fish,',
    ].join('\n');
    const token = await csrf(admin, '/admin/restaurants/import');
    const res = await upload(admin, token, csv, { action: 'import' }).expect(422);
    for (const msg of [/not a valid email/, /not a valid mobile/, /city is required/]) assert.match(res.text, msg);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM restaurants').get()).n, 0);
  });

  test('check then import creates owners, restaurants, venues and menus atomically', async () => {
    const csv = (await admin.get('/admin/restaurants/template.csv')).text;
    let token = await csrf(admin, '/admin/restaurants/import');
    const check = await upload(admin, token, csv, { action: 'check', status: 'pending' }).expect(200);
    assert.match(check.text, /Ready to import 3 rows/);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM restaurants').get()).n, 0, 'check writes nothing');
    const sheet = check.text.match(/name="sheet" value="([^"]+)"/)[1];

    token = check.text.match(/_csrf=([A-Za-z0-9_%-]+)/)[1];
    await admin.post(`/admin/restaurants/import?_csrf=${token}`)
      .field('sheet', sheet).field('filename', 'restaurants.csv').field('status', 'pending').field('action', 'import').expect(302);

    const noor = await db.prepare(`SELECT r.*, u.role, u.password_hash, u.phone AS owner_phone FROM restaurants r JOIN users u ON u.id = r.owner_id WHERE lower(u.email) = 'ayesha@noorkitchen.in'`).get();
    assert.equal(noor.name, 'Noor Kitchen');
    assert.equal(noor.status, 'pending');
    assert.equal(noor.role, 'restaurant');
    assert.equal(noor.password_hash, '', 'owners sign in with Google');
    assert.equal(noor.owner_phone, '+919876543210');
    const venues = await db.prepare('SELECT name, min_pax, max_pax, hire_fee, extra_time_fee, amenities FROM venues WHERE restaurant_id = ? ORDER BY id').all(noor.id);
    assert.deepEqual(venues.map((v) => ({ ...v })), [
      { name: 'Rooftop Lounge', min_pax: 20, max_pax: 80, hire_fee: 500000, extra_time_fee: 150000, amenities: 'Open air, Prayer area' },
      { name: 'Banquet Hall', min_pax: 50, max_pax: 200, hire_fee: 1500000, extra_time_fee: 300000, amenities: 'Air-conditioned, Valet parking' },
    ]);
    const menu = await db.prepare(`SELECT * FROM menus WHERE restaurant_id = ? AND name = 'Royal Iftar Platter'`).get(noor.id);
    assert.equal(menu.price_per_person, 89900);
    assert.equal(menu.items.split('\n').length, 5);
    assert.ok(await db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'restaurant.bulk_import'`).get());

    // Re-uploading the same sheet: existing partners are recognised, and duplicate venue names refused.
    token = await csrf(admin, '/admin/restaurants/import');
    const again = await upload(admin, token, csv, { action: 'check' }).expect(422);
    assert.match(again.text, /already has a venue called/);
  });

  test('rows for an existing partner add venues to their restaurant', async () => {
    const csv = `${restaurantImport.COLUMNS.join(',')}\nNoor Kitchen,Ayesha Khan,AYESHA@noorkitchen.in,9876543210,Hyderabad,,,,,Garden,10,40,0,0,,,,,,,\n`;
    const token = await csrf(admin, '/admin/restaurants/import');
    await upload(admin, token, csv, { action: 'import' }).expect(302);
    const n = await db.prepare(`SELECT COUNT(*) n FROM venues v JOIN restaurants r ON r.id = v.restaurant_id JOIN users u ON u.id = r.owner_id WHERE u.email = 'ayesha@noorkitchen.in'`).get();
    assert.equal(n.n, 3);
    assert.equal((await db.prepare(`SELECT COUNT(*) n FROM users WHERE lower(email) = 'ayesha@noorkitchen.in'`).get()).n, 1);
  });

  test('a host or admin email cannot become a restaurant owner', async () => {
    const csv = `${restaurantImport.COLUMNS.join(',')}\nX,Y,admin@test.local,9820000002,Pune,,,,,,,,,,,,,,,,\n`;
    const token = await csrf(admin, '/admin/restaurants/import');
    const res = await upload(admin, token, csv, { action: 'import' }).expect(422);
    assert.match(res.text, /already registered as an admin/);
  });
});
