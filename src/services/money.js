'use strict';
const config = require('../config');

/** Parse a user-entered major-unit amount ("1,250.50") into integer minor units. */
function toMinor(input) {
  const n = Number(String(input ?? '').replace(/[,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100);
}

function toMajor(minor) {
  return (Number(minor) || 0) / 100;
}

function format(minor, currency = config.currency) {
  const major = toMajor(minor);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: Number.isInteger(major) ? 0 : 2,
  }).format(major);
}

module.exports = { toMinor, toMajor, format };
