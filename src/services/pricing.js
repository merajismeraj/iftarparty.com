'use strict';
const config = require('../config');

/** Line total for one add-on: per-guest add-ons scale with headcount, flat ones are charged once. */
function addonLine(addon, guestCount) {
  const quantity = addon.pricing === 'per_guest' ? guestCount : 1;
  return { quantity, total: addon.price * quantity };
}

/** Extra time is sold in 30-minute blocks, up to 3 extra hours. */
const BLOCK_MINUTES = 30;
const MAX_EXTRA_BLOCKS = 6;

/**
 * Validate a requested duration against what's included and the venue's price per extra block.
 * Returns { minutes, blocks, total } or throws with a host-facing message.
 */
function extraTime({ durationMinutes, includedMinutes, feePerBlock }) {
  const minutes = durationMinutes == null || durationMinutes === '' ? includedMinutes : Number(durationMinutes);
  const extra = minutes - includedMinutes;
  if (!Number.isInteger(minutes) || extra < 0 || extra % BLOCK_MINUTES || extra / BLOCK_MINUTES > MAX_EXTRA_BLOCKS) {
    throw new RangeError(`Please choose a valid duration (from ${includedMinutes} minutes, in 30-minute steps).`);
  }
  const blocks = extra / BLOCK_MINUTES;
  if (blocks && !(feePerBlock > 0)) throw new RangeError('This venue does not offer extra time.');
  return { minutes, blocks, total: blocks * (feePerBlock || 0) };
}

/** Duration choices for a venue: the included time, then each extra block (if the venue sells extra time). */
function durationOptions({ includedMinutes, feePerBlock }) {
  const out = [{ minutes: includedMinutes, extra: 0 }];
  if (feePerBlock > 0) for (let b = 1; b <= MAX_EXTRA_BLOCKS; b++) out.push({ minutes: includedMinutes + b * BLOCK_MINUTES, extra: b * feePerBlock });
  return out;
}

/**
 * Authoritative price for a booking. All amounts are integer minor units.
 * The same formula is mirrored client-side (public/js/app.js) for the live quote.
 * The platform fee applies to everything the restaurant supplies: food, venue, extra time and add-ons.
 */
function quote({ pricePerPerson, guestCount, hireFee, addons = [], extraTimeTotal = 0, feePercent = config.platformFeePercent }) {
  const foodTotal = pricePerPerson * guestCount;
  const addonsTotal = addons.reduce((sum, a) => sum + addonLine(a, guestCount).total, 0);
  const subtotal = foodTotal + hireFee + addonsTotal + extraTimeTotal;
  const platformFee = Math.round((subtotal * feePercent) / 100);
  return { pricePerPerson, guestCount, foodTotal, hireFee, addonsTotal, extraTimeTotal, platformFee, total: subtotal + platformFee, feePercent };
}

/**
 * Interpret a host's budget. type 'guest' compares the per-guest menu price; type 'total'
 * compares the full estimate (food + venue + platform fee, before optional extras) and needs a guest count.
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

module.exports = { quote, addonLine, parseBudget, budgetFit, extraTime, durationOptions, BLOCK_MINUTES };
