'use strict';
const config = require('../config');

/** Admin-editable platform settings, falling back to env config. */
const DEFAULTS = {
  platform_fee_percent: () => String(config.platformFeePercent),
  min_package_dishes: () => '4',
};

async function get(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key]?.();
}

async function set(db, key, value) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

const feePercent = async (db) => Number(await get(db, 'platform_fee_percent'));
/** Fewest dishes a host may pick in a package, across all courses. */
const minPackageDishes = async (db) => Number(await get(db, 'min_package_dishes'));

module.exports = { get, set, feePercent, minPackageDishes };
