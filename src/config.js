'use strict';
require('dotenv').config({ quiet: true });
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const env = process.env;

const config = {
  root,
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  sessionSecret: env.SESSION_SECRET || 'dev-only-secret-change-me',
  databasePath: env.DATABASE_PATH || path.join(root, 'data', 'iftarparty.db'),
  uploadDir: path.resolve(root, env.UPLOAD_DIR || 'uploads'),
  currency: (env.CURRENCY || 'INR').toUpperCase(),
  platformFeePercent: Number(env.PLATFORM_FEE_PERCENT ?? 5),
  holdMinutes: Number(env.BOOKING_HOLD_MINUTES || 30),
  defaultCountryCode: String(env.DEFAULT_COUNTRY_CODE || '91'),
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  },
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'IftarParty <invites@iftarparty.com>',
  },
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    templateName: env.WHATSAPP_TEMPLATE_NAME || 'iftar_invite',
    templateLang: env.WHATSAPP_TEMPLATE_LANG || 'en',
    apiVersion: env.WHATSAPP_API_VERSION || 'v21.0',
  },
  isProduction: env.NODE_ENV === 'production',
};

if (config.isProduction && config.sessionSecret === 'dev-only-secret-change-me') {
  throw new Error('SESSION_SECRET must be set in production');
}

module.exports = config;
