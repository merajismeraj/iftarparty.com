'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, signinAdmin, request } = require('./helpers');

describe('coming soon + waitlist', () => {
  const { db, app } = makeApp();
  let admin;
  let soon;
  const ins = async (sql, ...a) => Number((await db.prepare(sql).run(...a)).lastInsertRowid);
  const restaurant = async (name, status, email) => {
    const owner = await ins(`INSERT INTO users (name, email, phone, password_hash, role) VALUES ('Owner', ?, '+919800000001', '', 'restaurant')`, email);
    return ins(`INSERT INTO restaurants (owner_id, name, city, area, cuisine, status) VALUES (?, ?, 'Hyderabad', 'Tolichowki', 'Hyderabadi', ?)`, owner, name, status);
  };

  before(async () => {
    admin = await signinAdmin(app, db);
    soon = await restaurant('Nayaab Hotel', 'approved', 'n@x.test');
    await restaurant('Hidden Pending', 'pending', 'p@x.test');
    await restaurant('Hidden Unclaimed', 'unclaimed', 'u@x.test');
  });

  test('approved partners without a venue or menu show as Coming soon; pending and unclaimed never do', async () => {
    const page = await request(app).get('/search').expect(200);
    assert.match(page.text, /Coming soon/);
    assert.match(page.text, /Nayaab Hotel/);
    assert.match(page.text, /Venues open for booking soon/);
    assert.doesNotMatch(page.text, /Hidden Pending|Hidden Unclaimed/);
    assert.match(page.text, new RegExp(`action="/waitlist/${soon}"`));
    const local = (await request(app).get('/search?location=Tolichowki')).text;
    assert.match(local, /Coming soon in Tolichowki/);
    assert.match(local, /Venues open for booking soon/);
    assert.doesNotMatch(local, /No venues match/);
    assert.doesNotMatch((await request(app).get('/search?location=Mumbai')).text, /Nayaab Hotel/);
  });

  test('anyone can join the waitlist with a mobile or an email; duplicates and bad contacts are handled', async () => {
    const guest = request.agent(app);
    let token = await csrf(guest, '/search');
    const res = await guest.post(`/waitlist/${soon}`).type('form').send({ _csrf: token, name: 'Sara Khan', contact: 'Sara@Example.test', location: 'Tolichowki' }).expect(302);
    assert.equal(res.headers.location, `/search?location=Tolichowki&joined=${soon}&via=email#soon-${soon}`);
    assert.match((await guest.get(res.headers.location.split('#')[0])).text, /You’re on the waitlist\. We’ll email you when Nayaab Hotel opens/);
    token = await csrf(guest, '/search');
    await guest.post(`/waitlist/${soon}`).type('form').send({ _csrf: token, name: 'Sara again', contact: 'sara@example.test' }).expect(302);
    token = await csrf(guest, '/search');
    await guest.post(`/waitlist/${soon}`).type('form').send({ _csrf: token, name: 'Ali', contact: '98765 43210' }).expect(302);
    token = await csrf(guest, '/search');
    await guest.post(`/waitlist/${soon}`).type('form').send({ _csrf: token, contact: 'not a contact' }).expect(302);
    assert.match((await guest.get('/search')).text, /valid mobile number or email/);

    const rows = await db.prepare('SELECT name, email, phone FROM waitlist WHERE restaurant_id = ? ORDER BY id').all(soon);
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { name: 'Sara Khan', email: 'sara@example.test', phone: null },
      { name: 'Ali', email: null, phone: '+919876543210' },
    ]);

    const pending = (await db.prepare(`SELECT id FROM restaurants WHERE name = 'Hidden Pending'`).get()).id;
    token = await csrf(guest, '/search');
    await guest.post(`/waitlist/${pending}`).type('form').send({ _csrf: token, contact: 'x@y.test' }).expect(302);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM waitlist WHERE restaurant_id = ?').get(pending)).n, 0);
  });

  test('admin sees the waitlist and emails it once the restaurant is bookable', async () => {
    let page = await admin.get(`/admin/restaurants/${soon}`).expect(200);
    assert.match(page.text, /Waitlist <span class="muted">\(2\)/);
    assert.match(page.text, /sara@example\.test/);
    assert.match(page.text, /wa\.me\/919876543210/);

    let token = await csrf(admin, `/admin/restaurants/${soon}`);
    await admin.post(`/admin/restaurants/${soon}/waitlist/notify`).type('form').send({ _csrf: token }).expect(302);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM waitlist WHERE notified_at IS NOT NULL').get()).n, 0, 'not bookable yet');

    await ins(`INSERT INTO venues (restaurant_id, name, min_pax, max_pax) VALUES (?, 'Hall', 10, 80)`, soon);
    await ins(`INSERT INTO menus (restaurant_id, name, items, price_per_person) VALUES (?, 'Iftar', 'Dates', 50000)`, soon);
    assert.doesNotMatch((await request(app).get('/search')).text, /Coming soon/, 'bookable now: a normal card, not coming soon');

    token = await csrf(admin, `/admin/restaurants/${soon}`);
    await admin.post(`/admin/restaurants/${soon}/waitlist/notify`).type('form').send({ _csrf: token }).expect(302);
    const told = await db.prepare('SELECT email, notified_at FROM waitlist WHERE restaurant_id = ? ORDER BY id').all(soon);
    assert.ok(told[0].notified_at, 'email entry notified');
    assert.equal(told[1].notified_at, null, 'mobile-only entry left for manual contact');
    page = await admin.get(`/admin/restaurants/${soon}`);
    assert.match(page.text, /Emailed 1 on the waitlist\. 1 left a mobile only/);
    assert.ok(await db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'restaurant.waitlist_notify'`).get());
  });
});
