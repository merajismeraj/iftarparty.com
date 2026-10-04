'use strict';
const config = require('../config');

/**
 * Authoritative price for a booking. All amounts are integer minor units.
 * The same formula is mirrored client-side (public/js/app.js) for the live quote.
 */
function quote({ pricePerPerson, guestCount, hireFee, feePercent = config.platformFeePercent }) {
  const foodTotal = pricePerPerson * guestCount;
  const subtotal = foodTotal + hireFee;
  const platformFee = Math.round((subtotal * feePercent) / 100);
  return { pricePerPerson, guestCount, foodTotal, hireFee, platformFee, total: subtotal + platformFee, feePercent };
}

module.exports = { quote };
