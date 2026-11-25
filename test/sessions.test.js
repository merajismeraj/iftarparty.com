'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, futureDate, seedMarketplace, signin, request } = require('./helpers');
const sunset = require('../src/services/sunset');
const sessions = require('../src/services/sessions');

const hhmm = (m) => sessions.toHHMM(m);

describe('sunset', () => {
  test('matches published Maghrib times within a few minutes', () => {
    // Reference: Hyderabad ≈ 18:19 on 19 Feb and ≈ 18:27 on 19 Mar; Mumbai ≈ 18:49 on 19 Mar; Delhi ≈ 17:29 on 21 Dec.
    const near = (got, want) => assert.ok(Math.abs(got - sessions.toMin(want)) <= 3, `${hhmm(got)} vs ${want}`);
    near(sunset.maghrib('2026-02-19', 'Hyderabad'), '18:19');
    near(sunset.maghrib('2026-03-19', 'Hyderabad'), '18:27');
    near(sunset.maghrib('2026-03-19', 'Mumbai'), '18:49');
    near(sunset.maghrib('2026-12-21', 'Delhi'), '17:29');
    // Unknown cities fall back to Hyderabad.
    assert.equal(sunset.maghrib('2027-02-15', 'Atlantis'), sunset.maghrib('2027-02-15', 'Hyderabad'));
  });

  test('session windows: Iftar from sunset, Dinner from the venue, combo spans both', () => {
    const [iftar, combo, dinner] = sessions.windows({ dinner_start: '21:30', dinner_minutes: 120 }, 'Hyderabad', '2027-02-15', 90);
    assert.equal(iftar.start, '17:55'); // Maghrib 18:18 − 20 min, rounded down to 5
    assert.equal(iftar.minutes, 90);
    assert.equal(combo.start, '17:55');
    assert.equal(combo.minutes, 23 * 60 + 30 - (17 * 60 + 55));
    assert.equal(dinner.start, '21:30');
    assert.equal(dinner.minutes, 120);
    // A dinner set after midnight belongs to the same night.
    const late = sessions.windows({ dinner_start: '00:30', dinner_minutes: 90 }, 'Hyderabad', '2027-02-15', 90)[2];
    assert.equal(late.startMin, 24 * 60 + 30);
  });
});

