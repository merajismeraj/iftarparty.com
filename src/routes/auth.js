'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { transaction } = require('../db');
const { normalizeEmail, normalizePhone } = require('../services/guestlist');

const attempts = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

function rateLimited(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.start > WINDOW_MS) {
    attempts.set(key, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

/** Only allow redirects back to our own paths. */
function safeReturn(url, fallback) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : fallback;
}

function homeFor(user) {
  return { restaurant: '/restaurant', admin: '/admin' }[user.role] || '/my-parties';
}

module.exports = (db) => {
  const router = express.Router();

  router.get('/signup', (req, res) => {
    const role = req.query.role === 'restaurant' ? 'restaurant' : 'host';
    res.render('auth/signup', { title: role === 'restaurant' ? 'List your restaurant' : 'Create your account', role, form: {}, errors: [] });
  });

  router.post('/signup', async (req, res) => {
    const b = req.body;
    const role = b.role === 'restaurant' ? 'restaurant' : 'host';
    const form = { ...b, password: '' };
    const errors = [];
    const name = String(b.name || '').trim();
    const email = normalizeEmail(b.email);
    const phone = b.phone ? normalizePhone(b.phone) : null;
    if (name.length < 2) errors.push('Please enter your full name.');
    if (!email) errors.push('Please enter a valid email address.');
    if (!phone) errors.push('Please enter a valid mobile number – we use it for payment receipts and WhatsApp updates.');
    if (String(b.password || '').length < 8) errors.push('Password must be at least 8 characters.');
    if (role === 'restaurant') {
      if (!String(b.restaurant_name || '').trim()) errors.push('Please enter your restaurant name.');
      if (!String(b.city || '').trim()) errors.push('Please enter the city.');
    }
    if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      errors.push('An account with this email already exists – try signing in.');
    }
    if (errors.length) return res.status(422).render('auth/signup', { title: 'Sign up', role, form, errors });

    const hash = await bcrypt.hash(String(b.password), 12);
    const userId = transaction(db, () => {
      const id = Number(db.prepare('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)')
        .run(name, email, phone, hash, role).lastInsertRowid);
      if (role === 'restaurant') {
        db.prepare(`INSERT INTO restaurants (owner_id, name, cuisine, address, area, city, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
          .run(id, b.restaurant_name.trim(), String(b.cuisine || '').trim(), String(b.address || '').trim(),
            String(b.area || '').trim(), b.city.trim(), phone || '');
      }
      return id;
    });
    req.session.userId = userId;
    req.flash('success', role === 'restaurant'
      ? 'Welcome aboard! Add your halls and menus now – your listing goes live once our team approves it (usually within 24 hours).'
      : `Welcome, ${name.split(' ')[0]}! Find the perfect venue for your Iftar.`);
    res.redirect(role === 'restaurant' ? '/restaurant' : safeReturn(req.session.returnTo, '/search'));
  });

  router.get('/login', (req, res) => res.render('auth/login', { title: 'Sign in', form: {}, error: null }));

  router.post('/login', async (req, res) => {
    const email = normalizeEmail(req.body.email);
    if (rateLimited(`${req.ip}|${email}`)) {
      return res.status(429).render('auth/login', { title: 'Sign in', form: { email }, error: 'Too many attempts. Please wait 15 minutes and try again.' });
    }
    const user = email && db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.password_hash));
    if (!ok) return res.status(401).render('auth/login', { title: 'Sign in', form: { email }, error: 'Incorrect email or password.' });
    if (user.status !== 'active') {
      return res.status(403).render('auth/login', { title: 'Sign in', form: { email }, error: 'This account has been suspended. Please contact support@iftarparty.com.' });
    }
    const returnTo = req.session.returnTo;
    req.session.returnTo = null;
    req.session.userId = user.id;
    res.redirect(safeReturn(returnTo, homeFor(user)));
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
  });

  return router;
};
