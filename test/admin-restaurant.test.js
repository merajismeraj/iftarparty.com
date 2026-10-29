'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, signinAdmin, signupHost, request, PNG } = require('./helpers');

describe('admin adds and manages a single restaurant', () => {
  const { db, app } = makeApp();
  let admin;
  let rid;

  before(async () => {
    admin = await signinAdmin(app, db);
  });

  test('the add form validates, then creates the restaurant and a Google-only owner', async () => {
    let token = await csrf(admin, '/admin/restaurants/new');
    const bad = await admin.post('/admin/restaurants').type('form')
      .send({ _csrf: token, name: '', city: '', owner_name: 'A', owner_email: 'nope', owner_phone: '12' }).expect(422);
    for (const msg of [/restaurant name/, /city/, /owner’s name/, /owner’s email/, /mobile/]) assert.match(bad.text, msg);

    token = await csrf(admin, '/admin/restaurants/new');
    const res = await admin.post('/admin/restaurants').type('form').send({
      _csrf: token, name: 'Shadab', cuisine: 'Hyderabadi', area: 'Ghansi Bazaar', city: 'Hyderabad', website: 'shadab.in',
      owner_name: 'Mohammed Shadab', owner_email: 'Owner@Shadab.test', owner_phone: '9876543210', status: 'pending',
    }).expect(302);
    rid = Number(res.headers.location.match(/restaurants\/(\d+)/)[1]);
    const r = await db.prepare('SELECT r.*, u.email, u.phone AS owner_phone, u.password_hash, u.role FROM restaurants r JOIN users u ON u.id = r.owner_id WHERE r.id = ?').get(rid);
    assert.equal(r.status, 'pending');
    assert.equal(r.website, 'shadab.in');
    assert.equal(r.email, 'owner@shadab.test');
    assert.equal(r.owner_phone, '+919876543210');
    assert.equal(r.password_hash, '');
    assert.equal(r.role, 'restaurant');
    assert.ok(await db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'restaurant.create' AND entity_id = ?`).get(rid));

    const page = await admin.get(`/admin/restaurants/${rid}`).expect(200);
    assert.match(page.text, /<strong>Coming Soon<\/strong>/);
    assert.match((await admin.get('/admin/restaurants')).text, /href="\/admin\/restaurants\/new"/);

    token = await csrf(admin, '/admin/restaurants/new');
    const dup = await admin.post('/admin/restaurants').type('form')
      .send({ _csrf: token, name: 'Other', city: 'Hyderabad', owner_name: 'X Y', owner_email: 'owner@shadab.test', owner_phone: '9876543211' }).expect(422);
    assert.match(dup.text, /already has an account/);
  });

  test('admin manages the listing through the restaurant dashboard, then approves it into search', async () => {
    await admin.get('/restaurant').expect(403); // not without manage mode

    let token = await csrf(admin, `/admin/restaurants/${rid}`);
    const enter = await admin.post(`/admin/restaurants/${rid}/manage`).type('form').send({ _csrf: token }).expect(302);
    assert.equal(enter.headers.location, '/restaurant');
    const dash = await admin.get('/restaurant').expect(200);
    assert.match(dash.text, /Managing <strong>Shadab<\/strong> as admin/);
    assert.ok(await db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'restaurant.manage' AND entity_id = ?`).get(rid));

    token = await csrf(admin, '/restaurant/venues/new');
    await admin.post(`/restaurant/venues?_csrf=${token}`)
      .field('name', 'Rooftop').field('min_pax', '20').field('max_pax', '80').field('hire_fee', '5000')
      .attach('images', PNG, { filename: 'v.png', contentType: 'image/png' }).expect(302);
    token = await csrf(admin, '/restaurant/menus/new');
    await admin.post('/restaurant/menus').type('form')
      .send({ _csrf: token, name: 'Royal Iftar', price_per_person: '899', min_pax: '20', diet: 'non-veg', items: 'Dates\nHaleem\nBiryani' }).expect(302);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM venues WHERE restaurant_id = ?').get(rid)).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM menus WHERE restaurant_id = ?').get(rid)).n, 1);

    token = await csrf(admin, '/restaurant');
    const exit = await admin.post('/admin/manage/exit').type('form').send({ _csrf: token }).expect(302);
    assert.equal(exit.headers.location, `/admin/restaurants/${rid}`);
    await admin.get('/restaurant').expect(403);
    assert.doesNotMatch((await admin.get('/admin')).text, /Managing <strong>/);

    assert.doesNotMatch((await request(app).get('/search?location=Hyderabad')).text, /Shadab/, 'pending is hidden');
    token = await csrf(admin, `/admin/restaurants/${rid}`);
    await admin.post(`/admin/restaurants/${rid}/status`).type('form').send({ _csrf: token, status: 'approved' }).expect(302);
    assert.match((await request(app).get('/search?location=Hyderabad')).text, /Shadab/);
  });

  test('only admins can add or manage restaurants', async () => {
    const host = await signupHost(app, 'Some Host', 'host2@x.test');
    const token = await csrf(host, '/');
    await host.post(`/admin/restaurants/${rid}/manage`).type('form').send({ _csrf: token }).expect(403);
    await host.post('/admin/restaurants').type('form').send({ _csrf: token, name: 'X', city: 'Y' }).expect(403);
    await host.get('/restaurant').expect(403);
  });
});
