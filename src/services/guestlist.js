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

/**
 * Parse an invite list (CSV or pasted lines). Accepts an optional header row with
 * name / email / mobile in any order; without a header, columns are name, email, mobile.
 * Returns { guests: [{name,email,phone}], errors: [{line, reason}] }.
 */
function parseGuestList(text) {
  const input = String(text || '').replace(/^﻿/, '').trim();
  if (!input) return { guests: [], errors: [] };
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

  const guests = [];
  const errors = [];
  const seen = new Set();
  rows.forEach((row, i) => {
    const line = i + startLine;
    const rec = {};
    columns.forEach((field, idx) => { if (field && rec[field] === undefined) rec[field] = row[idx]; });
    const name = String(rec.name || '').trim().slice(0, 120);
    const email = rec.email ? normalizeEmail(rec.email) : null;
    const phone = rec.phone ? normalizePhone(rec.phone) : null;
    if (!name) return errors.push({ line, reason: 'Missing name' });
    if (rec.email && !email) return errors.push({ line, reason: `Invalid email "${rec.email}"` });
    if (rec.phone && !phone) return errors.push({ line, reason: `Invalid mobile number "${rec.phone}"` });
    if (!email && !phone) return errors.push({ line, reason: 'Needs an email or mobile number' });
    const key = email || phone;
    if (seen.has(key)) return errors.push({ line, reason: `Duplicate of an earlier row (${key})` });
    seen.add(key);
    guests.push({ name, email, phone });
  });
  return { guests, errors };
}

module.exports = { parseGuestList, normalizePhone, normalizeEmail };
