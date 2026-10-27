'use strict';
const config = require('./config');
const http = require('node:http');
const handler = require('./app');
const { whatsappEnabled } = require('./services/notify');

const server = http.createServer(handler).listen(config.port, () => {
  console.log(`IftarParty running at ${config.baseUrl}`);
  console.log(config.cashfree.appId ? `  payments: Cashfree (${config.cashfree.env})` : '  payments: DEMO mode (set CASHFREE_APP_ID + CASHFREE_SECRET_KEY for Cashfree)');
  if (!config.smtp.host) console.log('  email:    DEMO mode (set SMTP_HOST to send real email)');
  console.log(whatsappEnabled() ? '  whatsapp: Meta WhatsApp Cloud API' : '  whatsapp: DEMO mode (set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID)');
  if (config.demoMode) console.log('  data:     DEMO mode (sample data seeded into an empty database)');
});

// Platforms stop containers with SIGTERM: finish in-flight requests, then close SQLite cleanly (WAL checkpoint).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      handler.db.close().catch(() => {}).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
