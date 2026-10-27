'use strict';
const express = require('express');
const payments = require('../services/payments');
const checkout = require('../services/checkout');
const config = require('../config');
const notify = require('../services/notify');
const invites = require('../services/invites');

module.exports = (db) => {
  const router = express.Router();

  /**
   * Cashfree webhooks (configure <BASE_URL>/webhooks/cashfree in the Cashfree dashboard).
   * Confirms bookings even when the host closes the tab before returning, and tracks refunds.
   */
  router.post('/cashfree', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const ok = payments.verifyWebhook(req.body, req.get('x-webhook-timestamp'), req.get('x-webhook-signature'));
    if (!ok) return res.status(401).json({ error: 'invalid signature' });
    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid json' });
    }
    const { type, data = {} } = event;
    try {
      if (type === 'PAYMENT_SUCCESS_WEBHOOK' && data.order?.order_id) {
        // settleOrder re-fetches the order from Cashfree, so we never trust the payload's amount.
        await checkout.settleOrder(db, String(data.order.order_id));
      } else if (type === 'REFUND_STATUS_WEBHOOK' && data.refund?.refund_id) {
        await checkout.applyRefundWebhook(db, { orderId: String(data.refund.order_id), refundId: String(data.refund.refund_id), cfStatus: data.refund.refund_status });
      }
    } catch (err) {
      console.error(`[webhook] ${type} failed:`, err.message);
      return res.status(500).json({ error: 'processing failed' }); // Cashfree retries non-2xx
    }
    res.json({ received: true });
  });

  /**
   * WhatsApp Cloud API webhooks (Meta app → WhatsApp → Configuration → Callback URL
   * <BASE_URL>/webhooks/whatsapp, subscribe to "messages").
   * GET answers Meta's one-time verification; POST carries sent/delivered/read/failed statuses.
   */
  router.get('/whatsapp', (req, res) => {
    const token = config.whatsapp.verifyToken;
    if (req.query['hub.mode'] === 'subscribe' && token && req.query['hub.verify_token'] === token) {
      return res.type('text').send(String(req.query['hub.challenge'] ?? ''));
    }
    res.sendStatus(403);
  });

  router.post('/whatsapp', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    if (!notify.verifyWhatsAppSignature(req.body, req.get('x-hub-signature-256'))) return res.status(401).json({ error: 'invalid signature' });
    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid json' });
    }
    try {
      for (const entry of event.entry || []) {
        for (const change of entry.changes || []) {
          for (const st of change.value?.statuses || []) await invites.applyWhatsAppStatus(db, st);
        }
      }
    } catch (err) {
      console.error('[webhook] whatsapp failed:', err.message);
      return res.sendStatus(500); // Meta retries non-2xx
    }
    res.sendStatus(200);
  });

  return router;
};
