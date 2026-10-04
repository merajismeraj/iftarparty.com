'use strict';
const express = require('express');
const payments = require('../services/payments');
const { confirmPayment } = require('../services/bookings');

module.exports = (db) => {
  const router = express.Router();

  // Stripe → checkout.session.completed confirms the booking even if the host closes the tab.
  router.post('/stripe', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    let event;
    try {
      event = payments.parseWebhook(req.body, req.get('stripe-signature'));
    } catch (err) {
      return res.status(400).send(`Webhook error: ${err.message}`);
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      const bookingId = Number(session.metadata?.booking_id);
      if (bookingId && session.payment_status === 'paid') {
        confirmPayment(db, bookingId, { provider: 'stripe', ref: String(session.payment_intent || session.id) });
      }
    }
    res.json({ received: true });
  });

  return router;
};
