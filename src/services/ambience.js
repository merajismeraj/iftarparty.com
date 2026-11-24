'use strict';
/**
 * Fixed vocabulary for a venue's space and ambience. Stored on venues.ambience as comma-separated keys,
 * so cards can show consistent chips and search can filter on them.
 */
const AMBIENCE = [
  ['rooftop', 'Rooftop'],
  ['private_hall', 'Private hall'],
  ['garden', 'Garden'],
  ['open_air', 'Open air'],
  ['ac', 'Air-conditioned'],
  ['family', 'Family section'],
  ['prayer_area', 'Prayer area'],
  ['ladies', 'Ladies’ area'],
  ['parking', 'Parking'],
  ['accessible', 'Wheelchair access'],
];
// The ones offered as quick filters on search.
const FILTERS = ['rooftop', 'private_hall', 'garden', 'prayer_area', 'family'];

const LABEL = new Map(AMBIENCE);
// Accept keys or labels in any case (forms send keys; CSV sheets may use labels).
const LOOKUP = new Map(AMBIENCE.flatMap(([k, l]) => [[k, k], [l.toLowerCase(), k], [l.toLowerCase().replace(/’/g, "'"), k]]));

/** Normalise form/CSV input (array, comma or | separated string) to known keys, in vocabulary order. */
function parse(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,|]/);
  const keys = new Set(raw.map((s) => LOOKUP.get(String(s).trim().toLowerCase())).filter(Boolean));
  return AMBIENCE.map(([k]) => k).filter((k) => keys.has(k));
}

const keys = (stored) => parse(stored);
const labels = (stored) => keys(stored).map((k) => LABEL.get(k));
const isFilter = (key) => FILTERS.includes(key);

module.exports = { AMBIENCE, FILTERS, LABEL, parse, keys, labels, isFilter };
