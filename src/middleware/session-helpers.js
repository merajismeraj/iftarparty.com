'use strict';
const crypto = require('node:crypto');

/** One-shot flash messages stored in the cookie session. */
function flash(req, res, next) {
  const pending = req.session.flash || [];
  if (pending.length) req.session.flash = [];
  res.locals.flash = pending;
  req.flash = (type, message) => {
    req.session.flash = [...(req.session.flash || []), { type, message }];
  };
  next();
}

/** Synchroniser-token CSRF protection for every state-changing form post. */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  res.locals.csrfToken = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Multipart forms carry the token in the query string because the body isn't parsed yet.
  const sent = req.body?._csrf || req.query?._csrf || req.get('x-csrf-token') || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(req.session.csrf);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).render('error', { title: 'Session expired', message: 'Your form expired. Please go back, refresh the page and try again.' });
  }
  next();
}

module.exports = { flash, csrf };
