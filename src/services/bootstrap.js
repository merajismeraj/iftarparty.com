'use strict';
const bcrypt = require('bcryptjs');
const { normalizeEmail } = require('./guestlist');

/**
 * First-boot admin for hosts without a shell: if ADMIN_EMAIL and ADMIN_PASSWORD are set and the
 * database has no admin yet, create one. Never changes an existing account, so the variables are
 * safe to leave set (but remove ADMIN_PASSWORD once you've signed in).
 */
function ensureAdmin(db, env = process.env) {
  const email = normalizeEmail(env.ADMIN_EMAIL);
  const password = String(env.ADMIN_PASSWORD || '');
  if (!email || !password) return null;
  if (db.prepare(`SELECT 1 FROM users WHERE role = 'admin' LIMIT 1`).get()) return null;
  if (password.length < 12) {
    console.warn('[bootstrap] ADMIN_PASSWORD must be at least 12 characters – admin not created.');
    return null;
  }
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (existing) {
    console.warn(`[bootstrap] ${email} already exists as a ${existing.role} – use "npm run admin -- promote" instead.`);
    return null;
  }
  const name = String(env.ADMIN_NAME || 'Administrator').trim();
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')`).run(name, email, bcrypt.hashSync(password, 12));
  console.log(`[bootstrap] admin ${email} created`);
  return email;
}

module.exports = { ensureAdmin };
