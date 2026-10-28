'use strict';
/**
 * Add a city's restaurants from OpenStreetMap (© OpenStreetMap contributors, ODbL).
 *
 * Only public facts are imported: name, cuisine, address, area, phone, website. OSM has no capacity,
 * menus, prices or photos, so none are invented. Each restaurant starts "unclaimed" (hidden from hosts,
 * not in the review queue) under a placeholder owner that cannot sign in; the admin sets the real
 * owner when onboarding. Re-running is safe: known places are refreshed while still unclaimed.
 */
const { transaction } = require('../db');
const { normalizePhone } = require('./guestlist');

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// [south, west, north, east] covering the metro area (city + suburbs).
const CITIES = {
  Hyderabad: [17.20, 78.20, 17.60, 78.70],
};
const CHUNK = 100;
// OSM "suburb"/"district" tags often hold the city, district or state; those aren't localities.
const NOT_A_LOCALITY = /^(hyderabad|telang?ana|telagana|ranga ?reddy|medchal[- ]?malk?a?j?giri|sangareddy|india|ghmc)$/i;
const PLACEHOLDER_DOMAIN = 'unclaimed.iftarparty.invalid';

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const first = (v) => String(v ?? '').split(';')[0].trim();
const titleCase = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function overpassQuery([s, w, n, e]) {
  return `[out:json][timeout:40];nwr["amenity"="restaurant"]["name"](${s},${w},${n},${e});out center tags;`;
}

/** Fetch raw Overpass JSON for a preset city. */
async function fetchCity(city) {
  const bbox = CITIES[city];
  if (!bbox) throw new Error(`Unknown city: ${city}`);
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'IftarParty.com restaurant import' },
    body: new URLSearchParams({ data: overpassQuery(bbox) }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`OpenStreetMap (Overpass) answered HTTP ${res.status}. Try again in a minute, or upload an export.`);
  return res.json();
}

/** Overpass JSON → restaurant records (deduplicated by name + area). */
function toRestaurants(json, city) {
  if (!json || !Array.isArray(json.elements)) throw new Error('Not an Overpass JSON export (no "elements" list).');
  const seen = new Set();
  const out = [];
  for (const el of json.elements) {
    const t = el.tags || {};
    if (t.amenity !== 'restaurant') continue;
    const name = text(t['name:en'] || t.name, 120);
    if (!name || !['node', 'way', 'relation'].includes(el.type)) continue;
    const area = [t['addr:suburb'], t['addr:neighbourhood'], t['addr:city_district'], t['addr:district']]
      .map((v) => text(v, 80)).find((v) => v && !NOT_A_LOCALITY.test(v) && v.toLowerCase() !== city.toLowerCase()) || '';
    const key = `${name.toLowerCase()}|${area.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const email = text(first(t['contact:email'] || t.email), 120);
    out.push({
      ref: `osm:${el.type}/${el.id}`,
      name,
      cuisine: text(String(t.cuisine || '').split(';').map((c) => titleCase(c.trim())).filter(Boolean).join(', '), 120),
      address: text([t['addr:housenumber'], t['addr:street'], t['addr:place']].filter(Boolean).join(', '), 300),
      area,
      city,
      phone: normalizePhone(first(t.phone || t['contact:phone'] || t['contact:mobile'])),
      website: text(first(t.website || t['contact:website'] || t.url), 300),
      description: text(t.description, 1000),
      note: `Imported from OpenStreetMap (${el.type}/${el.id})${email ? ` · listed email ${email}` : ''}. Set the owner to onboard.`,
    });
  }
  return out;
}

/** Insert new places and refresh still-unclaimed ones. Returns { added, refreshed, skipped }. */
async function importRestaurants(db, places) {
  const result = { added: 0, refreshed: 0, skipped: 0 };
  const existingRefs = new Map((await db.prepare(
    'SELECT id, source_ref, status FROM restaurants WHERE source_ref IS NOT NULL'
  ).all()).map((r) => [r.source_ref, r]));
  const onboarded = new Set((await db.prepare(
    'SELECT lower(name) || \'|\' || lower(city) AS k FROM restaurants WHERE source_ref IS NULL'
  ).all()).map((r) => r.k));

  const fresh = [];
  for (const p of places) {
    const known = existingRefs.get(p.ref);
    if (known) {
      if (known.status !== 'unclaimed') { result.skipped++; continue; }
      await db.prepare('UPDATE restaurants SET name = ?, cuisine = ?, address = ?, area = ?, phone = ?, website = ?, description = ? WHERE id = ?')
        .run(p.name, p.cuisine, p.address, p.area, p.phone || '', p.website, p.description, known.id);
      result.refreshed++;
    } else if (onboarded.has(`${p.name.toLowerCase()}|${p.city.toLowerCase()}`)) {
      result.skipped++; // already on the platform under its real owner
    } else {
      fresh.push(p);
    }
  }

  for (let i = 0; i < fresh.length; i += CHUNK) {
    const batch = fresh.slice(i, i + CHUNK);
    await transaction(db, async () => {
      const emailOf = (p) => `${p.ref.replace(/[^a-z0-9]+/gi, '-')}@${PLACEHOLDER_DOMAIN}`.toLowerCase();
      const users = await db.prepare(
        `INSERT INTO users (name, email, phone, password_hash, role) VALUES ${batch.map(() => "(?, ?, ?, '', 'restaurant')").join(', ')} RETURNING id, email`
      ).all(...batch.flatMap((p) => [p.name, emailOf(p), p.phone]));
      const idByEmail = new Map(users.map((u) => [u.email, u.id]));
      await db.prepare(
        `INSERT INTO restaurants (owner_id, name, cuisine, address, area, city, phone, website, description, status, status_note, source_ref)
         VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclaimed', ?, ?)").join(', ')}`
      ).run(...batch.flatMap((p) => [idByEmail.get(emailOf(p)), p.name, p.cuisine, p.address, p.area, p.city, p.phone || '', p.website, p.description, p.note, p.ref]));
    });
    result.added += batch.length;
  }
  return result;
}

const isPlaceholderEmail = (email) => String(email || '').endsWith(`@${PLACEHOLDER_DOMAIN}`);

module.exports = { fetchCity, toRestaurants, importRestaurants, overpassQuery, isPlaceholderEmail, CITIES, PLACEHOLDER_DOMAIN };
