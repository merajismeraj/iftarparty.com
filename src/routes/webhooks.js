'use strict';
const express = require('express');
const payments = require('../services/payments');
const checkout = require('../services/checkout');

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

  return router;
};
