'use strict';
const config = require('./config');
const app = require('./app');
const { whatsappProvider } = require('./services/notify');

app.listen(config.port, () => {
  console.log(`IftarParty running at ${config.baseUrl}`);
  console.log(config.cashfree.appId ? `  payments: Cashfree (${config.cashfree.env})` : '  payments: DEMO mode (set CASHFREE_APP_ID + CASHFREE_SECRET_KEY for Cashfree)');
  if (!config.smtp.host) console.log('  email:    DEMO mode (set SMTP_HOST to send real email)');
  const wa = whatsappProvider();
  console.log(wa === 'demo' ? '  whatsapp: DEMO mode (set OPENWA_URL + OPENWA_API_KEY + OPENWA_SESSION_ID)' : `  whatsapp: ${wa === 'openwa' ? 'OpenWA gateway' : 'Meta Cloud API'}`);
  if (config.demoMode) console.log('  data:     DEMO mode (sample data seeded into an empty database)');
});
