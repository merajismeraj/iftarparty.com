'use strict';
const config = require('./config');
const db = require('./db').open();
const { createApp } = require('./app');
const { expireStaleHolds } = require('./services/bookings');

const app = createApp(db);
setInterval(() => expireStaleHolds(db), 60_000).unref();

app.listen(config.port, () => {
  console.log(`IftarParty running at ${config.baseUrl}`);
  console.log(config.cashfree.appId ? `  payments: Cashfree (${config.cashfree.env})` : '  payments: DEMO mode (set CASHFREE_APP_ID + CASHFREE_SECRET_KEY for Cashfree)');
  if (!config.smtp.host) console.log('  email:    DEMO mode (set SMTP_HOST to send real email)');
  if (!config.whatsapp.token) console.log('  whatsapp: DEMO mode (set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID)');
});
