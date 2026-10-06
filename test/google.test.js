'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
Object.assign(config.google, { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' });
const { makeApp, csrf, request } = require('./helpers');

/** Fake Google token endpoint: returns an ID token with the given claims (nonce copied from the auth request). */
function fakeGoogle(claims) {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://oauth2.googleapis.com/token')) return realFetch(url, opts);
    const form = new URLSearchParams(opts.body);
    calls.push(Object.fromEntries(form));
    const payload = { iss: 'https://accounts.google.com', aud: config.google.clientId, exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims };
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return new Response(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc(payload)}.sig` }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

/** Run the full redirect dance for an agent; returns the callback response. */
async function googleSignIn(agent, claims, { role, tamper } = {}) {
  const start = await agent.get(`/auth/google${role ? `?role=${role}` : ''}`).expect(302);
  const auth = new URL(start.headers.location);
  const state = auth.searchParams.get('state');
  const g = fakeGoogle({ nonce: auth.searchParams.get('nonce'), ...claims });
  try {
    return { auth, g, res: await agent.get(`/auth/google/callback?code=abc&state=${tamper ? 'forged' : state}`).expect(302) };
  } finally { g.restore(); }
}

describe('Google sign-in', () => {
  const { db, app } = makeApp();
  after(() => Object.assign(config.google, { clientId: '', clientSecret: '' }));

  test('login and signup offer Google; start uses PKCE, state, nonce and the registered redirect URI', async () => {
    assert.match((await request(app).get('/login')).text, /href="\/auth\/google"/);
    assert.match((await request(app).get('/signup?role=restaurant')).text, /href="\/auth\/google\?role=restaurant"/);
    const res = await request(app).get('/auth/google').expect(302);
    const u = new URL(res.headers.location);
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(u.searchParams.get('redirect_uri'), `${config.baseUrl}/auth/google/callback`);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('scope'), 'openid email profile');
    assert.ok(u.searchParams.get('state').length > 20 && u.searchParams.get('nonce').length > 20);
  });

  test('new host: account created, asked for mobile once, then lands where they were going', async () => {
    const agent = request.agent(app);
    const { res, g } = await googleSignIn(agent, { sub: 'g-1', email: 'Zara@Gmail.com', name: 'Zara Khan' });
    assert.equal(g.calls[0].code_verifier.length > 40, true);
    assert.equal(g.calls[0].redirect_uri, `${config.baseUrl}/auth/google/callback`);
    assert.equal(res.headers.location, '/search');
    const u = await db.prepare(`SELECT * FROM users WHERE google_sub = 'g-1'`).get();
    assert.deepEqual([u.email, u.name, u.role, u.phone, u.password_hash], ['zara@gmail.com', 'Zara Khan', 'host', null, '']);

    const blocked = await agent.get('/search').expect(302);
    assert.equal(blocked.headers.location, '/welcome');
    const token = await csrf(agent, '/welcome');
    await agent.post('/welcome').type('form').send({ _csrf: token, phone: 'nope' }).expect(422);
    const done = await agent.post('/welcome').type('form').send({ _csrf: token, phone: '9876543210' }).expect(302);
    assert.equal(done.headers.location, '/search');
    await agent.get('/search').expect(200);
    assert.match((await db.prepare('SELECT phone FROM users WHERE id = ?').get(u.id)).phone, /9876543210$/);

    // Password login is refused for a Google-only account, with a pointer to Google.
    const anon = request.agent(app);
    const lt = await csrf(anon);
    const login = await anon.post('/login').type('form').send({ _csrf: lt, email: 'zara@gmail.com', password: '' }).expect(401);
    assert.match(login.text, /signs in with Google/);
  });

  test('returning user signs straight in; existing email account gets linked', async () => {
    const again = await googleSignIn(request.agent(app), { sub: 'g-1', email: 'zara@gmail.com', name: 'Zara Khan' });
    assert.equal(again.res.headers.location, '/my-parties');
    assert.equal((await db.prepare(`SELECT COUNT(*) n FROM users WHERE email = 'zara@gmail.com'`).get()).n, 1);

    await db.prepare(`INSERT INTO users (name, email, phone, password_hash, role) VALUES ('Old Host', 'old@example.com', '+919800000000', 'x', 'host')`).run();
    const agent = request.agent(app);
    const { res } = await googleSignIn(agent, { sub: 'g-2', email: 'old@example.com', name: 'Old Host' });
    assert.equal(res.headers.location, '/my-parties');
    assert.equal((await db.prepare(`SELECT google_sub FROM users WHERE email = 'old@example.com'`).get()).google_sub, 'g-2');
    await agent.get('/my-parties').expect(200);
    // The same email from a different Google account is not linked.
    const other = await googleSignIn(request.agent(app), { sub: 'g-evil', email: 'old@example.com' });
    assert.equal(other.res.headers.location, '/login');
  });

  test('restaurant via Google: asked for restaurant details, listing starts pending', async () => {
    const agent = request.agent(app);
    await googleSignIn(agent, { sub: 'g-3', email: 'chef@example.com', name: 'Chef Ali' }, { role: 'restaurant' });
    assert.equal((await agent.get('/restaurant').expect(302)).headers.location, '/welcome');
    const token = await csrf(agent, '/welcome');
    await agent.post('/welcome').type('form').send({ _csrf: token, phone: '9876500000', restaurant_name: 'Ali’s Kitchen', city: 'Pune' }).expect(302);
    const r = await db.prepare(`SELECT r.* FROM restaurants r JOIN users u ON u.id = r.owner_id WHERE u.google_sub = 'g-3'`).get();
    assert.deepEqual([r.name, r.city, r.status], ['Ali’s Kitchen', 'Pune', 'pending']);
    await agent.get('/restaurant').expect(200);
  });

  test('forged state, wrong nonce, wrong audience, unverified email and suspended users are refused', async () => {
    const before = (await db.prepare('SELECT COUNT(*) n FROM users').get()).n;
    const cases = [
      [{ sub: 'x1', email: 'a@x.com' }, { tamper: true }],
      [{ sub: 'x2', email: 'b@x.com', nonce: 'replayed' }],
      [{ sub: 'x3', email: 'c@x.com', aud: 'someone-else' }],
      [{ sub: 'x4', email: 'd@x.com', email_verified: false }],
      [{ sub: 'x5', email: 'e@x.com', exp: 1 }],
    ];
    for (const [claims, opts] of cases) {
      const agent = request.agent(app);
      const { res } = await googleSignIn(agent, claims, opts);
      assert.equal(res.headers.location, '/login', JSON.stringify(claims));
      assert.equal((await agent.get('/my-parties')).status, 302, 'not signed in');
    }
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM users').get()).n, before);

    await db.prepare(`UPDATE users SET status = 'suspended' WHERE google_sub = 'g-2'`).run();
    const { res } = await googleSignIn(request.agent(app), { sub: 'g-2', email: 'old@example.com' });
    assert.equal(res.headers.location, '/login');
  });

  test('callback without a started sign-in is refused; cancel goes back to login', async () => {
    assert.equal((await request(app).get('/auth/google/callback?code=x&state=y').expect(302)).headers.location, '/login');
    assert.equal((await request(app).get('/auth/google/callback?error=access_denied').expect(302)).headers.location, '/login');
  });
});
