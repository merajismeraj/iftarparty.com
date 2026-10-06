'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { makeApp, csrf, signupRestaurant, PNG, request } = require('./helpers');

/** Fake Supabase Storage API: records buckets, objects and deletes. */
function fakeSupabase() {
  const realFetch = global.fetch;
  const state = { buckets: new Set(), objects: new Map(), deleted: [], auth: [] };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://proj.supabase.co/storage/v1')) return realFetch(url, opts);
    state.auth.push(opts.headers?.Authorization);
    const p = u.slice('https://proj.supabase.co/storage/v1'.length);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (p === '/bucket' && opts.method === 'POST') {
      const { id, public: isPublic } = JSON.parse(opts.body);
      if (state.buckets.has(id)) return json(409, { error: 'Duplicate', message: 'The resource already exists' });
      assert.equal(isPublic, true);
      state.buckets.add(id);
      return json(200, { name: id });
    }
    const m = p.match(/^\/object\/([^/]+)(?:\/(.+))?$/);
    if (m && opts.method === 'POST') {
      if (!state.buckets.has(m[1])) return json(404, { message: 'Bucket not found' });
      state.objects.set(decodeURIComponent(m[2]), { type: opts.headers['Content-Type'], size: opts.body.length });
      return json(200, { Key: `${m[1]}/${m[2]}` });
    }
    if (m && opts.method === 'DELETE') {
      for (const name of JSON.parse(opts.body).prefixes) { state.objects.delete(name); state.deleted.push(name); }
      return json(200, []);
    }
    return json(400, { message: `unexpected ${opts.method} ${p}` });
  };
  return { state, restore: () => { global.fetch = realFetch; } };
}

// Configured before the app is built, as in production (the CSP is fixed at startup).
Object.assign(config.supabase, { url: 'https://proj.supabase.co', serviceKey: 'service-role-key', bucket: 'venue-photos' });

describe('venue photos on Supabase Storage', () => {
  const { db, app } = makeApp();
  let sb;
  let restaurant;
  before(async () => {
    sb = fakeSupabase();
    restaurant = await signupRestaurant(app);
  });
  after(() => {
    sb.restore();
    Object.assign(config.supabase, { url: '', serviceKey: '' });
  });

  test('uploads go to a public bucket (created once) and pages link to the CDN URL', async () => {
    const token = await csrf(restaurant, '/restaurant/venues/new');
    await restaurant.post(`/restaurant/venues?_csrf=${token}`)
      .field('name', 'Cloud Hall').field('min_pax', '10').field('max_pax', '80').field('hire_fee', '0')
      .attach('images', PNG, { filename: 'a.png', contentType: 'image/png' })
      .attach('images', PNG, { filename: 'b.png', contentType: 'image/png' })
      .expect(302);
    assert.deepEqual([...sb.state.buckets], ['venue-photos']);
    assert.equal(sb.state.objects.size, 2);
    assert.ok(sb.state.auth.every((h) => h === 'Bearer service-role-key'));
    const names = (await db.prepare('SELECT filename FROM venue_images ORDER BY sort_order').all()).map((r) => r.filename);
    assert.deepEqual(names.sort(), [...sb.state.objects.keys()].sort());
    assert.match(names[0], /^[0-9a-f-]{36}\.png$/);

    const venueId = (await db.prepare('SELECT id FROM venues').get()).id;
    const page = await restaurant.get(`/restaurant/venues/${venueId}/edit`).expect(200);
    assert.ok(page.text.includes(`src="https://proj.supabase.co/storage/v1/object/public/venue-photos/${names[0]}"`));
    assert.doesNotMatch(page.text, /src="\/uploads\//);
    // The CSP lets browsers load images from the Supabase project.
    assert.match(page.headers['content-security-policy'], /img-src 'self' data: https:\/\/proj\.supabase\.co/);
  });

  test('a form with errors stores nothing; removing a photo deletes it from storage', async () => {
    const before = sb.state.objects.size;
    let token = await csrf(restaurant, '/restaurant/venues/new');
    await restaurant.post(`/restaurant/venues?_csrf=${token}`).field('name', '').field('min_pax', '10').field('max_pax', '80')
      .attach('images', PNG, { filename: 'c.png', contentType: 'image/png' }).expect(422);
    assert.equal(sb.state.objects.size, before, 'invalid form uploads nothing');

    const venueId = (await db.prepare('SELECT id FROM venues').get()).id;
    const img = await db.prepare('SELECT * FROM venue_images WHERE venue_id = ? ORDER BY id DESC LIMIT 1').get(venueId);
    token = await csrf(restaurant, `/restaurant/venues/${venueId}/edit`);
    await restaurant.post(`/restaurant/venues/${venueId}/images/${img.id}/delete?_csrf=${token}`).expect(302);
    assert.deepEqual(sb.state.deleted, [img.filename]);
    assert.equal(sb.state.objects.has(img.filename), false);
  });

  test('photo names are opaque and path-safe', async () => {
    const storage = require('../src/services/storage');
    await assert.rejects(storage.put(Buffer.from('x'), 'image/png', '../escape.png'), /invalid file name/);
    assert.equal(storage.photoUrl('a b.png'), 'https://proj.supabase.co/storage/v1/object/public/venue-photos/a%20b.png');
  });
});
