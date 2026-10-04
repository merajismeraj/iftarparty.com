'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iftarparty-test-'));
process.env.DATABASE_PATH = ':memory:';
process.env.UPLOAD_DIR = tmp;
process.env.BASE_URL = 'http://test.local';
process.env.STRIPE_SECRET_KEY = '';
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
  await agent.post('/signup').type('form').send({ _csrf: token, role: 'host', name, email, password: 'password123' }).expect(302);
  return agent;
}

module.exports = { request, makeApp, csrf, futureDate, signupRestaurant, signupHost, PNG };
