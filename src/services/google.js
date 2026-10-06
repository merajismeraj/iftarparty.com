'use strict';
const crypto = require('node:crypto');
const config = require('../config');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const enabled = () => Boolean(config.google.clientId && config.google.clientSecret);
const redirectUri = () => `${config.baseUrl}/auth/google/callback`;
const b64url = (buf) => buf.toString('base64url');

/** Start the authorization-code flow. Returns the Google URL and the secrets to keep in the session. */
function begin() {
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })}`;
  return { url, pending: { state, nonce, verifier, at: Date.now() } };
}

/**
 * Exchange the code and return the verified Google profile.
 * The ID token comes straight from Google's token endpoint over TLS, authenticated with our client
 * secret, so (per OpenID Connect Core §3.1.3.7) its claims are checked rather than its signature.
 */
async function finish({ code, state }, pending) {
  if (!pending || !state || typeof state !== 'string' || !timingSafeEqual(state, pending.state)) throw new Error('state mismatch');
  if (Date.now() - pending.at > 10 * 60_000) throw new Error('sign-in took too long');
  if (!code || typeof code !== 'string') throw new Error('missing code');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: pending.verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) throw new Error(body.error_description || body.error || `token HTTP ${res.status}`);

  const claims = JSON.parse(Buffer.from(String(body.id_token).split('.')[1] || '', 'base64url').toString('utf8') || '{}');
  if (!ISSUERS.has(claims.iss)) throw new Error('bad issuer');
  if (claims.aud !== config.google.clientId) throw new Error('bad audience');
  if (!(claims.exp * 1000 > Date.now())) throw new Error('token expired');
  if (claims.nonce !== pending.nonce) throw new Error('nonce mismatch');
  if (!claims.sub) throw new Error('missing subject');
  if (!claims.email || claims.email_verified !== true) throw new Error('Google email not verified');
  return { sub: String(claims.sub), email: String(claims.email), name: String(claims.name || claims.given_name || '').trim() };
}

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { enabled, redirectUri, begin, finish };
