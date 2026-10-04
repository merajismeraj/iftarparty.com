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
    { pricePerPerson: 100000, guestCount: 10, foodTotal: 1000000, hireFee: 50000, platformFee: 52500, total: 1102500, feePercent: 5 });
});

test('expired holds release the venue; a late payment cannot double-book', () => {
  const { db } = makeApp();
  db.exec(`INSERT INTO users (id, name, email, password_hash, role) VALUES (1, 'R', 'r@x', 'x', 'restaurant'), (2, 'H1', 'h1@x', 'x', 'host'), (3, 'H2', 'h2@x', 'x', 'host');
    INSERT INTO restaurants (id, owner_id, name, city) VALUES (1, 1, 'R', 'Mumbai');
    INSERT INTO venues (id, restaurant_id, name, min_pax, max_pax) VALUES (1, 1, 'Hall', 1, 50);
    INSERT INTO menus (id, restaurant_id, name, price_per_person) VALUES (1, 1, 'M', 1000);`);
  const date = '2099-03-01';
  const first = svc.createHold(db, { venueId: 1, menuId: 1, hostId: 2, eventDate: date, guestCount: 10 });
  assert.throws(() => svc.createHold(db, { venueId: 1, menuId: 1, hostId: 3, eventDate: date, guestCount: 10 }), /already reserved/);

  db.prepare(`UPDATE bookings SET hold_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(first);
  const second = svc.createHold(db, { venueId: 1, menuId: 1, hostId: 3, eventDate: date, guestCount: 10 });
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(first).status, 'expired');

  assert.deepEqual(svc.confirmPayment(db, second, { provider: 'demo', ref: 'b' }), { ok: true, conflict: false });
  assert.deepEqual(svc.confirmPayment(db, first, { provider: 'demo', ref: 'a' }), { ok: false, conflict: true });
  assert.deepEqual(svc.confirmPayment(db, second, { provider: 'demo', ref: 'b' }), { ok: true, conflict: false }, 'idempotent');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM bookings WHERE status = 'confirmed'`).get().n, 1);
});

test('past dates and invalid dates are refused', () => {
  const { db } = makeApp();
  assert.throws(() => svc.createHold(db, { venueId: 1, menuId: 1, hostId: 1, eventDate: '2000-01-01', guestCount: 5 }), /future/);
  assert.throws(() => svc.createHold(db, { venueId: 1, menuId: 1, hostId: 1, eventDate: '2099-02-30', guestCount: 5 }), /valid date/);
});

test('refunds never silently succeed for providers we cannot refund through', async () => {
  const payments = require('../src/services/payments');
  assert.deepEqual(await payments.createRefund({ provider: 'demo', orderId: 'x', refundId: 'r', amount: 1 }), { status: 'success' });
  await assert.rejects(payments.createRefund({ provider: 'legacy', orderId: 'x', refundId: 'r', amount: 1 }), /refunded manually/);
});
