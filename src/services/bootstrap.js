'use strict';
const bcrypt = require('bcryptjs');
const { normalizeEmail } = require('./guestlist');

/**
 * First-boot admin for hosts without a shell: if ADMIN_EMAIL and ADMIN_PASSWORD are set and the
 * database has no admin yet, create one. Never changes an existing account, so the variables are
 * safe to leave set (but remove ADMIN_PASSWORD once you've signed in).
 */
async function ensureAdmin(db, env = process.env) {
  const email = normalizeEmail(env.ADMIN_EMAIL);
  const password = String(env.ADMIN_PASSWORD || '');
  if (!email || !password) return null;
  if (await db.prepare(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`).get()) return null;
  if (password.length < 12) {
    console.warn('[bootstrap] ADMIN_PASSWORD must be at least 12 characters – admin not created.');
    return null;
  }
  const existing = await db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (existing) {
    console.warn(`[bootstrap] ${email} already exists as a ${existing.role} – use "npm run admin -- promote" instead.`);
    return null;
  }
  const name = String(env.ADMIN_NAME || 'Administrator').trim();
  await db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')`).run(name, email, bcrypt.hashSync(password, 12));
  console.log(`[bootstrap] admin ${email} created`);
  return email;
}

/**
 * Passwordless alternative: while no admin exists, the person who signs in with Google using
 * ADMIN_EMAIL (an address Google has verified) becomes the admin. Returns true if promoted.
 */
async function claimFirstAdmin(db, user, env = process.env) {
  const email = normalizeEmail(env.ADMIN_EMAIL);
  if (!email || normalizeEmail(user.email) !== email || user.role === 'admin' || user.role === 'restaurant') return false;
  const { transaction } = require('../db');
  return transaction(db, async () => {
    if (await db.prepare(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`).get()) return false;
    await db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(user.id);
    console.log(`[bootstrap] ${email} claimed the first admin account via Google sign-in`);
    return true;
  });
}

module.exports = { ensureAdmin, claimFirstAdmin };
