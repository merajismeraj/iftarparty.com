'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const ejs = require('ejs');
const config = require('../config');
const fmt = require('./format');
const notify = require('./notify');

const EMAIL_TEMPLATE = path.join(config.root, 'views', 'emails', 'invite.ejs');

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function rsvpUrl(guest) {
  return `${config.baseUrl}/rsvp/${guest.rsvp_token}`;
}

function venueLine(booking) {
  return `${booking.venue_name}, ${booking.restaurant_name}, ${[booking.area, booking.city].filter(Boolean).join(', ')}`;
}

/** Everything needed to render one guest's personalised invite on any channel. */
function buildInvite(booking, guest) {
  const when = `${fmt.longDate(booking.event_date)} at ${fmt.time12(booking.arrival_time)}`;
  const link = rsvpUrl(guest);
  const firstName = guest.name.split(/\s+/)[0];
  const text = [
    `Assalamu Alaikum ${firstName},`,
    '',
    `You're invited to ${booking.title}!`,
    booking.invite_message ? `\n"${booking.invite_message}"\n— ${booking.host_name}\n` : null,
    `When: ${when}`,
    `Where: ${venueLine(booking)}`,
    booking.address ? `Address: ${booking.address}` : null,
    '',
    `Please RSVP here: ${link}`,
  ].filter((l) => l !== null).join('\n');
  return {
    subject: `You're invited: ${booking.title} – ${fmt.shortDate(booking.event_date)}`,
    text,
    link,
    when,
    whatsappParams: [firstName, booking.title, when, venueLine(booking), link],
  };
}

async function renderEmail(booking, guest, invite) {
  return ejs.renderFile(EMAIL_TEMPLATE, { booking, guest, invite, fmt, venueLine: venueLine(booking) });
}

function log(db, guestId, channel, recipient, result) {
  db.prepare('INSERT INTO message_log (guest_id, channel, recipient, status, detail) VALUES (?, ?, ?, ?, ?)')
    .run(guestId, channel, recipient, result.status, String(result.detail || '').slice(0, 500));
}

async function sendOne(db, booking, guest) {
  const invite = buildInvite(booking, guest);
  const tasks = [];
  if (guest.email) {
    tasks.push((async () => {
      const html = await renderEmail(booking, guest, invite);
      const r = await notify.sendEmail({ to: guest.email, subject: invite.subject, html, text: invite.text });
      log(db, guest.id, 'email', guest.email, r);
      db.prepare('UPDATE guests SET email_status = ? WHERE id = ?').run(r.status, guest.id);
    })());
  }
  if (guest.phone) {
    tasks.push((async () => {
      const r = await notify.sendWhatsApp({ to: guest.phone, params: invite.whatsappParams, previewText: invite.text });
      log(db, guest.id, 'whatsapp', guest.phone, r);
      db.prepare('UPDATE guests SET whatsapp_status = ? WHERE id = ?').run(r.status, guest.id);
    })());
  }
  await Promise.all(tasks);
  db.prepare(`UPDATE guests SET invited_at = datetime('now') WHERE id = ?`).run(guest.id);
}

/**
 * Send invites for a booking. scope: 'new' (never invited), 'pending' (no reply yet) or a guest id.
 * Sends with bounded concurrency so large lists don't trip provider rate limits.
 */
async function sendInvites(db, booking, scope = 'new', concurrency = 5) {
  let guests;
  if (scope === 'new') guests = db.prepare('SELECT * FROM guests WHERE booking_id = ? AND invited_at IS NULL').all(booking.id);
  else if (scope === 'pending') guests = db.prepare(`SELECT * FROM guests WHERE booking_id = ? AND rsvp_status = 'pending'`).all(booking.id);
  else guests = db.prepare('SELECT * FROM guests WHERE booking_id = ? AND id = ?').all(booking.id, Number(scope));

  let i = 0;
  const worker = async () => {
    while (i < guests.length) {
      const g = guests[i++];
      try {
        await sendOne(db, booking, g);
      } catch (err) {
        console.error(`[invite] guest ${g.id} failed:`, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, guests.length) }, worker));
  return guests.length;
}

module.exports = { newToken, buildInvite, sendInvites, rsvpUrl };
