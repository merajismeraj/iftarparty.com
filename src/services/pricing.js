'use strict';
const config = require('../config');

/** Line total for one add-on: per-guest add-ons scale with headcount, flat ones are charged once. */
function addonLine(addon, guestCount) {
  const quantity = addon.pricing === 'per_guest' ? guestCount : 1;
  return { quantity, total: addon.price * quantity };
}

/**
 * Authoritative price for a booking. All amounts are integer minor units.
 * The same formula is mirrored client-side (public/js/app.js) for the live quote.
 * The platform fee applies to everything the restaurant supplies: food, hall and add-ons.
 */
function quote({ pricePerPerson, guestCount, hireFee, addons = [], feePercent = config.platformFeePercent }) {
  const foodTotal = pricePerPerson * guestCount;
  const addonsTotal = addons.reduce((sum, a) => sum + addonLine(a, guestCount).total, 0);
  const subtotal = foodTotal + hireFee + addonsTotal;
  const platformFee = Math.round((subtotal * feePercent) / 100);
  return { pricePerPerson, guestCount, foodTotal, hireFee, addonsTotal, platformFee, total: subtotal + platformFee, feePercent };
}

module.exports = { quote, addonLine };
