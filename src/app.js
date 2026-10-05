'use strict';
/**
 * The deployable application: opens the configured database, seeds demo data when
 * DEMO_MODE is on, and exports a ready Express app (used by src/server.js locally and
 * by api/index.js on Vercel). Tests build their own app via create-app.js.
 */
const config = require('./config');
const db = require('./db').open();
const { createApp } = require('./create-app');
const { expireStaleHolds } = require('./services/bookings');

if (config.demoMode) require('../scripts/seed').seedDemo(db, { quiet: true });

const app = createApp(db);
setInterval(() => expireStaleHolds(db), 60_000).unref();

module.exports = app;
module.exports.db = db;
