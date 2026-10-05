'use strict';
const nodemailer = require('nodemailer');
const config = require('../config');

let transporter;
function mailer() {
  if (!config.smtp.host) return null;
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

/** Send an email. Without SMTP configured the message is logged (demo mode). */
async function sendEmail({ to, subject, html, text }) {
  const t = mailer();
  if (!t) {
    console.log(`[email:demo] to=${to} subject="${subject}"\n${text}\n`);
    return { status: 'logged', detail: 'SMTP not configured – logged only' };
  }
  try {
    const info = await t.sendMail({ from: config.smtp.from, to, subject, html, text });
    return { status: 'sent', detail: info.messageId || '' };
  } catch (err) {
    return { status: 'failed', detail: err.message };
  }
}

/** Which WhatsApp backend is active: 'openwa' (default), 'meta' (official Cloud API) or 'demo' (log only). */
function whatsappProvider() {
  const w = config.whatsapp;
  if (w.provider === 'meta') return w.token && w.phoneNumberId ? 'meta' : 'demo';
  return w.openwa.url && w.openwa.apiKey && w.openwa.sessionId ? 'openwa' : 'demo';
}

/*
 * OpenWA (https://github.com/rmyndharis/OpenWA) is an unofficial, self-hosted WhatsApp Web gateway.
 * It sends free-form text (no Meta template approval), but WhatsApp may restrict numbers that look
 * automated – so use a dedicated number and keep sends paced. Messages go out one at a time with a
 * minimum gap (OPENWA_MIN_INTERVAL_MS) across the whole process.
 */
let openwaQueue = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function paced(task) {
  const gap = config.whatsapp.openwa.minIntervalMs;
  const run = openwaQueue.then(task);
  // Jitter the gap a little so sends don't fall on a perfectly regular beat.
  openwaQueue = run.catch(() => {}).then(() => sleep(gap + Math.floor(Math.random() * gap * 0.5)));
  return run;
}

/** "+919876543210" -> "919876543210@c.us" (OpenWA / WhatsApp Web chat id). */
const chatId = (e164) => `${String(e164).replace(/\D/g, '')}@c.us`;

async function sendViaOpenWA(to, text) {
  const { url, apiKey, sessionId } = config.whatsapp.openwa;
  return paced(async () => {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: chatId(to), text }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { status: 'failed', detail: body?.message || body?.error || `OpenWA HTTP ${res.status}` };
      return { status: 'sent', detail: String(body?.id || body?.messageId || body?.data?.id || '') };
    } catch (err) {
      return { status: 'failed', detail: `OpenWA unreachable: ${err.message}` };
    }
  });
}

/**
 * Official Meta Cloud API. Business-initiated messages must use a pre-approved template; ours take
 * body parameters ({{1}} guest name, {{2}} party title, …). Pass `template` for another approved template.
 */
async function sendViaMeta(to, params, template) {
  const { token, phoneNumberId, templateLang, apiVersion } = config.whatsapp;
  try {
    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: template || config.whatsapp.templateName,
          language: { code: templateLang },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'failed', detail: body?.error?.message || `HTTP ${res.status}` };
    return { status: 'sent', detail: body?.messages?.[0]?.id || '' };
  } catch (err) {
    return { status: 'failed', detail: err.message };
  }
}

/**
 * Send a WhatsApp message through the configured provider.
 * `previewText` is the full personalised message (sent as-is by OpenWA); `params`/`template`
 * are used by the Meta template API. Without credentials the message is logged (demo mode).
 */
async function sendWhatsApp({ to, params, previewText, template }) {
  const provider = whatsappProvider();
  if (provider === 'openwa') return sendViaOpenWA(to, previewText);
  if (provider === 'meta') return sendViaMeta(to, params, template);
  console.log(`[whatsapp:demo] to=${to}\n${previewText}\n`);
  return { status: 'logged', detail: 'WhatsApp not configured – logged only' };
}

module.exports = { sendEmail, sendWhatsApp, whatsappProvider };