describe('Iftar only / Iftar & Dinner / Dinner only', () => {
  const { db, app } = makeApp();
  let fx;
  let host;
  let dinnerMenu;
  let comboMenu;
  const reserve = async (agent, body) => {
    const token = await csrf(agent, `/venues/${fx.venueId}`);
    return agent.post(`/venues/${fx.venueId}/reserve`).type('form').send({ _csrf: token, guests: '20', ...body }).expect(302);
  };
  const idOf = (res) => Number((res.headers.location.match(/bookings\/(\d+)/) || [])[1]) || null;

  before(async () => {
    fx = await seedMarketplace(db);
    const add = async (name, meal, price) => Number((await db.prepare(`INSERT INTO menus (restaurant_id, meal, name, items, price_per_person) VALUES (?, ?, ?, 'Dish', ?)`)
      .run(fx.restaurantId, meal, name, price)).lastInsertRowid);
    dinnerMenu = await add('Nihari Dinner', 'dinner', 80000);
    comboMenu = await add('Iftar to Dinner', 'combo', 120000);
    host = await signin(app, 'host@fixture.test');
  });

  test('the venue page offers three sessions, each showing only its own menus', async () => {
    const page = (await request(app).get(`/venues/${fx.venueId}?date=${futureDate(30)}`).expect(200)).text;
    for (const label of ['Iftar only', 'Iftar &amp; Dinner', 'Dinner only']) assert.match(page, new RegExp(`<strong>${label}</strong>`));
    assert.match(page, /name="session" value="iftar" data-meal="iftar" checked/);
    assert.match(page, new RegExp(`data-menu-meal="dinner" hidden>\\s*<input type="radio" name="menu_id" value="${dinnerMenu}"`));
    assert.match(page, new RegExp(`data-menu-meal="iftar" >\\s*<input type="radio" name="menu_id" value="${fx.menuId}"`));
    assert.match(page, /Maghrib on this date:/);
    // ?session=dinner preselects Dinner and its menu.
    const dinner = (await request(app).get(`/venues/${fx.venueId}?date=${futureDate(30)}&session=dinner`)).text;
    assert.match(dinner, /name="session" value="dinner" data-meal="dinner" checked/);
    assert.match(dinner, new RegExp(`value="${dinnerMenu}"[^>]*checked`));
  });

  test('a menu must belong to the chosen session', async () => {
    const res = await reserve(host, { date: futureDate(31), session: 'dinner', menu_id: fx.menuId });
    assert.equal(idOf(res), null);
    assert.match(res.headers.location, /session=dinner/);
    const bad = await reserve(host, { date: futureDate(31), session: 'brunch', menu_id: fx.menuId });
    assert.equal(idOf(bad), null);
  });

  test('Iftar and Dinner parties can share a night; a combo blocks both', async () => {
    const date = futureDate(32);
    const iftar = idOf(await reserve(host, { date, session: 'iftar', menu_id: fx.menuId }));
    const other = await signin(app, (await seedMarketplace(db, { hostEmail: 'h2@fixture.test' }), 'h2@fixture.test'));
    const dinner = idOf(await reserve(other, { date, session: 'dinner', menu_id: dinnerMenu }));
    assert.ok(iftar && dinner, 'both sessions booked the same night');
    const d = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(dinner);
    assert.deepEqual([d.session, d.arrival_time, d.duration_minutes, d.price_per_person], ['dinner', '21:30', 120, 80000]);
    // The night is now full: a combo cannot fit and search hides the venue for that date.
    assert.equal(idOf(await reserve(host, { date, session: 'iftar_dinner', menu_id: comboMenu })), null);
    assert.doesNotMatch((await request(app).get(`/search?date=${date}&guests=20`)).text, new RegExp(`href="/venues/${fx.venueId}\\?`));
    const avail = (await request(app).get(`/api/venues/${fx.venueId}/availability?date=${date}`)).body;
    assert.equal(avail.available, false);
    assert.deepEqual(avail.sessions.map((s) => s.available), [false, false, false]);

    // A combo on another night takes the whole evening.
    const date2 = futureDate(33);
    const combo = idOf(await reserve(host, { date: date2, session: 'iftar_dinner', menu_id: comboMenu }));
    assert.ok(combo);
    const c = await db.prepare('SELECT * FROM bookings WHERE id = ?').get(combo);
    assert.equal(c.session, 'iftar_dinner');
    assert.equal(sessions.toMin(c.arrival_time) + c.duration_minutes, 23 * 60 + 30);
    assert.equal(idOf(await reserve(other, { date: date2, session: 'dinner', menu_id: dinnerMenu })), null);
    assert.equal(idOf(await reserve(other, { date: date2, session: 'iftar', menu_id: fx.menuId })), null);
  });

  test('extra time that would run into the next party is refused', async () => {
    await db.prepare(`UPDATE venues SET extra_time_fee = 100000, dinner_start = '20:30' WHERE id = ?`).run(fx.venueId);
    const date = futureDate(34);
    const other = await signin(app, 'h2@fixture.test');
    assert.ok(idOf(await reserve(other, { date, session: 'dinner', menu_id: dinnerMenu })));
    // Iftar in Mumbai starts ≈ 17:50 and runs 90 min; +2 hours would end ≈ 21:20, past the 20:30 dinner.
    const res = await reserve(host, { date, session: 'iftar', menu_id: fx.menuId, extra_minutes: '120' });
    assert.equal(idOf(res), null);
    assert.ok(idOf(await reserve(host, { date, session: 'iftar', menu_id: fx.menuId })));
  });

  test('restaurants tag menus by meal; the dashboard shows it', async () => {
    const bcrypt = require('bcryptjs');
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync('password123', 4), fx.ownerId);
    const owner = await signin(app, (await db.prepare('SELECT email FROM users WHERE id = ?').get(fx.ownerId)).email);
    const form = (await owner.get('/restaurant/menus/new?meal=dinner').expect(200)).text;
    assert.match(form, /name="meal" value="dinner" checked/);
    const token = await csrf(owner, '/restaurant/menus/new');
    await owner.post('/restaurant/menus').type('form')
      .send({ _csrf: token, meal: 'combo', name: 'Grand Combo', price_per_person: '1499', min_pax: '10', diet: 'non-veg', items: 'Dates\nHaleem\nBiryani' }).expect(302);
    assert.equal((await db.prepare(`SELECT meal FROM menus WHERE name = 'Grand Combo'`).get()).meal, 'combo');
    assert.match((await owner.get('/restaurant').expect(200)).text, /Grand Combo<\/strong> <span class="pill pill-soft">Iftar &amp; Dinner combo/);
    assert.equal(sessions.normalizeMeal('nonsense'), 'iftar');
  });
});
