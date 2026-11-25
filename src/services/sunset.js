'use strict';
/**
 * Sunset (Maghrib) for a city and date, using the standard almanac sunrise/sunset equation
 * (accurate to about a minute at these latitudes). Times are local minutes after midnight.
 * Cities default to Indian Standard Time; unknown cities fall back to DEFAULT_CITY's coordinates.
 */
const CITIES = {
  hyderabad: [17.385, 78.4867], secunderabad: [17.4399, 78.4983], mumbai: [19.076, 72.8777], bombay: [19.076, 72.8777],
  bengaluru: [12.9716, 77.5946], bangalore: [12.9716, 77.5946], delhi: [28.6139, 77.209], 'new delhi': [28.6139, 77.209],
  chennai: [13.0827, 80.2707], kolkata: [22.5726, 88.3639], pune: [18.5204, 73.8567], lucknow: [26.8467, 80.9462],
  ahmedabad: [23.0225, 72.5714], jaipur: [26.9124, 75.7873], bhopal: [23.2599, 77.4126], aurangabad: [19.8762, 75.3433],
  kochi: [9.9312, 76.2673], kozhikode: [11.2588, 75.7804], mysuru: [12.2958, 76.6394], mysore: [12.2958, 76.6394],
  srinagar: [34.0837, 74.7973], nagpur: [21.1458, 79.0882], surat: [21.1702, 72.8311], patna: [25.5941, 85.1376],
  visakhapatnam: [17.6868, 83.2185], vijayawada: [16.5062, 80.648], warangal: [17.9689, 79.5941],
};
const IST = 330;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const mod = (a, n) => ((a % n) + n) % n;

function coordsFor(city) {
  const key = String(city || '').trim().toLowerCase();
  return CITIES[key] || CITIES[String(process.env.DEFAULT_CITY || 'hyderabad').toLowerCase()] || CITIES.hyderabad;
}

/** Sunset in local minutes after midnight for an ISO date (YYYY-MM-DD) at lat/lon, UTC offset in minutes. */
function sunsetMinutes(dateISO, lat, lon, tzMinutes = IST) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  const N = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
  const lngHour = lon / 15;
  const t = N + (18 - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  const L = mod(M + 1.916 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 282.634, 360);
  let RA = mod(deg(Math.atan(0.91764 * Math.tan(rad(L)))), 360);
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(rad(L));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(rad(90.833)) - sinDec * Math.sin(rad(lat))) / (cosDec * Math.cos(rad(lat)));
  const H = deg(Math.acos(Math.min(1, Math.max(-1, cosH)))) / 15;
  const T = H + RA - 0.06571 * t - 6.622;
  const UT = mod(T - lngHour, 24);
  return Math.round(mod(UT * 60 + tzMinutes, 1440));
}

/** Maghrib (sunset) for a venue's city on a date, in local minutes after midnight. */
function maghrib(dateISO, city) {
  const [lat, lon] = coordsFor(city);
  return sunsetMinutes(dateISO, lat, lon, IST);
}

module.exports = { sunsetMinutes, maghrib, coordsFor, CITIES };
