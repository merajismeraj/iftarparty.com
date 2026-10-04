'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iftarparty-test-'));
process.env.DATABASE_PATH = ':memory:';
process.env.UPLOAD_DIR = tmp;
process.env.BASE_URL = 'http://test.local';
process.env.CASHFREE_APP_ID = '';
process.env.CASHFREE_SECRET_KEY = '';
process.env.SMTP_HOST = '';
process.env.WHATSAPP_TOKEN = '';
process.env.PLATFORM_FEE_PERCENT = '5';

const request = require('supertest');
const { open } = require('../src/db');
const { createApp } = require('../src/app');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function makeApp() {
  const db = open(':memory:');
  return { db, app: createApp(db) };
}

async function csrf(agent, url = '/login') {
  const res = await agent.get(url);
  const m = res.text.match(/name="_csrf" value="([^"]+)"/) || res.text.match(/_csrf=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no csrf token on ${url}`);
  return m[1];
}

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function signupRestaurant(app) {
  const agent = request.agent(app);
  const token = await csrf(agent, '/signup?role=restaurant');
  await agent.post('/signup').type('form').send({
    _csrf: token, role: 'restaurant', name: 'Imran Q', email: 'chef@noor.test', phone: '9820011111', password: 'password123',
    restaurant_name: 'Noor Mahal', cuisine: 'Mughlai', area: 'Bandra', city: 'Mumbai', address: '14 Hill Rd',
  }).expect(302);
  return agent;
}

async function signupHost(app, name = 'Meraj Ahmed', email = 'meraj@host.test') {
  const agent = request.agent(app);
  const token = await csrf(agent, '/signup');
  await agent.post('/signup').type('form').send({ _csrf: token, role: 'host', name, email, phone: '9876500001', password: 'password123' }).expect(302);
  return agent;
}

/** Insert an admin directly (admins are never created through the web UI) and sign them in. */
async function signinAdmin(app, db) {
  const bcrypt = require('bcryptjs');
  if (!db.prepare(`SELECT 1 FROM users WHERE email = 'admin@test.local'`).get()) {
    db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES ('Ops Admin', 'admin@test.local', ?, 'admin')`).run(bcrypt.hashSync('admin-password-123', 4));
  }
  const agent = request.agent(app);
  const token = await csrf(agent);
  await agent.post('/login').type('form').send({ _csrf: token, email: 'admin@test.local', password: 'admin-password-123' }).expect(302);
  return agent;
}

module.exports = { signinAdmin, request, makeApp, csrf, futureDate, signupRestaurant, signupHost, PNG };

/** Approved restaurant with one hall and one menu, plus a host. Direct inserts for speed. */
function seedMarketplace(db, { hostEmail = 'host@fixture.test' } = {}) {
  const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);
  const ownerId = ins(`INSERT INTO users (name, email, phone, password_hash, role) VALUES ('Owner', ?, '+919800000000', 'x', 'restaurant')`, `owner${n}@fixture.test`);
  const restaurantId = ins(`INSERT INTO restaurants (owner_id, name, city, area, status, payout_upi) VALUES (?, 'Fixture Kitchen', 'Mumbai', 'Kurla', 'approved', 'fixture@okicici')`, ownerId);
  const venueId = ins(`INSERT INTO venues (restaurant_id, name, min_pax, max_pax, hire_fee) VALUES (?, 'Fixture Hall', 10, 100, 100000)`, restaurantId);
  const menuId = ins(`INSERT INTO menus (restaurant_id, name, items, price_per_person) VALUES (?, 'Fixture Menu', 'Dates', 50000)`, restaurantId);
  const bcrypt = require('bcryptjs');
  const hostId = db.prepare('SELECT id FROM users WHERE email = ?').get(hostEmail)?.id
    ?? ins(`INSERT INTO users (name, email, phone, password_hash, role) VALUES ('Fixture Host', ?, '+919812312312', ?, 'host')`, hostEmail, bcrypt.hashSync('password123', 4));
  return { ownerId, restaurantId, venueId, menuId, hostId };
}

/** A paid (demo provider) booking, created through the real hold + settle path. */
async function paidBooking(db, { venueId, menuId, hostId, date, guests = 20 }) {
  const svc = require('../src/services/bookings');
  const checkout = require('../src/services/checkout');
  const id = svc.createHold(db, { venueId, menuId, hostId, eventDate: date, guestCount: guests });
  const b = svc.getDetailed(db, id);
  const { orderId } = await checkout.startPayment(db, b, { id: hostId, name: b.host_name, email: b.host_email, phone: b.host_phone });
  await checkout.settleOrder(db, orderId);
  return id;
}

async function signin(app, email, password = 'password123') {
  const agent = request.agent(app);
  const token = await csrf(agent);
  await agent.post('/login').type('form').send({ _csrf: token, email, password }).expect(302);
  return agent;
}

module.exports.seedMarketplace = seedMarketplace;
module.exports.paidBooking = paidBooking;
module.exports.signin = signin;
