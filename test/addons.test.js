'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, futureDate, seedMarketplace, signin, request } = require('./helpers');

describe('menu packages & add-ons', () => {
  const { db, app } = makeApp();
  let fx;
  let owner;
  let host;
  let grill;
  let decor;

  before(async () => {
    fx = seedMarketplace(db);
    const bcrypt = require('bcryptjs');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync('password123', 4), fx.ownerId);
    owner = await signin(app, db.prepare('SELECT email FROM users WHERE id = ?').get(fx.ownerId).email);
    host = await signin(app, 'host@fixture.test');
  });

  test('restaurant creates per-guest and flat packages; bad input is rejected', async () => {
    let token = await csrf(owner, '/restaurant/addons/new');
    await owner.post('/restaurant/addons').type('form').send({ _csrf: token, name: 'Free?', pricing: 'flat', price: '0' }).expect(422);
    token = await csrf(owner, '/restaurant/addons/new');
    await owner.post('/restaurant/addons').type('form')
      .send({ _csrf: token, name: 'Live Kebab Grill', category: 'food', pricing: 'per_guest', price: '150', description: 'Seekh & boti' }).expect(302);
    token = await csrf(owner, '/restaurant/addons/new');
    await owner.post('/restaurant/addons').type('form')
      .send({ _csrf: token, name: 'Ramadan Décor', category: 'decor', pricing: 'flat', price: '5000' }).expect(302);
    [grill, decor] = db.prepare('SELECT * FROM addons ORDER BY id').all();
    assert.deepEqual([grill.pricing, grill.price, decor.pricing, decor.price], ['per_guest', 15000, 'flat', 500000]);
    const dash = await owner.get('/restaurant').expect(200);
    assert.match(dash.text, /Live Kebab Grill/);
  });

  test('venue page offers packages with data for the live quote', async () => {
    const page = await request(app).get(`/venues/${fx.venueId}`).expect(200);
    assert.match(page.text, /Packages &amp; add-ons/);
    assert.match(page.text, new RegExp(`name="addon_ids" value="${grill.id}" data-addon-price="15000" data-addon-pricing="per_guest"`));
  });

  test('reserving with packages prices them server-side and snapshots each line', async () => {
    const token = await csrf(host, `/venues/${fx.venueId}`);
    const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date: futureDate(15), guests: '40', menu_id: fx.menuId, addon_ids: [String(grill.id), String(decor.id)] }).expect(302);
    const id = Number(res.headers.location.match(/bookings\/(\d+)/)[1]);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    assert.equal(b.addons_total, 15000 * 40 + 500000);
    assert.equal(b.platform_fee, Math.round((b.food_total + b.hire_fee + b.addons_total) * 0.05));
    assert.equal(b.total_amount, b.food_total + b.hire_fee + b.addons_total + b.platform_fee);
    const lines = db.prepare('SELECT name, quantity, total FROM booking_addons WHERE booking_id = ? ORDER BY id').all(id).map((r) => ({ ...r }));
    assert.deepEqual(lines, [{ name: 'Live Kebab Grill', quantity: 40, total: 600000 }, { name: 'Ramadan Décor', quantity: 1, total: 500000 }]);

    const checkout = await host.get(`/bookings/${id}/checkout`).expect(200);
    assert.match(checkout.text, /Live Kebab Grill \(40 × ₹150\)/);

    // Later price edits never touch a booking that was already quoted.
    const t2 = await csrf(owner, `/restaurant/addons/${grill.id}/edit`);
    await owner.post(`/restaurant/addons/${grill.id}`).type('form').send({ _csrf: t2, name: 'Live Kebab Grill', pricing: 'per_guest', price: '999', category: 'food' }).expect(302);
    assert.equal(db.prepare('SELECT addons_total FROM bookings WHERE id = ?').get(id).addons_total, 1100000);
  });

  test('packages from another restaurant or withdrawn ones are refused', async () => {
    const other = seedMarketplace(db, { hostEmail: 'host@fixture.test' });
    const foreign = db.prepare(`INSERT INTO addons (restaurant_id, name, pricing, price) VALUES (?, 'Elsewhere', 'flat', 100)`).run(other.restaurantId).lastInsertRowid;
    let token = await csrf(host, `/venues/${fx.venueId}`);
    const before = db.prepare('SELECT COUNT(*) n FROM bookings').get().n;
    await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date: futureDate(16), guests: '20', menu_id: fx.menuId, addon_ids: String(foreign) }).expect(302);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bookings').get().n, before);

    token = await csrf(owner, '/restaurant');
    await owner.post(`/restaurant/addons/${decor.id}/toggle`).type('form').send({ _csrf: token }).expect(302);
    token = await csrf(host, `/venues/${fx.venueId}`);
    const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date: futureDate(17), guests: '20', menu_id: fx.menuId, addon_ids: String(decor.id) }).expect(302);
    assert.match(res.headers.location, new RegExp(`/venues/${fx.venueId}\\?.*addon=${decor.id}`), 'selection kept on the error redirect');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bookings').get().n, before);
    assert.doesNotMatch((await request(app).get(`/venues/${fx.venueId}`)).text, /Ramadan Décor/);
  });

  test('a restaurant cannot edit another restaurant’s package', async () => {
    const foreign = db.prepare(`SELECT id FROM addons WHERE name = 'Elsewhere'`).get().id;
    await owner.get(`/restaurant/addons/${foreign}/edit`).expect(404);
    const token = await csrf(owner, '/restaurant');
    await owner.post(`/restaurant/addons/${foreign}/toggle`).type('form').send({ _csrf: token }).expect(404);
  });
});
