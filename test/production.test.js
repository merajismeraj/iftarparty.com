'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { makeApp, signinAdmin, request } = require('./helpers');
const { ensureAdmin } = require('../src/services/bootstrap');

describe('production readiness', () => {
  test('/healthz answers ok while the database is reachable', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/healthz').expect(200);
    assert.equal(res.text, 'ok');
  });

  test('first-boot admin from env: created once, never overwrites, needs a strong password', async () => {
    const { db } = makeApp();
    assert.equal(await ensureAdmin(db, {}), null, 'no env, no admin');
    assert.equal(await ensureAdmin(db, { ADMIN_EMAIL: 'ops@iftarparty.com', ADMIN_PASSWORD: 'short' }), null);
    assert.equal(await ensureAdmin(db, { ADMIN_EMAIL: 'Ops@IftarParty.com', ADMIN_PASSWORD: 'a-long-admin-pass', ADMIN_NAME: 'Meraj' }), 'ops@iftarparty.com');
    const admin = await db.prepare(`SELECT * FROM users WHERE role = 'admin'`).get();
    assert.equal(admin.name, 'Meraj');
    assert.ok(bcrypt.compareSync('a-long-admin-pass', admin.password_hash));
    // Restart with a different password: the existing admin is untouched.
    assert.equal(await ensureAdmin(db, { ADMIN_EMAIL: 'ops@iftarparty.com', ADMIN_PASSWORD: 'another-long-pass' }), null);
    assert.ok(bcrypt.compareSync('a-long-admin-pass', (await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(admin.id)).password_hash));
  });

  test('bootstrap refuses to hijack an existing non-admin account', async () => {
    const { db } = makeApp();
    await db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES ('Host', 'host@x.com', 'h', 'host')`).run();
    assert.equal(await ensureAdmin(db, { ADMIN_EMAIL: 'host@x.com', ADMIN_PASSWORD: 'a-long-admin-pass' }), null);
    assert.equal((await db.prepare(`SELECT role FROM users WHERE email = 'host@x.com'`).get()).role, 'host');
  });

  test('admins can download a full JSON backup; others cannot', async () => {
    const { db, app } = makeApp();
    await request(app).get('/admin/backup').expect(302);
    const admin = await signinAdmin(app, db);
    const res = await admin.get('/admin/backup').expect(200);
    assert.match(res.headers['content-disposition'], /attachment; filename="iftarparty-.*\.json"/);
    const dump = JSON.parse(res.text);
    assert.ok(dump.tables.bookings && dump.tables.guests && dump.tables.payments);
    assert.equal(dump.tables.users.find((u) => u.role === 'admin').email, 'admin@test.local');
    assert.ok(await db.prepare(`SELECT 1 FROM admin_actions WHERE action = 'database.backup'`).get(), 'audited');
  });
});
