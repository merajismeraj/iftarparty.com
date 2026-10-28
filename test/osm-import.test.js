'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, signinAdmin, request } = require('./helpers');
const osmImport = require('../src/services/osmImport');

const FIXTURE = {
  elements: [
    { type: 'node', id: 101, lat: 17.36, lon: 78.47, tags: { amenity: 'restaurant', name: 'Shadab', cuisine: 'indian;hyderabadi;biryani', 'addr:street': 'High Court Road', 'addr:suburb': 'Ghansi Bazaar', phone: '+91 40 2456 5949', website: 'shadab.in' } },
    { type: 'way', id: 202, center: { lat: 17.41, lon: 78.44 }, tags: { amenity: 'restaurant', name: 'Bawarchi', 'name:en': 'Bawarchi Restaurant', 'addr:suburb': 'RTC X Roads', 'contact:phone': '040 2760 3456;040 2760 0000', 'contact:email': 'info@bawarchi.test' } },
    { type: 'node', id: 303, tags: { amenity: 'restaurant', name: 'Shadab', 'addr:suburb': 'Ghansi Bazaar' } }, // duplicate name + area
    { type: 'node', id: 404, tags: { amenity: 'restaurant' } }, // no name
    { type: 'node', id: 505, tags: { amenity: 'fast_food', name: 'Burger Spot' } }, // not a restaurant
  ],
};

describe('restaurants from OpenStreetMap', () => {
  const { db, app } = makeApp();
  let admin;
  const realFetch = global.fetch;
  after(() => { global.fetch = realFetch; });

  before(async () => {
    admin = await signinAdmin(app, db);
  });

  test('parses public details only and skips duplicates, unnamed and non-restaurants', () => {
    const rows = osmImport.toRestaurants(FIXTURE, 'Hyderabad');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      ref: 'osm:node/101', name: 'Shadab', cuisine: 'Indian, Hyderabadi, Biryani', address: 'High Court Road', area: 'Ghansi Bazaar',
      city: 'Hyderabad', phone: '+914024565949', website: 'shadab.in', description: '',
      note: 'Imported from OpenStreetMap (node/101). Set the owner to onboard.',
    });
    assert.equal(rows[1].name, 'Bawarchi Restaurant');
    assert.equal(rows[1].phone, '+914027603456');
    assert.match(rows[1].note, /listed email info@bawarchi\.test/);
    assert.throws(() => osmImport.toRestaurants({ foo: 1 }, 'Hyderabad'), /Overpass/);
  });

  test('admin fetches a city: restaurants are added unclaimed and stay hidden from hosts', async () => {
    let query = '';
    global.fetch = async (url, opts) => {
      assert.equal(url, 'https://overpass-api.de/api/interpreter');
      query = opts.body.get('data');
      return new Response(JSON.stringify(FIXTURE), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const token = await csrf(admin, '/admin/restaurants/import');
    const res = await admin.post(`/admin/restaurants/import-osm?_csrf=${encodeURIComponent(token)}`).field('city', 'Hyderabad').expect(302);
    global.fetch = realFetch;
    assert.equal(res.headers.location, '/admin/restaurants?status=unclaimed');
    assert.match(query, /"amenity"="restaurant"\]\["name"\]\(17\.2,78\.2,17\.6,78\.7\)/);

    const rows = await db.prepare(`SELECT r.*, u.email, u.password_hash FROM restaurants r JOIN users u ON u.id = r.owner_id WHERE r.source_ref IS NOT NULL ORDER BY r.id`).all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.status === 'unclaimed' && r.password_hash === '' && r.email.endsWith('@unclaimed.iftarparty.invalid')));
    assert.equal(rows[0].website, 'shadab.in');
    assert.ok(await db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'restaurant.osm_import'`).get());

    const list = await admin.get('/admin/restaurants?status=unclaimed').expect(200);
    assert.match(list.text, /Shadab/);
    // Unclaimed restaurants are not in the review queue badge and never reach hosts.
    assert.equal((await db.prepare(`SELECT COUNT(*) n FROM restaurants WHERE status = 'pending'`).get()).n, 0);
    assert.doesNotMatch((await request(app).get('/search?location=Hyderabad')).text, /Shadab/);
  });

  test('re-importing refreshes unclaimed entries without duplicating them', async () => {
    const changed = structuredClone(FIXTURE);
    changed.elements[0].tags.website = 'https://shadab.example';
    const token = await csrf(admin, '/admin/restaurants/import');
    await admin.post(`/admin/restaurants/import-osm?_csrf=${encodeURIComponent(token)}`)
      .field('city', 'Hyderabad').attach('file', Buffer.from(JSON.stringify(changed)), 'export.json').expect(302);
    const rows = await db.prepare('SELECT website FROM restaurants WHERE source_ref IS NOT NULL ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].website, 'https://shadab.example');
  });

  test('onboarding: admin sets the real owner, who can then be approved', async () => {
    const r = await db.prepare(`SELECT id FROM restaurants WHERE source_ref = 'osm:node/101'`).get();
    let token = await csrf(admin, `/admin/restaurants/${r.id}`);
    const page = await admin.get(`/admin/restaurants/${r.id}`).expect(200);
    assert.match(page.text, /No owner yet/);

    await admin.post(`/admin/restaurants/${r.id}/owner`).type('form')
      .send({ _csrf: token, owner_name: 'Owner', owner_email: 'x@unclaimed.iftarparty.invalid', owner_phone: '9876543210' }).expect(302);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM users WHERE email = ?').get('owner@shadab.test')).n, 0);

    token = await csrf(admin, `/admin/restaurants/${r.id}`);
    await admin.post(`/admin/restaurants/${r.id}/owner`).type('form')
      .send({ _csrf: token, owner_name: 'Mohammed Shadab', owner_email: 'Owner@Shadab.test', owner_phone: '9876543210' }).expect(302);
    const owner = await db.prepare('SELECT u.* FROM users u JOIN restaurants r ON r.owner_id = u.id WHERE r.id = ?').get(r.id);
    assert.equal(owner.email, 'owner@shadab.test');
    assert.equal(owner.phone, '+919876543210');

    token = await csrf(admin, `/admin/restaurants/${r.id}`);
    await admin.post(`/admin/restaurants/${r.id}/status`).type('form').send({ _csrf: token, status: 'approved' }).expect(302);
    assert.equal((await db.prepare('SELECT status FROM restaurants WHERE id = ?').get(r.id)).status, 'approved');

    // Onboarded places are never overwritten by a later import.
    token = await csrf(admin, '/admin/restaurants/import');
    await admin.post(`/admin/restaurants/import-osm?_csrf=${encodeURIComponent(token)}`)
      .field('city', 'Hyderabad').attach('file', Buffer.from(JSON.stringify(FIXTURE)), 'export.json').expect(302);
    assert.equal((await db.prepare('SELECT website FROM restaurants WHERE id = ?').get(r.id)).website, 'https://shadab.example');
  });

  test('a bad export is reported, not imported', async () => {
    const token = await csrf(admin, '/admin/restaurants/import');
    await admin.post(`/admin/restaurants/import-osm?_csrf=${encodeURIComponent(token)}`)
      .field('city', 'Hyderabad').attach('file', Buffer.from('not json'), 'x.json').expect(302);
    const page = await admin.get('/admin/restaurants/import');
    assert.match(page.text, /Could not import from OpenStreetMap/);
  });
});
