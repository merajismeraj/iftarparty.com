'use strict';
/*
 * Create an admin, or promote/demote an existing account. Admins can only be created here,
 * never from the web UI.
 *
 *   npm run admin -- create admin@iftarparty.com "Your Name"   (password from ADMIN_PASSWORD or prompt)
 *   npm run admin -- promote someone@example.com
 *   npm run admin -- suspend admin@iftarparty.com
 */
const readline = require('node:readline/promises');
const bcrypt = require('bcryptjs');
const db = require('../src/db').open();
const { normalizeEmail } = require('../src/services/guestlist');

async function password() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pw = await rl.question('Password (min 12 chars): ');
  rl.close();
  return pw;
}

async function main() {
  const [cmd, rawEmail, ...nameParts] = process.argv.slice(2);
  const email = normalizeEmail(rawEmail);
  if (!['create', 'promote', 'suspend'].includes(cmd) || !email) {
    console.error('Usage: npm run admin -- create <email> "<name>" | promote <email> | suspend <email>');
    process.exit(1);
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (cmd === 'create') {
    if (user) throw new Error(`${email} already exists – use "promote" instead.`);
    const pw = await password();
    if (pw.length < 12) throw new Error('Admin passwords must be at least 12 characters.');
    const name = nameParts.join(' ').trim() || 'Administrator';
    db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')`).run(name, email, await bcrypt.hash(pw, 12));
    console.log(`Admin ${email} created. Sign in at /login.`);
  } else if (cmd === 'promote') {
    if (!user) throw new Error(`No account for ${email}.`);
    if (user.role === 'restaurant') throw new Error('Restaurant accounts can’t be admins – create a separate admin login.');
    db.prepare(`UPDATE users SET role = 'admin', status = 'active' WHERE id = ?`).run(user.id);
    console.log(`${email} is now an admin.`);
  } else {
    if (!user) throw new Error(`No account for ${email}.`);
    db.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).run(user.id);
    console.log(`${email} suspended.`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
