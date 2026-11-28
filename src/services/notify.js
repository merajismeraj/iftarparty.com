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
 * WhatsApp goes through AiSensy when its API key is set, otherwise Meta's Cloud API when a token and
 * phone number id are set; with neither, messages are only logged.
 */
function whatsappProvider() {
  if (config.whatsapp.aisensy.apiKey) return 'aisensy';
  if (config.whatsapp.token && config.whatsapp.phoneNumberId) return 'meta';
  return null;
}
function whatsappEnabled() {
  return Boolean(whatsappProvider());
}

/**
 * Template parameters may not contain newlines, tabs or more than four consecutive spaces, and may not
 * be empty – Meta rejects the whole message otherwise (error 132018).
 */
function templateParam(value) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return (text || '-').slice(0, 1000);
}

/**
 * Send a WhatsApp message with Meta's WhatsApp Cloud API. Business-initiated messages must use a
 * pre-approved template; ours take positional body parameters ({{1}} guest name, {{2}} party title, …).
 * Returns { status: 'sent', providerId } on acceptance – delivery and read receipts arrive later via the
 * webhook (routes/webhooks.js). Without credentials the message is only logged (demo mode).
 */
async function sendWhatsApp({ to, params = [], previewText, template, name }) {
  const provider = whatsappProvider();
  if (!provider) {
    console.log(`[whatsapp:demo] to=${to}\n${previewText}\n`);
    return { status: 'logged', detail: 'WhatsApp not configured – logged only' };
  }
  if (provider === 'aisensy') return sendViaAiSensy({ to, params, template, name });
  const { token, phoneNumberId, templateLang, apiVersion } = config.whatsapp;
  try {
    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(to).replace(/\D/g, ''),
        type: 'template',
        template: {
          name: template || config.whatsapp.templateName,
          language: { code: templateLang },
          components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: templateParam(p) })) }],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = body?.error || {};
      const why = e.error_data?.details || e.message || `HTTP ${res.status}`;
      return { status: 'failed', detail: e.code ? `(#${e.code}) ${why}` : why };
    }
    const id = body?.messages?.[0]?.id || '';
    return { status: 'sent', detail: id, providerId: id || null };
  } catch (err) {
    return { status: 'failed', detail: `WhatsApp API unreachable: ${err.message}` };
  }
}

/**
 * AiSensy API campaign (https://wiki.aisensy.com/en/articles/11501889-api-reference-docs): POST the
 * campaign name, destination with country code and the template parameters, in template order.
 * AiSensy reports no delivery receipts to us, so a guest stays at "sent".
 */
async function sendViaAiSensy({ to, params, template, name }) {
  const { apiKey, inviteCampaign, cancelCampaign, endpoint } = config.whatsapp.aisensy;
  const campaignName = template && template === config.whatsapp.cancelTemplateName ? cancelCampaign : inviteCampaign;
  const digits = String(to).replace(/\D/g, '');
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        campaignName,
        destination: `+${digits}`,
        userName: templateParam(name || params[0] || 'Guest').slice(0, 100),
        source: 'iftarparty.com',
        templateParams: params.map(templateParam),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let why = text;
      try { const b = JSON.parse(text); why = b.message || b.error || b.errorMessage || text; } catch { /* plain text */ }
      return { status: 'failed', detail: `AiSensy HTTP ${res.status}: ${String(why).slice(0, 300)}` };
    }
    return { status: 'sent', detail: `AiSensy campaign ${campaignName}`, providerId: null };
  } catch (err) {
    return { status: 'failed', detail: `AiSensy unreachable: ${err.message}` };
  }
}

/** Meta webhook signature: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body). */
function verifyWhatsAppSignature(rawBody, header) {
  const secret = config.whatsapp.appSecret;
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(require('node:crypto').createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header.slice(7));
  return expected.length === given.length && require('node:crypto').timingSafeEqual(expected, given);
}

module.exports = { sendEmail, sendWhatsApp, whatsappEnabled, whatsappProvider, templateParam, verifyWhatsAppSignature };
