'use strict';
const config = require('./config');
const db = require('./db').open();
const { createApp } = require('./app');
const { expireStaleHolds } = require('./services/bookings');

const app = createApp(db);
setInterval(() => expireStaleHolds(db), 60_000).unref();

app.listen(config.port, () => {
  console.log(`IftarParty running at ${config.baseUrl}`);
  if (!config.stripe.secretKey) console.log('  payments: DEMO mode (set STRIPE_SECRET_KEY for Stripe Checkout)');
  if (!config.smtp.host) console.log('  email:    DEMO mode (set SMTP_HOST to send real email)');
  if (!config.whatsapp.token) console.log('  whatsapp: DEMO mode (set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID)');
});
