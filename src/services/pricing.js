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

/**
 * Interpret a host's budget. type 'guest' compares the per-guest menu price; type 'total'
 * compares the full estimate (food + hall + platform fee, before optional extras) and needs a guest count.
 * Returns null when no usable budget was given.
 */
function parseBudget(query, toMinor) {
  const raw = query.budget ?? query.max_price; // max_price kept for old links
  const amount = toMinor(raw);
  if (!raw || !(amount > 0)) return null;
  const type = query.budget_type === 'total' && query.budget !== undefined ? 'total' : 'guest';
  return { amount, type };
}

/** Does a menu at this venue fit the budget? Returns { fits, estimate, over }. */
function budgetFit(budget, { pricePerPerson, guestCount, hireFee, feePercent }) {
  if (!budget) return null;
  if (budget.type === 'guest') {
    return { fits: pricePerPerson <= budget.amount, estimate: pricePerPerson, over: Math.max(0, pricePerPerson - budget.amount) };
  }
  if (!guestCount) return null;
  const q = quote({ pricePerPerson, guestCount, hireFee, feePercent });
  return { fits: q.total <= budget.amount, estimate: q.total, over: Math.max(0, q.total - budget.amount) };
}

module.exports = { quote, addonLine, parseBudget, budgetFit };
