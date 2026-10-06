'use strict';
/**
 * Venue photo storage: Supabase Storage (public bucket) when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * are set, otherwise files on local disk under UPLOAD_DIR (served at /uploads).
 * Stored names are opaque (`<uuid>.<ext>`); views turn them into URLs with photoUrl().
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/svg+xml': '.svg' };
const remote = () => Boolean(config.supabase.url && config.supabase.serviceKey);
const safeName = (name) => typeof name === 'string' && /^[\w.-]+$/.test(name) && !name.includes('..');

function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const { url, serviceKey } = config.supabase;
  return fetch(`${url}/storage/v1${pathname}`, {
    method,
    body,
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, ...headers },
    signal: AbortSignal.timeout(20_000),
  });
}

/** Public URL for a stored photo. */
function photoUrl(name) {
  if (!name) return '';
  if (!remote()) return `/uploads/${encodeURIComponent(name)}`;
  return `${config.supabase.url}/storage/v1/object/public/${config.supabase.bucket}/${encodeURIComponent(name)}`;
}

/** Create the public bucket on first use (idempotent). */
let bucketReady = null;
function ensureBucket() {
  if (!remote()) return Promise.resolve();
  bucketReady ??= (async () => {
    const res = await api('/bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: config.supabase.bucket, name: config.supabase.bucket, public: true,
        file_size_limit: 5 * 1024 * 1024, allowed_mime_types: Object.keys(EXT),
      }),
    });
    // 400/409 with "already exists" is fine.
    if (!res.ok && !/already exists|Duplicate/i.test(await res.text())) throw new Error(`Supabase bucket setup failed (HTTP ${res.status})`);
  })().catch((err) => {
    bucketReady = null;
    throw err;
  });
  return bucketReady;
}

/** Store bytes under `name` (or a fresh random name). Returns the stored name. */
async function put(buffer, contentType, name = `${crypto.randomUUID()}${EXT[contentType] || ''}`) {
  if (!safeName(name)) throw new Error('invalid file name');
  if (!remote()) {
    await fs.promises.mkdir(config.uploadDir, { recursive: true });
    await fs.promises.writeFile(path.join(config.uploadDir, name), buffer);
    return name;
  }
  await ensureBucket();
  const res = await api(`/object/${config.supabase.bucket}/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: buffer,
    headers: { 'Content-Type': contentType, 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000' },
  });
  if (!res.ok) throw new Error(`Photo upload failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  return name;
}

/** Store multer in-memory files; returns their names in order. */
async function saveImages(files = []) {
  const names = [];
  for (const f of files) names.push(await put(f.buffer, f.mimetype));
  return names;
}

/** Best-effort delete; a missing file is not an error. */
async function remove(name) {
  if (!safeName(name)) return;
  try {
    if (!remote()) await fs.promises.rm(path.join(config.uploadDir, name), { force: true });
    else await api(`/object/${config.supabase.bucket}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [name] }) });
  } catch (err) {
    console.warn(`[storage] could not delete ${name}: ${err.message}`);
  }
}

module.exports = { photoUrl, put, saveImages, remove, ensureBucket, remote, EXT };
