'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const config = require('./config');
const money = require('./services/money');
const fmt = require('./services/format');
const payments = require('./services/payments');
const settings = require('./services/settings');
const packages = require('./services/packages');
const google = require('./services/google');
const storage = require('./services/storage');
const { loadUser, requireProfile } = require('./middleware/auth');
const { flash, csrf } = require('./middleware/session-helpers');

function createApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  if (config.isProduction) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://sdk.cashfree.com'],
        'connect-src': ["'self'", 'https://sdk.cashfree.com', 'https://*.cashfree.com'],
        'frame-src': ['https://*.cashfree.com'],
        'img-src': ["'self'", 'data:', ...(config.supabase.url ? [config.supabase.url] : [])],
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        // The Cashfree SDK hands off to its hosted checkout via a form post.
        'form-action': ["'self'", 'https://*.cashfree.com'],
        'upgrade-insecure-requests': config.isProduction ? [] : null,
      },
    },
  }));

  // Payment webhooks need the raw body to verify signatures, so mount before body parsers.
  app.use('/webhooks', require('./routes/webhooks')(db));

  // Liveness for the platform's health check: the process is up and the database answers.
  app.get('/healthz', async (req, res) => {
    try {
      await db.prepare('SELECT 1').get();
      res.type('text').send('ok');
    } catch {
      res.status(503).type('text').send('db unavailable');
    }
  });
  app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: config.isProduction ? '7d' : 0 }));
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '30d', fallthrough: false }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieSession({
    name: 'ip_sess',
    keys: [config.sessionSecret],
    maxAge: 14 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
    secure: config.isProduction,
  }));
  app.use(flash);
  app.use(async (req, res, next) => {
    Object.assign(res.locals, {
      money, fmt, packages, path: req.path, query: req.query,
      currency: config.currency, feePercent: await settings.feePercent(db), holdMinutes: config.holdMinutes, defaultCountryCode: config.defaultCountryCode,
      paymentsLive: payments.isLive(), googleEnabled: google.enabled(), photoUrl: storage.photoUrl, title: null, user: null, restaurant: null, csrfToken: '',
    });
    next();
  });

  app.use(csrf);
  app.use(loadUser(db));
  app.use(requireProfile);
  app.use(require('./routes/public')(db));
  app.use(require('./routes/auth')(db));
  app.use('/restaurant', require('./routes/restaurant')(db));
  app.use('/admin', require('./routes/admin')(db));
  app.use(require('./routes/bookings')(db));
  app.use(require('./routes/rsvp')(db));

  app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'We couldn’t find that page.' }));
  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).render('error', { title: 'File too large', message: 'Images must be under 5 MB and guest lists under 1 MB.' });
    }
    if (err.status === 404 || err.statusCode === 404) return res.status(404).end();
    console.error(err.sql ? `${err.message}\n  in SQL: ${err.sql.replace(/\s+/g, " ").slice(0, 600)}` : err);
    if (res.headersSent) return next(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' });
  });

  return app;
}

module.exports = { createApp };
