'use strict';

/** Attach req.user (and req.restaurant for restaurant accounts) from the session. */
function loadUser(db) {
  return (req, res, next) => {
    const id = req.session?.userId;
    if (id) {
      req.user = db.prepare(`SELECT id, name, email, phone, role FROM users WHERE id = ? AND status = 'active'`).get(id) || null;
      if (!req.user) req.session.userId = null; // deleted or suspended: sign out everywhere
      else if (req.user.role === 'restaurant') {
        req.restaurant = db.prepare('SELECT * FROM restaurants WHERE owner_id = ?').get(req.user.id) || null;
      }
    }
    res.locals.user = req.user || null;
    res.locals.restaurant = req.restaurant || null;
    next();
  };
}

/** For a form POST we can't replay, send the user back to the page the form was on. */
function refererPath(req) {
  try {
    const ref = new URL(req.get('referer') || '');
    return ref.host === req.get('host') ? `${ref.pathname}${ref.search}` : null;
  } catch {
    return null;
  }
}

function requireAuth(role) {
  return (req, res, next) => {
    if (!req.user) {
      req.session.returnTo = req.method === 'GET' ? req.originalUrl : refererPath(req);
      req.flash('info', 'Please sign in to continue.');
      return res.redirect('/login');
    }
    if (role && req.user.role !== role) {
      const message = {
        host: 'This page is for party hosts. Restaurant and admin accounts can’t book venues – sign in with a host account.',
        restaurant: 'This page is for restaurant partners.',
        admin: 'This page is for IftarParty administrators.',
      }[role];
      return res.status(403).render('error', { title: 'Not allowed', message });
    }
    next();
  };
}

module.exports = { loadUser, requireAuth };
