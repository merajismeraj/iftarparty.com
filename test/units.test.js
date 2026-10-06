'use strict';
require('./helpers');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGuestList, normalizePhone } = require('../src/services/guestlist');
const pricing = require('../src/services/pricing');
const { makeApp } = require('./helpers');
const svc = require('../src/services/bookings');

test('normalizePhone handles local, international and junk input', () => {
  assert.equal(normalizePhone('98765 43210'), '+919876543210');
  assert.equal(normalizePhone('098765 43210'), '+919876543210');
  assert.equal(normalizePhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalizePhone('0044 7700 900123'), '+447700900123');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(''), null);
});

test('parseGuestList without header assumes name, email, mobile', () => {
  const r = parseGuestList('Ali, ali@x.com, 9876543210\nSana,,9876500000');
  assert.equal(r.guests.length, 2);
  assert.deepEqual(r.guests[1], { name: 'Sana', email: null, phone: '+919876500000' });
});

test('parseGuestList maps headers in any order and reports bad rows', () => {
  const r = parseGuestList('WhatsApp,Full Name,E-mail\n9876543210,Ali,ali@x.com\n,Nobody,\n123,Bad,');
  assert.deepEqual(r.guests, [{ name: 'Ali', email: 'ali@x.com', phone: '+919876543210' }]);
  assert.deepEqual(r.errors.map((e) => e.line), [3, 4]);
});

test('pricing quote', () => {
  assert.deepEqual(pricing.quote({ pricePerPerson: 100000, guestCount: 10, hireFee: 50000, feePercent: 5 }),
    { pricePerPerson: 100000, guestCount: 10, foodTotal: 1000000, hireFee: 50000, addonsTotal: 0, platformFee: 52500, total: 1102500, feePercent: 5 });
  // Add-ons: per-guest scales with headcount, flat is charged once; fee covers them too.
  const q = pricing.quote({ pricePerPerson: 100000, guestCount: 10, hireFee: 0, feePercent: 10,
    addons: [{ pricing: 'per_guest', price: 15000 }, { pricing: 'flat', price: 500000 }] });
  assert.equal(q.addonsTotal, 150000 + 500000);
  assert.equal(q.platformFee, 165000);
  assert.equal(q.total, 1000000 + 650000 + 165000);
});

test('expired holds release the venue; a late payment cannot double-book', async () => {
  const { db } = makeApp();
  await db.exec(`INSERT INTO users (id, name, email, password_hash, role) VALUES (1, 'R', 'r@x', 'x', 'restaurant'), (2, 'H1', 'h1@x', 'x', 'host'), (3, 'H2', 'h2@x', 'x', 'host');
    INSERT INTO restaurants (id, owner_id, name, city) VALUES (1, 1, 'R', 'Mumbai');
    INSERT INTO venues (id, restaurant_id, name, min_pax, max_pax) VALUES (1, 1, 'Hall', 1, 50);
    INSERT INTO menus (id, restaurant_id, name, price_per_person) VALUES (1, 1, 'M', 1000);`);
  const date = '2099-03-01';
  const first = await svc.createHold(db, { venueId: 1, menuId: 1, hostId: 2, eventDate: date, guestCount: 10 });
  await assert.rejects(svc.createHold(db, { venueId: 1, menuId: 1, hostId: 3, eventDate: date, guestCount: 10 }), /already reserved/);

  await db.prepare(`UPDATE bookings SET hold_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(first);
  const second = await svc.createHold(db, { venueId: 1, menuId: 1, hostId: 3, eventDate: date, guestCount: 10 });
  assert.equal((await db.prepare('SELECT status FROM bookings WHERE id = ?').get(first)).status, 'expired');

  assert.deepEqual(await svc.confirmPayment(db, second, { provider: 'demo', ref: 'b' }), { ok: true, conflict: false });
  assert.deepEqual(await svc.confirmPayment(db, first, { provider: 'demo', ref: 'a' }), { ok: false, conflict: true });
  assert.deepEqual(await svc.confirmPayment(db, second, { provider: 'demo', ref: 'b' }), { ok: true, conflict: false }, 'idempotent');
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM bookings WHERE status = 'confirmed'`).get()).n, 1);
});

test('simultaneous reservations for the same night: exactly one hold wins', async () => {
  const { db } = makeApp();
  const ins = async (sql, ...a) => (await db.prepare(sql).run(...a)).lastInsertRowid;
  const owner = await ins(`INSERT INTO users (name, email, password_hash, role) VALUES ('R', 'race-r@x', 'x', 'restaurant')`);
  const rid = await ins(`INSERT INTO restaurants (owner_id, name, city) VALUES (?, 'R', 'Mumbai')`, owner);
  const venueId = await ins(`INSERT INTO venues (restaurant_id, name, min_pax, max_pax) VALUES (?, 'Hall', 1, 50)`, rid);
  const menuId = await ins(`INSERT INTO menus (restaurant_id, name, price_per_person) VALUES (?, 'M', 1000)`, rid);
  const hosts = [];
  for (let i = 0; i < 6; i++) hosts.push(await ins(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, 'x', 'host')`, `H${i}`, `race${i}@x`));
  const results = await Promise.allSettled(hosts.map((hostId) =>
    svc.createHold(db, { venueId, menuId, hostId, eventDate: '2099-04-01', guestCount: 10 })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'one hold');
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => /already reserved/.test(r.reason.message)));
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM bookings WHERE venue_id = ? AND event_date = '2099-04-01'`).get(venueId)).n, 1);
});

test('past dates and invalid dates are refused', async () => {
  const { db } = makeApp();
  await assert.rejects(svc.createHold(db, { venueId: 1, menuId: 1, hostId: 1, eventDate: '2000-01-01', guestCount: 5 }), /future/);
  await assert.rejects(svc.createHold(db, { venueId: 1, menuId: 1, hostId: 1, eventDate: '2099-02-30', guestCount: 5 }), /valid date/);
});

test('refunds never silently succeed for providers we cannot refund through', async () => {
  const payments = require('../src/services/payments');
  assert.deepEqual(await payments.createRefund({ provider: 'demo', orderId: 'x', refundId: 'r', amount: 1 }), { status: 'success' });
  await assert.rejects(payments.createRefund({ provider: 'legacy', orderId: 'x', refundId: 'r', amount: 1 }), /refunded manually/);
});
