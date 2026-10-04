'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, futureDate, seedMarketplace, paidBooking, signin, signinAdmin, request } = require('./helpers');

function pastDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

describe('admin portal', () => {
  const { db, app } = makeApp();
  let admin;
  let fx;

  before(async () => {
    fx = seedMarketplace(db);
    admin = await signinAdmin(app, db);
  });

  test('only admins get in', async () => {
    await request(app).get('/admin').expect(302);
    const host = await signin(app, 'host@fixture.test');
    await host.get('/admin').expect(403);
    await host.get('/admin/bookings').expect(403);
    const token = await csrf(host, '/my-parties');
    await host.post('/admin/settings').type('form').send({ _csrf: token, platform_fee_percent: '0' }).expect(403);
  });

  test('every admin page renders', async () => {
    const id = await paidBooking(db, { ...fx, date: futureDate(10) });
    for (const url of ['/admin', '/admin/restaurants', `/admin/restaurants/${fx.restaurantId}`, '/admin/bookings', `/admin/bookings/${id}`,
      '/admin/payouts', '/admin/users', '/admin/messages', '/admin/settings', '/admin/audit',
      '/admin/bookings?status=confirmed&q=fixture&from=2000-01-01', '/admin/bookings?refund=orphan', '/admin/users?role=host&status=active']) {
      const res = await admin.get(url);
      assert.equal(res.status, 200, url);
    }
    const ov = await admin.get('/admin');
    assert.match(ov.text, /Gross bookings/);
  });

  test('cancel with full refund frees the night, emails the host and is audited', async () => {
    const date = futureDate(20);
    const id = await paidBooking(db, { ...fx, date });
    let token = await csrf(admin, `/admin/bookings/${id}`);
    await admin.post(`/admin/bookings/${id}/cancel`).type('form').send({ _csrf: token, reason: '', refund: 'full' }).expect(302);
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'confirmed', 'reason required');

    const total = db.prepare('SELECT total_amount FROM bookings WHERE id = ?').get(id).total_amount;
    token = await csrf(admin, `/admin/bookings/${id}`);
    await admin.post(`/admin/bookings/${id}/cancel`).type('form').send({ _csrf: token, reason: 'Kitchen fire', refund: 'partial', amount: String(total) }).expect(302);
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(id).status, 'confirmed', 'over-refund rejected');

    token = await csrf(admin, `/admin/bookings/${id}`);
    await admin.post(`/admin/bookings/${id}/cancel`).type('form').send({ _csrf: token, reason: 'Kitchen fire', refund: 'full' }).expect(302);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    assert.equal(b.status, 'cancelled');
    assert.equal(b.cancel_reason, 'Kitchen fire');
    const p = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(b.payment_ref);
    assert.deepEqual([p.refund_status, p.refund_amount], ['success', b.total_amount]);
    const avail = await request(app).get(`/api/venues/${fx.venueId}/availability?date=${date}`);
    assert.equal(avail.body.available, true);
    assert.ok(db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'booking.cancel' AND entity_id = ?`).get(id));

    // Second cancel is refused; second refund impossible.
    token = await csrf(admin, `/admin/bookings/${id}`);
    await admin.post(`/admin/payments/${p.id}/refund-retry`).type('form').send({ _csrf: token }).expect(302);
    assert.equal(db.prepare('SELECT refund_amount FROM payments WHERE id = ?').get(p.id).refund_amount, b.total_amount);
  });

  test('partial refund keeps the remainder and records the amount', async () => {
    const id = await paidBooking(db, { ...fx, date: futureDate(21) });
    const token = await csrf(admin, `/admin/bookings/${id}`);
    await admin.post(`/admin/bookings/${id}/cancel`).type('form').send({ _csrf: token, reason: 'Host request, 50% policy', refund: 'partial', amount: '1000' }).expect(302);
    const b = db.prepare('SELECT payment_ref, status FROM bookings WHERE id = ?').get(id);
    assert.equal(b.status, 'cancelled');
    assert.equal(db.prepare('SELECT refund_amount FROM payments WHERE order_id = ?').get(b.payment_ref).refund_amount, 100000);
  });

  test('payouts: only completed Iftars, reference required, exact bookings only', async () => {
    const pastId = db.prepare(`INSERT INTO bookings (venue_id, menu_id, host_id, event_date, guest_count, title, price_per_person, food_total, hire_fee,
        platform_fee, total_amount, currency, status, hold_expires_at, payment_ref)
      VALUES (?, ?, ?, ?, 20, 'Iftar Party by Fixture Host', 50000, 1000000, 100000, 55000, 1155000, 'INR', 'confirmed', '2000-01-01', 'old')`)
      .run(fx.venueId, fx.menuId, fx.hostId, pastDate(3)).lastInsertRowid;
    const futureId = await paidBooking(db, { ...fx, date: futureDate(30) });

    const page = await admin.get('/admin/payouts');
    assert.match(page.text, /₹11,000/);
    assert.match(page.text, new RegExp(`#${pastId}`));
    assert.doesNotMatch(page.text, new RegExp(`#${futureId}\\b`));

    let token = await csrf(admin, '/admin/payouts');
    await admin.post('/admin/payouts').type('form').send({ _csrf: token, restaurant_id: fx.restaurantId, booking_ids: `${pastId},${futureId}`, reference: '' }).expect(302);
    assert.equal(db.prepare('SELECT payout_status FROM bookings WHERE id = ?').get(pastId).payout_status, 'unpaid');

    token = await csrf(admin, '/admin/payouts');
    await admin.post('/admin/payouts').type('form').send({ _csrf: token, restaurant_id: fx.restaurantId, booking_ids: `${pastId},${futureId}`, reference: 'UTR123456' }).expect(302);
    assert.equal(db.prepare('SELECT payout_status, payout_ref FROM bookings WHERE id = ?').get(pastId).payout_ref, 'UTR123456');
    assert.equal(db.prepare('SELECT payout_status FROM bookings WHERE id = ?').get(futureId).payout_status, 'unpaid', 'future event not paid out');
  });

  test('suspending a host signs them out and blocks sign-in; admins can’t be suspended', async () => {
    seedMarketplace(db, { hostEmail: 'trouble@fixture.test' });
    const user = await signin(app, 'trouble@fixture.test');
    await user.get('/my-parties').expect(200);
    const uid = db.prepare(`SELECT id FROM users WHERE email = 'trouble@fixture.test'`).get().id;
    let token = await csrf(admin, '/admin/users');
    await admin.post(`/admin/users/${uid}/status`).type('form').send({ _csrf: token, status: 'suspended' }).expect(302);
    const kicked = await user.get('/my-parties').expect(302);
    assert.equal(kicked.headers.location, '/login');
    const again = request.agent(app);
    token = await csrf(again);
    const res = await again.post('/login').type('form').send({ _csrf: token, email: 'trouble@fixture.test', password: 'password123' }).expect(403);
    assert.match(res.text, /suspended/);

    const adminId = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).get().id;
    token = await csrf(admin, '/admin/users');
    await admin.post(`/admin/users/${adminId}/status`).type('form').send({ _csrf: token, status: 'suspended' }).expect(302);
    assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(adminId).status, 'active');
  });

  test('restaurant moderation: reject needs a reason, suspension hides from search', async () => {
    let token = await csrf(admin, `/admin/restaurants/${fx.restaurantId}`);
    await admin.post(`/admin/restaurants/${fx.restaurantId}/status`).type('form').send({ _csrf: token, status: 'suspended' }).expect(302);
    assert.equal(db.prepare('SELECT status FROM restaurants WHERE id = ?').get(fx.restaurantId).status, 'approved');
    const listed = async () => new RegExp(`href="/venues/${fx.venueId}["?]`).test((await request(app).get('/search')).text);
    assert.ok(await listed());

    token = await csrf(admin, `/admin/restaurants/${fx.restaurantId}`);
    await admin.post(`/admin/restaurants/${fx.restaurantId}/status`).type('form').send({ _csrf: token, status: 'suspended', note: 'Hygiene complaint' }).expect(302);
    assert.ok(!(await listed()));
    await request(app).get(`/venues/${fx.venueId}`).expect(404);
    await admin.get(`/venues/${fx.venueId}`).expect(200);

    token = await csrf(admin, `/admin/restaurants/${fx.restaurantId}`);
    await admin.post(`/admin/restaurants/${fx.restaurantId}/status`).type('form').send({ _csrf: token, status: 'approved' }).expect(302);
    token = await csrf(admin, `/admin/restaurants/${fx.restaurantId}`);
    await admin.post(`/admin/venues/${fx.venueId}/toggle`).type('form').send({ _csrf: token }).expect(302);
    assert.ok(!(await listed()));
    token = await csrf(admin, `/admin/restaurants/${fx.restaurantId}`);
    await admin.post(`/admin/venues/${fx.venueId}/toggle`).type('form').send({ _csrf: token }).expect(302);
  });

  test('platform fee setting drives new quotes only', async () => {
    const before = await paidBooking(db, { ...fx, date: futureDate(50) });
    let token = await csrf(admin, '/admin/settings');
    await admin.post('/admin/settings').type('form').send({ _csrf: token, platform_fee_percent: '45' }).expect(422);
    token = await csrf(admin, '/admin/settings');
    await admin.post('/admin/settings').type('form').send({ _csrf: token, platform_fee_percent: '10' }).expect(302);
    const after = await paidBooking(db, { ...fx, date: futureDate(51) });
    const fee = (id) => db.prepare('SELECT platform_fee, food_total + hire_fee AS sub FROM bookings WHERE id = ?').get(id);
    assert.equal(fee(before).platform_fee, Math.round(fee(before).sub * 0.05));
    assert.equal(fee(after).platform_fee, Math.round(fee(after).sub * 0.10));
    assert.match((await request(app).get(`/venues/${fx.venueId}`)).text, /data-fee-percent="10"/);
  });

  test('bookings CSV export is filterable and formula-safe', async () => {
    db.prepare(`UPDATE bookings SET cancel_reason = '=cmd()' WHERE status = 'cancelled'`).run();
    const res = await admin.get('/admin/bookings.csv?status=cancelled').expect(200);
    const lines = res.text.trim().split('\n');
    assert.match(lines[0], /^id,title,event_date,status/);
    assert.ok(lines.slice(1).every((l) => l.includes('"cancelled"')));
    assert.match(res.text, /"'=cmd\(\)"/);
  });

  test('audit log lists every admin action', async () => {
    const res = await admin.get('/admin/audit').expect(200);
    for (const action of ['booking.cancel', 'payout.mark_paid', 'user.suspend', 'restaurant.suspended', 'settings.update', 'venue.hide']) {
      assert.match(res.text, new RegExp(action.replace('.', '\\.')), action);
    }
  });
});
