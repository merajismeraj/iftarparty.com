'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('host', 'restaurant')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS restaurants (
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

CREATE TABLE IF NOT EXISTS venues (
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

CREATE TABLE IF NOT EXISTS venue_images (
  id         INTEGER PRIMARY KEY,
  venue_id   INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menus (
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

CREATE TABLE IF NOT EXISTS bookings (
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
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_night
  ON bookings (venue_id, event_date) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS bookings_host ON bookings (host_id);
CREATE INDEX IF NOT EXISTS bookings_venue_date ON bookings (venue_id, event_date);

CREATE TABLE IF NOT EXISTS guests (
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
CREATE UNIQUE INDEX IF NOT EXISTS guests_booking_email ON guests (booking_id, email COLLATE NOCASE) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS guests_booking_phone ON guests (booking_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_log (
  id         INTEGER PRIMARY KEY,
  guest_id   INTEGER REFERENCES guests(id) ON DELETE SET NULL,
  channel    TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient  TEXT NOT NULL,
  status     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function open(file = config.databasePath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
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
