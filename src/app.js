'use strict';
/**
 * The deployable application, used by src/server.js (long-running) and api/index.js (Vercel).
 * Exports a request handler that is usable immediately: the database migrates in the background
 * and requests wait until startup (migrations, demo seed, first admin) has finished.
 * Tests build their own app via create-app.js.
 */
const config = require('./config');
const { openSync } = require('./db');
const { createApp } = require('./create-app');
const { expireStaleHolds } = require('./services/bookings');

const db = openSync();
const app = createApp(db);

let startup = null;
function started() {
  startup ??= (async () => {
    await db.ready();
    if (config.demoMode) await require('../scripts/seed').seedDemo(db, { quiet: true });
    await require('./services/bootstrap').ensureAdmin(db);
    // Surface storage misconfiguration in the logs at boot rather than on the first upload.
    require('./services/storage').ensureBucket().catch((err) => console.error('[storage]', err.message));
  })().catch((err) => {
    startup = null; // retry on the next request (e.g. the database was briefly unreachable)
    throw err;
  });
  return startup;
}
started().catch((err) => console.error('[startup]', err.message));

function handler(req, res) {
  started().then(() => app(req, res), (err) => {
    console.error('[startup]', err.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Retry-After', '5');
    res.end('IftarParty is starting up – please retry in a moment.');
  });
}

// Long-running servers sweep expired payment holds; on serverless they are expired lazily on read.
if (!config.onVercel) setInterval(() => expireStaleHolds(db).catch(() => {}), 60_000).unref();

module.exports = handler;
module.exports.app = app;
module.exports.db = db;
module.exports.started = started;
