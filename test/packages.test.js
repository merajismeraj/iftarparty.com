'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, futureDate, seedMarketplace, signin, request } = require('./helpers');

describe('budget / tier packages with dish choices', () => {
  const { db, app } = makeApp();
  let fx;
  let owner;
  let host;
  let silver;
  let gold;
  const dish = (name) => db.prepare('SELECT id FROM dishes WHERE name = ?').get(name).id;

  before(async () => {
    fx = seedMarketplace(db);
    const bcrypt = require('bcryptjs');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync('password123', 4), fx.ownerId);
    owner = await signin(app, db.prepare('SELECT email FROM users WHERE id = ?').get(fx.ownerId).email);
    host = await signin(app, 'host@fixture.test');
  });

  test('restaurant builds a dish catalogue', async () => {
    const add = async (name, course, diet = 'non-veg') => {
      const token = await csrf(owner, '/restaurant/dishes');
      await owner.post('/restaurant/dishes').type('form').send({ _csrf: token, name, course, diet }).expect(302);
    };
    for (const [n, c, d] of [['Chicken samosa', 'starters'], ['Paneer tikka', 'starters', 'veg'], ['Chicken 65', 'starters'],
      ['Galouti kebab', 'starters'], ['Phirni', 'desserts', 'veg'], ['Kheer', 'desserts', 'veg'], ['Mutton haleem', 'mains']]) await add(n, c, d);
    const token = await csrf(owner, '/restaurant/dishes');
    await owner.post('/restaurant/dishes').type('form').send({ _csrf: token, name: 'Mystery', course: 'appetisers' }).expect(302);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dishes').get().n, 7);
    assert.match((await owner.get('/restaurant/dishes')).text, /Galouti kebab/);
  });

  test('package definitions are validated', async () => {
    let token = await csrf(owner, '/restaurant/menus/new?kind=package');
    let res = await owner.post('/restaurant/menus').type('form').send({ _csrf: token, kind: 'package', name: 'Empty', price_per_person: '700' }).expect(422);
    assert.match(res.text, /at least one course/);
    token = await csrf(owner, '/restaurant/menus/new?kind=package');
    res = await owner.post('/restaurant/menus').type('form').send({
      _csrf: token, kind: 'package', name: 'Too greedy', price_per_person: '700', choose_starters: '3', dishes_starters: [dish('Chicken samosa'), dish('Paneer tikka')],
    }).expect(422);
    assert.match(res.text, /tick at least 3 eligible dishes/);
  });

  test('Silver and Gold tiers with different eligible dishes', async () => {
    let token = await csrf(owner, '/restaurant/menus/new?kind=package');
    await owner.post('/restaurant/menus').type('form').send({
      _csrf: token, kind: 'package', name: 'Silver Package', price_per_person: '700', min_pax: '10', diet: 'mixed',
      choose_starters: '2', dishes_starters: [dish('Chicken samosa'), dish('Paneer tikka'), dish('Chicken 65')],
      choose_desserts: '1', dishes_desserts: [dish('Phirni'), dish('Kheer')],
      choose_mains: '0', dishes_mains: [dish('Mutton haleem')], // 0 = course not included
    }).expect(302);
    token = await csrf(owner, '/restaurant/menus/new?kind=package');
    await owner.post('/restaurant/menus').type('form').send({
      _csrf: token, kind: 'package', name: 'Gold Package', price_per_person: '1000', min_pax: '10', diet: 'mixed',
      choose_starters: '3', dishes_starters: [dish('Chicken samosa'), dish('Paneer tikka'), dish('Chicken 65'), dish('Galouti kebab')],
      choose_mains: '1', dishes_mains: [dish('Mutton haleem')],
      choose_desserts: '2', dishes_desserts: [dish('Phirni'), dish('Kheer')],
    }).expect(302);
    silver = db.prepare(`SELECT * FROM menus WHERE name = 'Silver Package'`).get();
    gold = db.prepare(`SELECT * FROM menus WHERE name = 'Gold Package'`).get();
    assert.equal(silver.kind, 'package');
    assert.deepEqual(db.prepare('SELECT course, choose FROM menu_rules WHERE menu_id = ? ORDER BY course').all(silver.id).map((r) => `${r.course}:${r.choose}`), ['desserts:1', 'starters:2']);

    const page = await request(app).get(`/venues/${fx.venueId}`).expect(200);
    assert.match(page.text, /Choose 2 starters · 1 dessert/);
    assert.match(page.text, /Choose 3 starters · 1 main · 2 desserts/);
    assert.match(page.text, new RegExp(`data-picker-for="${gold.id}"`));
    const dash = await owner.get('/restaurant').expect(200);
    assert.match(dash.text, /2 starters · 1 dessert/);
  });

  async function reserve(menuId, dishIds, date) {
    const token = await csrf(host, `/venues/${fx.venueId}`);
    const res = await host.post(`/venues/${fx.venueId}/reserve`).type('form')
      .send({ _csrf: token, date, guests: '20', menu_id: String(menuId), dish_ids: dishIds.map(String) }).expect(302);
    const m = res.headers.location.match(/^\/bookings\/(\d+)\/checkout/);
    return { id: m ? Number(m[1]) : null, location: res.headers.location };
  }

  test('host picks dishes within the quota; anything else is refused', async () => {
    const date = futureDate(30);
    let r = await reserve(silver.id, [dish('Chicken samosa'), dish('Paneer tikka'), dish('Chicken 65'), dish('Phirni')], date);
    assert.equal(r.id, null, 'three starters on a two-starter package');
    assert.match(r.location, /dish=/, 'picks are kept on the error redirect');
    r = await reserve(silver.id, [dish('Galouti kebab'), dish('Phirni')], date);
    assert.equal(r.id, null, 'Gold-only dish on Silver');
    r = await reserve(silver.id, [dish('Chicken samosa')], date);
    assert.equal(r.id, null, 'dessert missing');

    r = await reserve(silver.id, [dish('Chicken samosa'), dish('Paneer tikka'), dish('Kheer')], date);
    assert.ok(r.id);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(r.id);
    assert.equal(b.price_per_person, 70000);
    const picks = db.prepare('SELECT name, course FROM booking_dishes WHERE booking_id = ? ORDER BY course, name').all(r.id).map((x) => `${x.course}:${x.name}`);
    assert.deepEqual(picks, ['desserts:Kheer', 'starters:Chicken samosa', 'starters:Paneer tikka']);
    const checkout = await host.get(`/bookings/${r.id}/checkout`).expect(200);
    assert.match(checkout.text, /Starters:<\/span> Chicken samosa, Paneer tikka/);
  });

  test('set menus still book without dish picks', async () => {
    const r = await reserve(fx.menuId, [dish('Phirni')], futureDate(31));
    assert.ok(r.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM booking_dishes WHERE booking_id = ?').get(r.id).n, 0);
  });

  test('host can change dishes until 2 days before, then the menu is final', async () => {
    const { paidBooking } = require('./helpers');
    const id = await paidBooking(db, { ...fx, menuId: gold.id, date: futureDate(20), dishIds: [] }).catch(() => null);
    assert.equal(id, null, 'package booking without picks is refused by the service too');
    const svc = require('../src/services/bookings');
    const bid = svc.createHold(db, { venueId: fx.venueId, menuId: gold.id, hostId: fx.hostId, eventDate: futureDate(20), guestCount: 20,
      dishIds: [dish('Chicken samosa'), dish('Paneer tikka'), dish('Chicken 65'), dish('Mutton haleem'), dish('Phirni'), dish('Kheer')] });
    db.prepare(`UPDATE bookings SET status = 'confirmed', payment_ref = 'x' WHERE id = ?`).run(bid);

    const party = await host.get(`/bookings/${bid}`).expect(200);
    assert.match(party.text, /Change dishes/);
    let token = await csrf(host, `/bookings/${bid}/menu`);
    await host.post(`/bookings/${bid}/menu`).type('form').send({ _csrf: token, dish_ids: [dish('Galouti kebab'), dish('Chicken 65'), dish('Paneer tikka'), dish('Mutton haleem'), dish('Kheer')].map(String) }).expect(302);
    assert.deepEqual(db.prepare(`SELECT name FROM booking_dishes WHERE booking_id = ? AND course = 'starters' ORDER BY name`).all(bid).map((x) => x.name),
      ['Chicken 65', 'Galouti kebab', 'Paneer tikka']);
    token = await csrf(host, `/bookings/${bid}/menu`);
    await host.post(`/bookings/${bid}/menu`).type('form').send({ _csrf: token, dish_ids: [dish('Kheer')].map(String) }).expect(422);

    db.prepare(`UPDATE bookings SET event_date = date('now', '+1 day') WHERE id = ?`).run(bid);
    await host.get(`/bookings/${bid}/menu`).expect(302);
    token = await csrf(host, '/my-parties');
    await host.post(`/bookings/${bid}/menu`).type('form').send({ _csrf: token, dish_ids: [dish('Chicken samosa')].map(String) }).expect(302);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM booking_dishes WHERE booking_id = ? AND name = 'Galouti kebab'`).get(bid).n, 1, 'unchanged after cutoff');
    assert.doesNotMatch((await host.get(`/bookings/${bid}`)).text, /Change dishes/);
  });

  test('unavailable dishes disappear from packages but stay on existing bookings', async () => {
    const token = await csrf(owner, '/restaurant/dishes');
    await owner.post(`/restaurant/dishes/${dish('Galouti kebab')}/toggle`).type('form').send({ _csrf: token }).expect(302);
    const page = await request(app).get(`/venues/${fx.venueId}`);
    assert.doesNotMatch(page.text, /Galouti kebab/);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM booking_dishes WHERE name = 'Galouti kebab'`).get().n, 1);
  });

  test('search: dish names inside packages, per-guest and total budgets', async () => {
    const listed = async (qs) => new RegExp(`href="/venues/${fx.venueId}[?"]`).test((await request(app).get(`/search?${qs}`)).text);
    assert.ok(await listed('menu=paneer+tikka'), 'dish inside a package');
    assert.ok(!(await listed('menu=galouti')), 'unavailable dish no longer matches');
    assert.ok(await listed('budget=500&budget_type=guest'), 'set menu at ₹500 fits');
    assert.ok(!(await listed('budget=400&budget_type=guest')));
    // 20 guests × ₹500 + ₹1,000 hall = ₹11,000 + 5% = ₹11,550
    assert.ok(await listed('guests=20&budget=11550&budget_type=total'));
    assert.ok(!(await listed('guests=20&budget=11549&budget_type=total')));
    const res = await request(app).get('/search?budget=11550&budget_type=total');
    assert.match(res.text, /Add the number of guests/);
    const card = await request(app).get('/search?guests=20&budget=15000&budget_type=total');
    assert.match(card.text, /Fits budget<\/span> est. ₹11,550 total/);
  });

  test('venue page marks each menu and package against the budget', async () => {
    const page = await request(app).get(`/venues/${fx.venueId}?guests=20&budget=15000&budget_type=total`).expect(200);
    // Silver: 20×700+1000 = 15,000 + 5% = 15,750 → over by 750. Set menu fits.
    assert.match(page.text, /Over budget by ₹750/);
    assert.match(page.text, /Within budget/);
    assert.match(page.text, /data-budget="1500000" data-budget-type="total"/);
  });

  test('guests see the chosen dishes on their invitation', async () => {
    const bid = db.prepare(`SELECT booking_id FROM booking_dishes WHERE name = 'Galouti kebab'`).get().booking_id;
    const invites = require('../src/services/invites');
    const token = invites.newToken();
    db.prepare(`INSERT INTO guests (booking_id, name, email, rsvp_token) VALUES (?, 'Guest', 'g@x.test', ?)`).run(bid, token);
    const page = await request(app).get(`/rsvp/${token}`).expect(200);
    assert.match(page.text, /Galouti kebab/);
  });
});
