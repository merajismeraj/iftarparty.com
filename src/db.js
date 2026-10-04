'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

/** Version 1 schema. Never edit – add a migration instead. */
const SCHEMA = `
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('host', 'restaurant')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE restaurants (
  id          INTEGER PRIMARY KEY,
  owner_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cuisine     TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  area        TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE venues (
  id            INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  min_pax       INTEGER NOT NULL CHECK (min_pax >= 1),
  max_pax       INTEGER NOT NULL CHECK (max_pax >= min_pax),
  hire_fee      INTEGER NOT NULL DEFAULT 0 CHECK (hire_fee >= 0),
  amenities     TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE venue_images (
  id         INTEGER PRIMARY KEY,
  venue_id   INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE menus (
  id               INTEGER PRIMARY KEY,
  restaurant_id    INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  items            TEXT NOT NULL DEFAULT '',
  diet             TEXT NOT NULL DEFAULT 'non-veg' CHECK (diet IN ('veg', 'non-veg', 'mixed')),
  price_per_person INTEGER NOT NULL CHECK (price_per_person > 0),
  min_pax          INTEGER NOT NULL DEFAULT 1 CHECK (min_pax >= 1),
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bookings (
  id                INTEGER PRIMARY KEY,
  venue_id          INTEGER NOT NULL REFERENCES venues(id),
  menu_id           INTEGER NOT NULL REFERENCES menus(id),
  host_id           INTEGER NOT NULL REFERENCES users(id),
  event_date        TEXT NOT NULL,
  arrival_time      TEXT NOT NULL DEFAULT '18:00',
  guest_count       INTEGER NOT NULL,
  title             TEXT NOT NULL,
  invite_message    TEXT NOT NULL DEFAULT '',
  price_per_person  INTEGER NOT NULL,
  food_total        INTEGER NOT NULL,
  hire_fee          INTEGER NOT NULL,
  platform_fee      INTEGER NOT NULL,
  total_amount      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending_payment'
                    CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'expired')),
  hold_expires_at   TEXT NOT NULL,
  payment_provider  TEXT,
  payment_ref       TEXT,
  paid_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A venue can only ever hold one confirmed Iftar per evening.
CREATE UNIQUE INDEX bookings_one_confirmed_per_night
  ON bookings (venue_id, event_date) WHERE status = 'confirmed';
CREATE INDEX bookings_host ON bookings (host_id);
CREATE INDEX bookings_venue_date ON bookings (venue_id, event_date);

CREATE TABLE guests (
  id              INTEGER PRIMARY KEY,
  booking_id      INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  rsvp_token      TEXT NOT NULL UNIQUE,
  rsvp_status     TEXT NOT NULL DEFAULT 'pending' CHECK (rsvp_status IN ('pending', 'yes', 'no', 'maybe')),
  party_size      INTEGER NOT NULL DEFAULT 1,
  note            TEXT NOT NULL DEFAULT '',
  email_status    TEXT NOT NULL DEFAULT 'not_sent',
  whatsapp_status TEXT NOT NULL DEFAULT 'not_sent',
  invited_at      TEXT,
  responded_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX guests_booking_email ON guests (booking_id, email COLLATE NOCASE) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX guests_booking_phone ON guests (booking_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE message_log (
  id         INTEGER PRIMARY KEY,
  guest_id   INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  channel    TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient  TEXT NOT NULL,
  status     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Ordered schema migrations. Index i upgrades user_version i+1 -> i+2 (the base SCHEMA is version 1).
 * Each runs in its own transaction with foreign keys off, per SQLite's table-rebuild procedure.
 */
const MIGRATIONS = [
  // v2: admin role + account suspension, restaurant approval & payout details,
  // payments ledger (Cashfree orders/refunds), payouts, settings and admin audit log.
  `
  CREATE TABLE users_new (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone         TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('host', 'restaurant', 'admin')),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO users_new (id, name, email, phone, password_hash, role, created_at)
    SELECT id, name, email, phone, password_hash, role, created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;

  ALTER TABLE restaurants ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'
    CHECK (status IN ('pending', 'approved', 'rejected', 'suspended'));
  ALTER TABLE restaurants ADD COLUMN status_note TEXT NOT NULL DEFAULT '';
  ALTER TABLE restaurants ADD COLUMN payout_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE restaurants ADD COLUMN payout_upi TEXT NOT NULL DEFAULT '';
  ALTER TABLE restaurants ADD COLUMN payout_account TEXT NOT NULL DEFAULT '';
  ALTER TABLE restaurants ADD COLUMN payout_ifsc TEXT NOT NULL DEFAULT '';

  ALTER TABLE bookings ADD COLUMN cancelled_at TEXT;
  ALTER TABLE bookings ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE bookings ADD COLUMN payout_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payout_status IN ('unpaid', 'paid'));
  ALTER TABLE bookings ADD COLUMN payout_ref TEXT;
  ALTER TABLE bookings ADD COLUMN payout_at TEXT;

  CREATE TABLE payments (
    id             INTEGER PRIMARY KEY,
    booking_id     INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    provider       TEXT NOT NULL,
    order_id       TEXT NOT NULL UNIQUE,
    amount         INTEGER NOT NULL,
    currency       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed')),
    provider_ref   TEXT,
    paid_at        TEXT,
    refund_id      TEXT,
    refund_amount  INTEGER NOT NULL DEFAULT 0,
    refund_status  TEXT NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none', 'pending', 'success', 'failed')),
    refund_reason  TEXT NOT NULL DEFAULT '',
    refunded_at    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX payments_booking ON payments (booking_id);
  -- Backfill ledger rows for bookings paid before the ledger existed.
  INSERT INTO payments (booking_id, provider, order_id, amount, currency, status, paid_at)
    SELECT id, COALESCE(payment_provider, 'legacy'), 'legacy-' || id || '-' || COALESCE(payment_ref, ''),
           total_amount, currency, 'paid', paid_at
    FROM bookings WHERE status = 'confirmed';

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE admin_actions (
    id          INTEGER PRIMARY KEY,
    admin_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER,
    detail      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX admin_actions_entity ON admin_actions (entity_type, entity_id);
  `,
  // v3: distinguish invitation vs cancellation notices in the delivery log.
  `
  ALTER TABLE message_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'invite' CHECK (kind IN ('invite', 'cancellation'));
  `,
  // v4: menu packages & add-ons, and admin-moderated verified reviews.
  `
  CREATE TABLE addons (
    id            INTEGER PRIMARY KEY,
    restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    category      TEXT NOT NULL DEFAULT 'food' CHECK (category IN ('food', 'decor', 'service', 'other')),
    pricing       TEXT NOT NULL CHECK (pricing IN ('per_guest', 'flat')),
    price         INTEGER NOT NULL CHECK (price > 0),
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX addons_restaurant ON addons (restaurant_id);

  -- Snapshot of what was bought, so later price edits never change a paid booking.
  CREATE TABLE booking_addons (
    id         INTEGER PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    addon_id   INTEGER REFERENCES addons(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    pricing    TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity   INTEGER NOT NULL,
    total      INTEGER NOT NULL
  );
  CREATE INDEX booking_addons_booking ON booking_addons (booking_id);
  ALTER TABLE bookings ADD COLUMN addons_total INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE reviews (
    id               INTEGER PRIMARY KEY,
    booking_id       INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    restaurant_id    INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    venue_id         INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    host_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating           INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    food_rating      INTEGER CHECK (food_rating BETWEEN 1 AND 5),
    service_rating   INTEGER CHECK (service_rating BETWEEN 1 AND 5),
    ambience_rating  INTEGER CHECK (ambience_rating BETWEEN 1 AND 5),
    title            TEXT NOT NULL DEFAULT '',
    body             TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    moderation_note  TEXT NOT NULL DEFAULT '',
    moderated_at     TEXT,
    reply            TEXT NOT NULL DEFAULT '',
    reply_status     TEXT NOT NULL DEFAULT 'none' CHECK (reply_status IN ('none', 'pending', 'approved', 'rejected')),
    reply_note       TEXT NOT NULL DEFAULT '',
    reply_at         TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX reviews_restaurant_status ON reviews (restaurant_id, status);
  CREATE INDEX reviews_status ON reviews (status);
  `,
];

function migrate(db) {
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) {
    // Databases created before versioning already hold the v1 tables.
    const legacy = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get();
    if (!legacy) db.exec(SCHEMA);
    db.exec('PRAGMA user_version = 1');
    version = 1;
  }
  for (let v = version; v <= MIGRATIONS.length; v++) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => {
        db.exec(MIGRATIONS[v - 1]);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`migration ${v + 1} broke foreign keys: ${JSON.stringify(broken[0])}`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

function open(file = config.databasePath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/** Run fn inside a transaction; rolls back on throw. fn must be synchronous. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { open, transaction };
