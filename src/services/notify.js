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

/**
 * Send a WhatsApp template message via the Meta Cloud API.
 * Business-initiated WhatsApp messages must use a pre-approved template; ours takes
 * five body parameters: {{1}} guest name, {{2}} party title, {{3}} date & time,
 * {{4}} venue, {{5}} RSVP link. Pass `template` to send a different approved template.
 */
async function sendWhatsApp({ to, params, previewText, template }) {
  const { token, phoneNumberId, templateLang, apiVersion } = config.whatsapp;
  const templateName = template || config.whatsapp.templateName;
  if (!token || !phoneNumberId) {
    console.log(`[whatsapp:demo] to=${to}\n${previewText}\n`);
    return { status: 'logged', detail: 'WhatsApp API not configured – logged only' };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: templateName,
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

module.exports = { sendEmail, sendWhatsApp };
