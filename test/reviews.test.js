'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, futureDate, seedMarketplace, paidBooking, signin, signinAdmin, request } = require('./helpers');

describe('verified reviews with admin moderation', () => {
  const { db, app } = makeApp();
  let fx;
  let host;
  let owner;
  let admin;
  let pastId;
  let futureId;
  const review = async (id) => await db.prepare('SELECT * FROM reviews WHERE booking_id = ?').get(id);

  before(async () => {
    fx = await seedMarketplace(db);
    await db.prepare(`UPDATE users SET name = 'Meraj Ahmed' WHERE id = ?`).run(fx.hostId);
    const bcrypt = require('bcryptjs');
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync('password123', 4), fx.ownerId);
    pastId = await paidBooking(db, { ...fx, date: futureDate(5) });
    await db.prepare(`UPDATE bookings SET event_date = to_char((now() AT TIME ZONE 'utc')::date - 2, 'YYYY-MM-DD') WHERE id = ?`).run(pastId);
    futureId = await paidBooking(db, { ...fx, date: futureDate(6) });
    host = await signin(app, 'host@fixture.test');
    owner = await signin(app, (await db.prepare('SELECT email FROM users WHERE id = ?').get(fx.ownerId)).email);
    admin = await signinAdmin(app, db);
  });

  test('only the host, only after the Iftar', async () => {
    const r = await host.get(`/bookings/${futureId}/review`).expect(302);
    assert.equal(r.headers.location, '/my-parties');
    const token = await csrf(host, '/my-parties');
    await host.post(`/bookings/${futureId}/review`).type('form').send({ _csrf: token, rating: '5', body: 'Lovely venue and great food overall!' }).expect(422);
    assert.equal(await review(futureId), undefined);

    await seedMarketplace(db, { hostEmail: 'other@fixture.test' });
    const other = await signin(app, 'other@fixture.test');
    await other.get(`/bookings/${pastId}/review`).expect(404);

    const parties = await host.get('/my-parties').expect(200);
    assert.match(parties.text, new RegExp(`/bookings/${pastId}/review`));
    assert.doesNotMatch(parties.text, new RegExp(`/bookings/${futureId}/review`));
  });

  test('submission is validated and held for moderation', async () => {
    let token = await csrf(host, `/bookings/${pastId}/review`);
    await host.post(`/bookings/${pastId}/review`).type('form').send({ _csrf: token, rating: '9', body: 'x'.repeat(30) }).expect(422);
    token = await csrf(host, `/bookings/${pastId}/review`);
    await host.post(`/bookings/${pastId}/review`).type('form').send({ _csrf: token, rating: '5', body: 'too short' }).expect(422);
    token = await csrf(host, `/bookings/${pastId}/review`);
    await host.post(`/bookings/${pastId}/review`).type('form').send({
      _csrf: token, rating: '4', food_rating: '5', service_rating: '3', title: 'Great haleem',
      body: 'Wonderful <script>alert(1)</script> haleem and a calm prayer space before Maghrib.',
    }).expect(302);
    const r = await review(pastId);
    assert.deepEqual([r.status, r.rating, r.food_rating, r.service_rating, r.ambience_rating], ['pending', 4, 5, 3, null]);
    const page = await request(app).get(`/venues/${fx.venueId}`).expect(200);
    assert.doesNotMatch(page.text, /Great haleem/, 'pending review is not public');
  });

  test('only admins moderate; rejection needs a reason and the host can resubmit', async () => {
    const id = (await review(pastId)).id;
    let token = await csrf(host, '/my-parties');
    await host.post(`/admin/reviews/${id}/moderate`).type('form').send({ _csrf: token, decision: 'approve' }).expect(403);

    const queue = await admin.get('/admin/reviews').expect(200);
    assert.match(queue.text, /Great haleem/);
    token = await csrf(admin, '/admin/reviews');
    await admin.post(`/admin/reviews/${id}/moderate`).type('form').send({ _csrf: token, decision: 'reject', note: '' }).expect(302);
    assert.equal((await review(pastId)).status, 'pending');
    token = await csrf(admin, '/admin/reviews');
    await admin.post(`/admin/reviews/${id}/moderate`).type('form').send({ _csrf: token, decision: 'reject', note: 'Please remove the code snippet' }).expect(302);
    assert.equal((await review(pastId)).status, 'rejected');

    const form = await host.get(`/bookings/${pastId}/review`).expect(200);
    assert.match(form.text, /Please remove the code snippet/);
    token = await csrf(host, `/bookings/${pastId}/review`);
    await host.post(`/bookings/${pastId}/review`).type('form').send({
      _csrf: token, rating: '5', title: 'Great haleem', body: 'Wonderful <b>haleem</b> and a calm prayer space before Maghrib.',
    }).expect(302);
    assert.equal((await review(pastId)).status, 'pending');
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM reviews').get()).n, 1, 'one review per booking');
  });

  test('approved reviews appear with a privacy-safe name, escaped, and feed ratings', async () => {
    const id = (await review(pastId)).id;
    const token = await csrf(admin, '/admin/reviews');
    await admin.post(`/admin/reviews/${id}/moderate`).type('form').send({ _csrf: token, decision: 'approve' }).expect(302);
    const page = await request(app).get(`/venues/${fx.venueId}`).expect(200);
    assert.match(page.text, /Great haleem/);
    // The reservation label ("Iftar Party by <full name>") is public by design; the review section is not.
    const section = page.text.slice(page.text.indexOf('id="reviews"'), page.text.indexOf('Reserved evenings'));
    assert.match(section, /Meraj A\./);
    assert.doesNotMatch(section, /Meraj Ahmed/);
    assert.match(page.text, /&lt;b&gt;haleem&lt;\/b&gt;/);
    assert.match(page.text, /✓ Verified booking/);
    const search = await request(app).get('/search?sort=rating').expect(200);
    assert.match(search.text, /★<\/span> <strong>5<\/strong> <span class="muted">\(1\)<\/span>/);
    assert.ok(await db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'review.approved' AND entity_id = ?`).get(id));
  });

  test('restaurant replies are moderated before they go public', async () => {
    const id = (await review(pastId)).id;
    let token = await csrf(owner, '/restaurant/reviews');
    await owner.post(`/restaurant/reviews/${id}/reply`).type('form').send({ _csrf: token, reply: 'JazakAllah khair, see you next Ramadan!' }).expect(302);
    assert.equal((await review(pastId)).reply_status, 'pending');
    assert.doesNotMatch((await request(app).get(`/venues/${fx.venueId}`)).text, /see you next Ramadan/);
    assert.match((await owner.get('/restaurant/reviews')).text, /see you next Ramadan/);

    token = await csrf(admin, '/admin/reviews');
    await admin.post(`/admin/reviews/${id}/reply-moderate`).type('form').send({ _csrf: token, decision: 'approve' }).expect(302);
    const page = await request(app).get(`/venues/${fx.venueId}`);
    assert.match(page.text, /Response from the restaurant/);
    assert.match(page.text, /see you next Ramadan/);
  });

  test('editing a published review takes it offline until re-approved', async () => {
    const token = await csrf(host, `/bookings/${pastId}/review`);
    await host.post(`/bookings/${pastId}/review`).type('form').send({ _csrf: token, rating: '2', title: 'Changed my mind', body: 'Actually the service was slower than expected that evening.' }).expect(302);
    assert.equal((await review(pastId)).status, 'pending');
    const page = await request(app).get(`/venues/${fx.venueId}`);
    assert.doesNotMatch(page.text, /Changed my mind/);
    assert.match(page.text, /No reviews yet/);
  });

  test('restaurants can only reply to their own published reviews', async () => {
    const id = (await review(pastId)).id; // currently pending again
    const token = await csrf(owner, '/restaurant/reviews');
    await owner.post(`/restaurant/reviews/${id}/reply`).type('form').send({ _csrf: token, reply: 'Sneaky edit' }).expect(302);
    assert.notEqual((await review(pastId)).reply, 'Sneaky edit');
  });
});
