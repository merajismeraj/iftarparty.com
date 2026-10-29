'use strict';
/** Waitlist for "Coming soon" restaurants: approved partners that can't be booked yet. */
const config = require('../config');
const notify = require('./notify');
const { normalizeEmail, normalizePhone } = require('./guestlist');

const BOOKABLE = `EXISTS (SELECT 1 FROM venues v WHERE v.restaurant_id = r.id AND v.active = 1)
  AND EXISTS (SELECT 1 FROM menus m WHERE m.restaurant_id = r.id AND m.active = 1)`;

/** Approved restaurants without an active venue or menu, optionally filtered by location. */
function comingSoon(db, { location } = {}) {
  const where = [`r.status = 'approved'`, `NOT (${BOOKABLE})`];
  const params = [];
  if (typeof location === 'string' && location.trim()) {
    const like = `%${location.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(`(r.city ILIKE ? ESCAPE '\\' OR r.area ILIKE ? ESCAPE '\\' OR r.address ILIKE ? ESCAPE '\\' OR r.name ILIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  return db.prepare(
    `SELECT r.id, r.name, r.area, r.city, r.cuisine,
            (SELECT vi.filename FROM venue_images vi JOIN venues v ON v.id = vi.venue_id
             WHERE v.restaurant_id = r.id ORDER BY v.id, vi.sort_order, vi.id LIMIT 1) AS image
     FROM restaurants r WHERE ${where.join(' AND ')} ORDER BY r.name LIMIT 12`
  ).all(...params);
}

async function isBookable(db, restaurantId) {
  return Boolean(await db.prepare(`SELECT 1 FROM restaurants r WHERE r.id = ? AND r.status = 'approved' AND ${BOOKABLE}`).get(restaurantId));
}

/** Add someone to a coming-soon restaurant's waitlist. `contact` is a mobile number or an email. */
async function join(db, restaurantId, { name, contact, userId }) {
  const r = await db.prepare(`SELECT r.id, r.name FROM restaurants r WHERE r.id = ? AND r.status = 'approved' AND NOT (${BOOKABLE})`).get(restaurantId);
  if (!r) return { error: 'This restaurant isn’t taking waitlist sign-ups.' };
  const raw = String(contact || '').trim();
  const email = raw.includes('@') ? normalizeEmail(raw) : null;
  const phone = raw.includes('@') ? null : normalizePhone(raw);
  if (!email && !phone) return { error: 'Enter a valid mobile number or email so we can tell you when it opens.', restaurant: r };
  await db.prepare('INSERT INTO waitlist (restaurant_id, user_id, name, email, phone) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .run(r.id, userId || null, String(name || '').trim().slice(0, 120), email, phone);
  return { restaurant: r, email, phone };
}

function list(db, restaurantId) {
  return db.prepare('SELECT * FROM waitlist WHERE restaurant_id = ? ORDER BY id DESC').all(restaurantId);
}

/** Email everyone not yet told that the restaurant is open for bookings. Returns counts. */
async function notifyOpen(db, restaurantId) {
  const r = await db.prepare('SELECT id, name, area, city FROM restaurants WHERE id = ?').get(restaurantId);
  const venue = await db.prepare('SELECT id FROM venues WHERE restaurant_id = ? AND active = 1 ORDER BY id LIMIT 1').get(restaurantId);
  const link = `${config.baseUrl}${venue ? `/venues/${venue.id}` : `/search?location=${encodeURIComponent(r.name)}`}`;
  const rows = await db.prepare('SELECT * FROM waitlist WHERE restaurant_id = ? AND notified_at IS NULL AND email IS NOT NULL').all(restaurantId);
  let sent = 0;
  for (const w of rows) {
    const hello = w.name ? `Assalamu alaikum ${w.name.split(' ')[0]},` : 'Assalamu alaikum,';
    const text = `${hello}\n\n${r.name}${r.area ? ` (${r.area})` : ''} is now open for Iftar party bookings on IftarParty.\n\nSee venues, menus and prices: ${link}\n\nYou're getting this because you joined the waitlist.`;
    const html = `<p>${hello}</p><p><strong>${escapeHtml(r.name)}</strong>${r.area ? ` (${escapeHtml(r.area)})` : ''} is now open for Iftar party bookings on IftarParty.</p><p><a href="${link}">See venues, menus and prices</a></p><p style="color:#6b6b6b;font-size:13px">You're getting this because you joined the waitlist.</p>`;
    const res = await notify.sendEmail({ to: w.email, subject: `${r.name} is now taking Iftar bookings`, text, html });
    if (res.status !== 'failed') {
      await db.prepare('UPDATE waitlist SET notified_at = ts_now() WHERE id = ?').run(w.id);
      sent++;
    }
  }
  const phoneOnly = (await db.prepare('SELECT COUNT(*) n FROM waitlist WHERE restaurant_id = ? AND email IS NULL').get(restaurantId)).n;
  return { sent, failed: rows.length - sent, phoneOnly: Number(phoneOnly) };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { comingSoon, isBookable, join, list, notifyOpen };
