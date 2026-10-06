'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { transaction } = require('../db');
const { normalizeEmail, normalizePhone } = require('../services/guestlist');
const google = require('../services/google');
const { requireAuth } = require('../middleware/auth');

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
    if (email && await db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      errors.push('An account with this email already exists – try signing in.');
    }
    if (errors.length) return res.status(422).render('auth/signup', { title: 'Sign up', role, form, errors });

    const hash = await bcrypt.hash(String(b.password), 12);
    const userId = await transaction(db, async () => {
      const id = Number((await db.prepare('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)')
        .run(name, email, phone, hash, role)).lastInsertRowid);
      if (role === 'restaurant') {
        await db.prepare(`INSERT INTO restaurants (owner_id, name, cuisine, address, area, city, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
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
    const user = email && await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.password_hash));
    if (!ok) {
      const error = user && !user.password_hash ? 'This account signs in with Google – use “Continue with Google”.' : 'Incorrect email or password.';
      return res.status(401).render('auth/login', { title: 'Sign in', form: { email }, error });
    }
    if (user.status !== 'active') {
      return res.status(403).render('auth/login', { title: 'Sign in', form: { email }, error: 'This account has been suspended. Please contact support@iftarparty.com.' });
    }
    const returnTo = req.session.returnTo;
    req.session.returnTo = null;
    req.session.userId = user.id;
    res.redirect(safeReturn(returnTo, homeFor(user)));
  });

  /* ---------- Google sign-in ---------- */

  router.get('/auth/google', (req, res) => {
    if (!google.enabled()) return res.status(404).render('error', { title: 'Not available', message: 'Google sign-in is not set up yet.' });
    const { url, pending } = google.begin();
    req.session.google = { ...pending, role: req.query.role === 'restaurant' ? 'restaurant' : 'host' };
    res.redirect(url);
  });

  router.get('/auth/google/callback', async (req, res) => {
    const pending = req.session.google;
    req.session.google = null;
    const fail = (message) => { req.flash('error', message); res.redirect('/login'); };
    if (req.query.error) return fail('Google sign-in was cancelled.');
    let profile;
    try {
      profile = await google.finish(req.query, pending);
    } catch (err) {
      console.warn(`[google] sign-in failed: ${err.message}`);
      return fail('Google sign-in failed. Please try again.');
    }
    const email = normalizeEmail(profile.email);
    if (!email) return fail('Your Google account has no usable email address.');

    let user = await db.prepare('SELECT * FROM users WHERE google_sub = ?').get(profile.sub);
    if (!user) {
      user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (user?.google_sub) return fail('This email is linked to a different Google account.');
      // Google has verified the address, so it is safe to link it to the existing account.
      if (user) await db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(profile.sub, user.id);
    }
    if (user && user.status !== 'active') return fail('This account has been suspended. Please contact support@iftarparty.com.');
    let created = false;
    if (!user) {
      const name = profile.name.length >= 2 ? profile.name : email.split('@')[0];
      const id = Number((await db.prepare(`INSERT INTO users (name, email, phone, password_hash, role, google_sub) VALUES (?, ?, NULL, '', ?, ?)`)
        .run(name, email, pending.role, profile.sub)).lastInsertRowid);
      user = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      created = true;
    }
    req.session.userId = user.id;
    if (created) req.flash('success', `Welcome, ${user.name.split(' ')[0]}!`);
    // Missing details (mobile, restaurant) are collected by requireProfile on the next request.
    const returnTo = req.session.returnTo;
    req.session.returnTo = null;
    res.redirect(safeReturn(returnTo, created && user.role === 'host' ? '/search' : homeFor(user)));
  });

  /** One-time details Google can't give us: a mobile number, and the restaurant for partner accounts. */
  router.get('/welcome', requireAuth(), (req, res) => {
    if (!req.user.needsProfile) return res.redirect(homeFor(req.user));
    res.render('auth/welcome', { title: 'Almost done', form: {}, errors: [] });
  });

  router.post('/welcome', requireAuth(), async (req, res) => {
    if (!req.user.needsProfile) return res.redirect(homeFor(req.user));
    const b = req.body;
    const errors = [];
    const phone = req.user.phone || normalizePhone(b.phone);
    const needsRestaurant = req.user.role === 'restaurant' && !req.restaurant;
    if (!phone) errors.push('Please enter a valid mobile number – we use it for payment receipts and WhatsApp updates.');
    if (needsRestaurant) {
      if (!String(b.restaurant_name || '').trim()) errors.push('Please enter your restaurant name.');
      if (!String(b.city || '').trim()) errors.push('Please enter the city.');
    }
    if (errors.length) return res.status(422).render('auth/welcome', { title: 'Almost done', form: b, errors });
    await transaction(db, async () => {
      await db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.user.id);
      if (needsRestaurant) {
        await db.prepare(`INSERT INTO restaurants (owner_id, name, cuisine, area, city, phone, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
          .run(req.user.id, b.restaurant_name.trim(), String(b.cuisine || '').trim(), String(b.area || '').trim(), b.city.trim(), phone);
      }
    });
    if (needsRestaurant) req.flash('success', 'Welcome aboard! Add your halls and menus now – your listing goes live once our team approves it.');
    const returnTo = req.session.returnTo;
    req.session.returnTo = null;
    res.redirect(safeReturn(returnTo, homeFor(req.user)));
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
  });

  return router;
};
