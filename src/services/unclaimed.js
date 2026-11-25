'use strict';
/**
 * Restaurants added before onboarding (earlier imports from public data) are "unclaimed": hidden from
 * hosts and owned by a placeholder account that cannot sign in until the admin sets the real owner.
 */
const PLACEHOLDER_DOMAIN = 'unclaimed.iftarparty.invalid';
const isPlaceholderEmail = (email) => String(email || '').endsWith(`@${PLACEHOLDER_DOMAIN}`);

module.exports = { PLACEHOLDER_DOMAIN, isPlaceholderEmail };
