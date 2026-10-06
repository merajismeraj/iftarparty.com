'use strict';
require('dotenv').config({ quiet: true });
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const env = process.env;

// On Vercel the filesystem is read-only except /tmp, and the URL comes from the platform.
const onVercel = Boolean(env.VERCEL);
// Vercel previews must never touch production data, even when an integration shares its variables
// with the Preview environment. Opt in explicitly with ALLOW_PREVIEW_DATABASE=true.
const isolatedPreview = env.VERCEL_ENV === 'preview' && env.ALLOW_PREVIEW_DATABASE !== 'true';
const sharedOk = (v) => (isolatedPreview ? '' : v);
const vercelUrl = env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL
  ? env.VERCEL_PROJECT_PRODUCTION_URL : env.VERCEL_URL;

const config = {
  root,
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || (vercelUrl ? `https://${vercelUrl}` : `http://localhost:${env.PORT || 3000}`)).replace(/\/$/, ''),
  sessionSecret: env.SESSION_SECRET || 'dev-only-secret-change-me',
  // Postgres connection (Supabase: the pooled "Transaction" URL). The Supabase Vercel integration sets POSTGRES_URL.
  databaseUrl: sharedOk(env.DATABASE_URL || env.POSTGRES_URL || ''),
  // Without a URL, an in-process PGlite database: on disk locally, in memory on Vercel previews.
  databasePath: env.DATABASE_PATH || (onVercel ? ':memory:' : path.join(root, 'data', 'pglite')),
  uploadDir: path.resolve(root, env.UPLOAD_DIR || (onVercel ? '/tmp/uploads' : 'uploads')),
  // Supabase Storage for venue photos (falls back to UPLOAD_DIR on local disk when unset).
  supabase: {
    url: sharedOk(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, ''),
    serviceKey: sharedOk(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || ''),
    bucket: env.SUPABASE_BUCKET || 'venue-photos',
  },
  // Demo mode seeds sample data into an empty database on start. On by default only for Vercel
  // deployments without a real database (previews).
  demoMode: isolatedPreview || env.DEMO_MODE === 'true' || (onVercel && !(env.DATABASE_URL || env.POSTGRES_URL) && env.DEMO_MODE !== 'false'),
  onVercel,
  currency: (env.CURRENCY || 'INR').toUpperCase(),
  platformFeePercent: Number(env.PLATFORM_FEE_PERCENT ?? 5),
  holdMinutes: Number(env.BOOKING_HOLD_MINUTES || 30),
  defaultCountryCode: String(env.DEFAULT_COUNTRY_CODE || '91'),
  cashfree: {
    appId: env.CASHFREE_APP_ID || '',
    secretKey: env.CASHFREE_SECRET_KEY || '',
    env: env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
    apiVersion: env.CASHFREE_API_VERSION || '2023-08-01',
  },
  // Google sign-in (OAuth 2.0 / OpenID Connect). Register `${baseUrl}/auth/google/callback` as a redirect URI.
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
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
    // 'openwa' (self-hosted gateway, default) or 'meta' (official WhatsApp Cloud API).
    provider: env.WHATSAPP_PROVIDER === 'meta' ? 'meta' : 'openwa',
    openwa: {
      url: env.OPENWA_URL || '',
      apiKey: env.OPENWA_API_KEY || '',
      sessionId: env.OPENWA_SESSION_ID || '',
      minIntervalMs: Number(env.OPENWA_MIN_INTERVAL_MS ?? 1500),
    },
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    templateName: env.WHATSAPP_TEMPLATE_NAME || 'iftar_invite',
    cancelTemplateName: env.WHATSAPP_CANCEL_TEMPLATE_NAME || 'iftar_cancelled',
    templateLang: env.WHATSAPP_TEMPLATE_LANG || 'en',
    apiVersion: env.WHATSAPP_API_VERSION || 'v21.0',
  },
  isProduction: env.NODE_ENV === 'production',
};

if (config.isProduction && config.sessionSecret === 'dev-only-secret-change-me') {
  throw new Error('SESSION_SECRET must be set in production');
}

module.exports = config;
