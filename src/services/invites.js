'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const ejs = require('ejs');
const config = require('../config');
const fmt = require('./format');
const notify = require('./notify');

const EMAIL_TEMPLATE = path.join(config.root, 'views', 'emails', 'invite.ejs');
const CANCEL_TEMPLATE = path.join(config.root, 'views', 'emails', 'cancelled.ejs');

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

async function log(db, guestId, channel, recipient, result, kind = 'invite') {
  await db.prepare('INSERT INTO message_log (guest_id, channel, recipient, status, detail, kind, provider_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(guestId, channel, recipient, result.status, String(result.detail || '').slice(0, 500), kind, result.providerId || null);
}

/** WhatsApp status order: a late "delivered" never overwrites "read". */
const WA_RANK = { sent: 1, delivered: 2, read: 3 };

/**
 * Apply one WhatsApp Cloud API status update (sent / delivered / read / failed) to the message log and
 * the guest's invite status. Returns true if a logged message matched.
 */
async function applyWhatsAppStatus(db, { id, status, errors = [] }) {
  if (!id || !['sent', 'delivered', 'read', 'failed'].includes(status)) return false;
  const msg = await db.prepare(`SELECT * FROM message_log WHERE provider_id = ? AND channel = 'whatsapp'`).get(String(id));
  if (!msg) return false;
  if (status !== 'failed' && (WA_RANK[status] || 0) <= (WA_RANK[msg.status] || 0)) return true;
  const e = errors[0] || {};
  const detail = status === 'failed'
    ? `${e.code ? `(#${e.code}) ` : ''}${e.error_data?.details || e.message || e.title || 'Delivery failed'}`.slice(0, 500)
    : msg.detail;
  await db.prepare('UPDATE message_log SET status = ?, detail = ? WHERE id = ?').run(status, detail, msg.id);
  if (msg.kind === 'invite' && msg.guest_id) {
    // Only the guest's latest WhatsApp invite decides what the host sees.
    const latest = await db.prepare(
      `SELECT id FROM message_log WHERE guest_id = ? AND channel = 'whatsapp' AND kind = 'invite' ORDER BY id DESC LIMIT 1`
    ).get(msg.guest_id);
    if (latest?.id === msg.id) await db.prepare('UPDATE guests SET whatsapp_status = ? WHERE id = ?').run(status, msg.guest_id);
  }
  return true;
}

async function sendOne(db, booking, guest) {
  const invite = buildInvite(booking, guest);
  const tasks = [];
  if (guest.email) {
    tasks.push((async () => {
      const html = await renderEmail(booking, guest, invite);
      const r = await notify.sendEmail({ to: guest.email, subject: invite.subject, html, text: invite.text });
      await log(db, guest.id, 'email', guest.email, r);
      await db.prepare('UPDATE guests SET email_status = ? WHERE id = ?').run(r.status, guest.id);
    })());
  }
  if (guest.phone) {
    tasks.push((async () => {
      const r = await notify.sendWhatsApp({ to: guest.phone, params: invite.whatsappParams, previewText: invite.text });
      await log(db, guest.id, 'whatsapp', guest.phone, r);
      await db.prepare('UPDATE guests SET whatsapp_status = ? WHERE id = ?').run(r.status, guest.id);
    })());
  }
  await Promise.all(tasks);
  await db.prepare(`UPDATE guests SET invited_at = ts_now() WHERE id = ?`).run(guest.id);
}

/**
 * Send invites for a booking. scope: 'new' (never invited), 'pending' (no reply yet) or a guest id.
 * Sends with bounded concurrency so large lists don't trip provider rate limits.
 */
async function sendInvites(db, booking, scope = 'new', concurrency = 5) {
  let guests;
  if (scope === 'new') guests = await db.prepare('SELECT * FROM guests WHERE booking_id = ? AND invited_at IS NULL').all(booking.id);
  else if (scope === 'pending') guests = await db.prepare(`SELECT * FROM guests WHERE booking_id = ? AND rsvp_status = 'pending'`).all(booking.id);
  else guests = await db.prepare('SELECT * FROM guests WHERE booking_id = ? AND id = ?').all(booking.id, Number(scope));

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

/** Everything needed to tell one guest their Iftar is cancelled. */
function buildCancellation(booking, guest) {
  const firstName = guest.name.split(/\s+/)[0];
  const date = fmt.longDate(booking.event_date);
  const text = [
    `Assalamu Alaikum ${firstName},`,
    '',
    `We're sorry – ${booking.title} on ${date} at ${booking.venue_name} has been cancelled.`,
    booking.cancel_reason ? `Reason: ${booking.cancel_reason}` : null,
    '',
    `${booking.host_name} will be in touch if the Iftar is rescheduled. No action is needed from you.`,
  ].filter((l) => l !== null).join('\n');
  return {
    subject: `Cancelled: ${booking.title} – ${fmt.shortDate(booking.event_date)}`,
    text,
    // {{1}} guest name, {{2}} party title, {{3}} date, {{4}} venue
    whatsappParams: [firstName, booking.title, date, venueLine(booking)],
  };
}

/**
 * Tell every guest who received an invitation (and hasn't already declined) that the party is off.
 * Uses the same bounded concurrency as invites; each attempt is logged with kind 'cancellation'.
 */
async function sendCancellations(db, booking, concurrency = 5) {
  const guests = await db.prepare(
    `SELECT * FROM guests WHERE booking_id = ? AND invited_at IS NOT NULL AND rsvp_status <> 'no'`
  ).all(booking.id);
  const sendOneCancel = async (guest) => {
    const notice = buildCancellation(booking, guest);
    const tasks = [];
    if (guest.email) {
      tasks.push((async () => {
        const html = await ejs.renderFile(CANCEL_TEMPLATE, { booking, guest, notice, fmt, venueLine: venueLine(booking) });
        await log(db, guest.id, 'email', guest.email, await notify.sendEmail({ to: guest.email, subject: notice.subject, html, text: notice.text }), 'cancellation');
      })());
    }
    if (guest.phone) {
      tasks.push((async () => {
        const r = await notify.sendWhatsApp({ to: guest.phone, params: notice.whatsappParams, previewText: notice.text, template: config.whatsapp.cancelTemplateName });
        await log(db, guest.id, 'whatsapp', guest.phone, r, 'cancellation');
      })());
    }
    await Promise.all(tasks);
  };
  let i = 0;
  const worker = async () => {
    while (i < guests.length) {
      const g = guests[i++];
      try {
        await sendOneCancel(g);
      } catch (err) {
        console.error(`[cancel-notice] guest ${g.id} failed:`, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, guests.length) }, worker));
  return guests.length;
}

module.exports = { newToken, buildInvite, sendInvites, rsvpUrl, buildCancellation, sendCancellations, applyWhatsAppStatus };
