'use strict';
const { parse } = require('csv-parse/sync');
const config = require('../config');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEADER_ALIASES = {
  name: ['name', 'full name', 'guest', 'guest name'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  phone: ['mobile', 'phone', 'mobile number', 'phone number', 'whatsapp', 'whatsapp number', 'cell', 'contact'],
};

/** Normalise a phone number to E.164 ("+919876543210"); null if it can't be a real number. */
function normalizePhone(raw, countryCode = config.defaultCountryCode) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const plus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!plus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0') && digits.length === 11) digits = countryCode + digits.slice(1);
    else if (digits.length === 10) digits = countryCode + digits;
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

function normalizeEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
}

function mapHeader(cell) {
  const key = String(cell || '').trim().toLowerCase();
  return Object.keys(HEADER_ALIASES).find((field) => HEADER_ALIASES[field].includes(key));
}

/** Validate parsed rows ({ name, email, phone, line }) into guests and per-line errors; de-duplicates. */
function validateRows(rows) {
  const guests = [];
  const errors = [];
  const seen = new Set();
  for (const rec of rows) {
    const { line } = rec;
    const name = String(rec.name || '').trim().slice(0, 120);
    const email = rec.email ? normalizeEmail(rec.email) : null;
    const phone = rec.phone ? normalizePhone(rec.phone) : null;
    if (!name) { errors.push({ line, reason: 'Missing name' }); continue; }
    if (rec.email && !email) { errors.push({ line, reason: `Invalid email "${rec.email}"` }); continue; }
    if (rec.phone && !phone) { errors.push({ line, reason: `Invalid mobile number "${rec.phone}"` }); continue; }
    if (!email && !phone) { errors.push({ line, reason: `${name} has no mobile number or email` }); continue; }
    const key = email || phone;
    if (seen.has(key)) { errors.push({ line, reason: `Duplicate of an earlier row (${key})` }); continue; }
    seen.add(key);
    guests.push({ name, email, phone });
  }
  return { guests, errors };
}

/** Decode a vCard value: quoted-printable (vCard 2.1 exports from Android) and backslash escapes. */
function vcardValue(raw, params) {
  let v = raw;
  if (/ENCODING=QUOTED-PRINTABLE/i.test(params)) {
    const bytes = [];
    for (let i = 0; i < v.length; i++) {
      if (v[i] === '=' && /^[0-9A-F]{2}$/i.test(v.slice(i + 1, i + 3))) { bytes.push(parseInt(v.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(...Buffer.from(v[i], 'utf8'));
    }
    v = Buffer.from(bytes).toString('utf8');
  }
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

/**
 * Parse contacts exported as vCard (.vcf) – iPhone (Contacts → list → Export) and Android
 * (Contacts → Export) both produce these. Prefers a mobile number when a contact has several.
 */
function parseVCards(text) {
  // Unfold continuation lines (RFC 6350: a line starting with a space or tab continues the previous one;
  // vCard 2.1 quoted-printable uses a trailing "=" as a soft line break).
  const lines = String(text).replace(/=\r?\n/g, '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const rows = [];
  let card = null;
  let index = 0;
  for (const line of lines) {
    if (/^BEGIN:VCARD/i.test(line)) { card = { tels: [], emails: [] }; index += 1; continue; }
    if (/^END:VCARD/i.test(line)) {
      if (card) {
        const mobile = card.tels.find((t) => /CELL|MOBILE|IPHONE/i.test(t.params)) || card.tels[0];
        const name = card.fn || [card.n?.[1], card.n?.[0]].filter(Boolean).join(' ') || card.org || '';
        rows.push({ line: index, name, phone: mobile?.value || null, email: card.emails[0] || null });
      }
      card = null;
      continue;
    }
    if (!card) continue;
    const m = line.match(/^(?:[\w-]+\.)?([A-Za-z-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const [, prop, params, raw] = m;
    const value = vcardValue(raw, params);
    const key = prop.toUpperCase();
    if (key === 'FN' && value) card.fn = value;
    else if (key === 'N') card.n = raw.split(';').map((part) => vcardValue(part, params));
    else if (key === 'ORG' && value) card.org = value.split(';')[0];
    else if (key === 'TEL' && value) card.tels.push({ value: value.replace(/^tel:/i, ''), params });
    else if (key === 'EMAIL' && value) card.emails.push(value);
  }
  return rows;
}

/**
 * Parse an invite list: a contacts file (vCard), or CSV / pasted lines. CSV accepts an optional
 * header row with name / email / mobile in any order; without a header, columns are name, email, mobile.
 * Returns { guests: [{name,email,phone}], errors: [{line, reason}] } – for vCards, `line` is the contact number.
 */
function parseGuestList(text) {
  const input = String(text || '').replace(/^﻿/, '').trim();
  if (!input) return { guests: [], errors: [] };
  if (/^BEGIN:VCARD/im.test(input)) return validateRows(parseVCards(input));
  const delimiter = !input.includes(',') && input.includes('\t') ? '\t' : ',';
  const rows = parse(input, { delimiter, relax_column_count: true, skip_empty_lines: true, trim: true });

  let columns = ['name', 'email', 'phone'];
  let startLine = 1;
  const headerMap = rows[0].map(mapHeader);
  if (headerMap.includes('name')) {
    columns = headerMap;
    rows.shift();
    startLine = 2;
  }
  return validateRows(rows.map((row, i) => {
    const rec = { line: i + startLine };
    columns.forEach((field, idx) => { if (field && rec[field] === undefined) rec[field] = row[idx]; });
    return rec;
  }));
}

module.exports = { parseGuestList, parseVCards, normalizePhone, normalizeEmail };
