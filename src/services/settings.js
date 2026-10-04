'use strict';
const config = require('../config');

/** Admin-editable platform settings, falling back to env config. */
const DEFAULTS = {
  platform_fee_percent: () => String(config.platformFeePercent),
};

function get(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key]?.();
}

function set(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

const feePercent = (db) => Number(get(db, 'platform_fee_percent'));

module.exports = { get, set, feePercent };
