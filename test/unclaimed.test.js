'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, signinAdmin, request } = require('./helpers');

// Restaurants added earlier from public data are "unclaimed" until the team onboards them.
describe('onboarding unclaimed restaurants', () => {
  const { db, app } = makeApp();
  let admin;
  let rid;

  before(async () => {
    admin = await signinAdmin(app, db);
    const uid = Number((await db.prepare(`INSERT INTO users (name, email, role, password_hash) VALUES ('Shadab', 'osm-node-101@unclaimed.iftarparty.invalid', 'restaurant', '')`).run()).lastInsertRowid);
    rid = Number((await db.prepare(`INSERT INTO restaurants (owner_id, name, area, city, status, source_ref) VALUES (?, 'Shadab', 'Ghansi Bazaar', 'Hyderabad', 'unclaimed', 'osm:node/101')`).run(uid)).lastInsertRowid);
  });

  test('bulk upload and public-data import are gone', async () => {
    for (const path of ['/admin/restaurants/import', '/admin/restaurants/template.csv']) await admin.get(path).expect(404);
    const token = await csrf(admin, '/admin/restaurants');
    await admin.post('/admin/restaurants/import').type('form').send({ _csrf: token }).expect(404);
    await admin.post('/admin/restaurants/import-osm').type('form').send({ _csrf: token }).expect(404);
    const list = await admin.get('/admin/restaurants').expect(200);
    assert.doesNotMatch(list.text, /Bulk upload/);
    assert.match(list.text, /href="\/admin\/restaurants\/new"/);
  });

  test('unclaimed restaurants stay hidden from hosts', async () => {
    assert.match((await admin.get('/admin/restaurants?status=unclaimed')).text, /Shadab/);
    assert.doesNotMatch((await request(app).get('/search?location=Hyderabad')).text, /Shadab/);
  });

  test('admin sets the real owner, who can then be approved', async () => {
    let token = await csrf(admin, `/admin/restaurants/${rid}`);
    const page = await admin.get(`/admin/restaurants/${rid}`).expect(200);
    assert.match(page.text, /No owner yet/);
    assert.match(page.text, /href="https:\/\/www\.openstreetmap\.org\/node\/101"/);

    await admin.post(`/admin/restaurants/${rid}/owner`).type('form')
      .send({ _csrf: token, owner_name: 'Owner', owner_email: 'x@unclaimed.iftarparty.invalid', owner_phone: '9876543210' }).expect(303);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM users WHERE email = ?').get('owner@shadab.test')).n, 0);

    token = await csrf(admin, `/admin/restaurants/${rid}`);
    await admin.post(`/admin/restaurants/${rid}/owner`).type('form')
      .send({ _csrf: token, owner_name: 'Mohammed Shadab', owner_email: 'Owner@Shadab.test', owner_phone: '9876543210' }).expect(303);
    const owner = await db.prepare('SELECT u.* FROM users u JOIN restaurants r ON r.owner_id = u.id WHERE r.id = ?').get(rid);
    assert.equal(owner.email, 'owner@shadab.test');
    assert.equal(owner.phone, '+919876543210');

    token = await csrf(admin, `/admin/restaurants/${rid}`);
    await admin.post(`/admin/restaurants/${rid}/status`).type('form').send({ _csrf: token, status: 'approved' }).expect(303);
    assert.equal((await db.prepare('SELECT status FROM restaurants WHERE id = ?').get(rid)).status, 'approved');
  });
});
