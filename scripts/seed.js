'use strict';
/* Seeds demo restaurants, halls, menus, a host and a confirmed party with guests. Safe to re-run (skips if data exists). */
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const db = require('../src/db').open();
const { transaction } = require('../src/db');
const { newToken } = require('../src/services/invites');
const { partyTitle, todayISO } = require('../src/services/bookings');
const pricing = require('../src/services/pricing');

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.log('Database already has data – skipping seed. Delete', config.databasePath, 'to reseed.');
  process.exit(0);
}

fs.mkdirSync(config.uploadDir, { recursive: true });
function placeholder(label, hue) {
  const file = `seed-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.svg`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,22%)"/><stop offset="1" stop-color="hsl(${hue + 30},55%,38%)"/></linearGradient></defs>
  <rect width="800" height="500" fill="url(#g)"/>
  ${Array.from({ length: 7 }, (_, i) => `<circle cx="${110 + i * 100}" cy="90" r="14" fill="#e9b949" opacity=".85"/><line x1="${110 + i * 100}" y1="0" x2="${110 + i * 100}" y2="76" stroke="#e9b949" stroke-width="2" opacity=".6"/>`).join('')}
  <rect x="80" y="300" width="640" height="110" rx="12" fill="#000" opacity=".18"/>
  <path d="M430 170a70 70 0 1 0 35 120 56 56 0 1 1-35-120z" fill="#e9b949"/>
  <text x="400" y="372" font-family="Georgia,serif" font-size="40" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  fs.writeFileSync(path.join(config.uploadDir, file), svg);
  return file;
}

const hash = bcrypt.hashSync('password123', 10);
const restaurants = [
  {
    owner: ['Sameer Patel', 'owner@zaffran.test', '+919811055555'], status: 'pending',
    r: { name: 'Zaffran Courtyard', cuisine: 'Mughlai, Kebabs', area: 'Koregaon Park', city: 'Pune', address: 'Lane 6', description: 'New listing awaiting approval.' },
    venues: [{ name: 'Courtyard Pavilion', min: 20, max: 80, fee: 500000, amen: 'Open air, Prayer area', desc: 'Lantern-lit courtyard.' }],
    menus: [{ name: 'Kebab Iftar', price: 90000, diet: 'non-veg', min: 20, items: 'Dates\nSeekh kebab\nChicken tikka\nBiryani\nKheer' }],
  },
  {
    owner: ['Imran Qureshi', 'owner@noor.test', '+919820011111'],
    r: { name: 'Noor Mahal Kitchen', cuisine: 'Mughlai, Awadhi', area: 'Bandra West', city: 'Mumbai', address: '14 Hill Road', description: 'Family-run Mughlai restaurant serving Lucknowi classics since 1986.' },
    venues: [
      { name: 'Shahi Darbar Hall', min: 30, max: 150, fee: 1500000, amen: 'Air-conditioned, Prayer area, Valet parking, Stage & mic', desc: 'Grand banquet hall with chandeliers and a separate prayer room for Maghrib.' },
      { name: 'Rooftop Mehfil', min: 15, max: 60, fee: 800000, amen: 'Open air, Sea view, Prayer mats', desc: 'Breezy rooftop terrace — watch the sunset before breaking your fast.' },
    ],
    menus: [
      { name: 'Classic Iftar Spread', price: 95000, diet: 'non-veg', min: 20, items: 'Dates & Rooh Afza\nFruit chaat\nChicken samosa\nMutton haleem\nChicken biryani\nPhirni' },
      { name: 'Royal Awadhi Feast', price: 165000, diet: 'non-veg', min: 30, items: 'Dates & fresh juices\nGalouti kebab\nNihari with sheermal\nMutton dum biryani\nShahi tukda\nKahwa' },
      { name: 'Vegetarian Iftar', price: 75000, diet: 'veg', min: 15, items: 'Dates & lemonade\nDahi vada\nPaneer tikka\nVeg biryani\nKheer' },
    ],
    dishes: {
      openers: [['Dates & Rooh Afza', 'veg'], ['Fruit chaat', 'veg'], ['Dahi phulki', 'veg']],
      starters: [['Chicken samosa', 'non-veg'], ['Veg samosa', 'veg'], ['Paneer tikka', 'veg'], ['Chicken 65', 'non-veg'], ['Seekh kebab', 'non-veg'], ['Galouti kebab', 'non-veg']],
      mains: [['Chicken haleem', 'non-veg'], ['Butter chicken', 'non-veg'], ['Dal makhani', 'veg'], ['Paneer lababdar', 'veg'], ['Mutton haleem', 'non-veg'], ['Nihari', 'non-veg']],
      rice: [['Chicken biryani', 'non-veg'], ['Veg biryani', 'veg'], ['Mutton dum biryani', 'non-veg']],
      breads: [['Khamiri roti', 'veg'], ['Rumali roti', 'veg'], ['Sheermal', 'veg']],
      desserts: [['Phirni', 'veg'], ['Kheer', 'veg'], ['Gulab jamun', 'veg'], ['Shahi tukda', 'veg']],
      beverages: [['Rose milk', 'veg'], ['Kahwa', 'veg']],
    },
    packages: [
      { name: 'Silver Iftar Package', price: 69900, min: 25, diet: 'mixed', description: 'Great value for large family gatherings.',
        rules: { openers: [2, 'Dates & Rooh Afza', 'Fruit chaat', 'Dahi phulki'], starters: [2, 'Chicken samosa', 'Veg samosa', 'Paneer tikka', 'Chicken 65'],
          mains: [1, 'Chicken haleem', 'Butter chicken', 'Dal makhani', 'Paneer lababdar'], rice: [1, 'Chicken biryani', 'Veg biryani'],
          breads: [1, 'Khamiri roti', 'Rumali roti'], desserts: [1, 'Phirni', 'Kheer', 'Gulab jamun'] } },
      { name: 'Gold Iftar Package', price: 99900, min: 25, diet: 'mixed', description: 'Our most popular tier – adds mutton haleem and seekh kebab.',
        rules: { openers: [2, 'Dates & Rooh Afza', 'Fruit chaat', 'Dahi phulki'], starters: [3, 'Chicken samosa', 'Veg samosa', 'Paneer tikka', 'Chicken 65', 'Seekh kebab'],
          mains: [2, 'Chicken haleem', 'Butter chicken', 'Dal makhani', 'Paneer lababdar', 'Mutton haleem'], rice: [1, 'Chicken biryani', 'Veg biryani', 'Mutton dum biryani'],
          breads: [2, 'Khamiri roti', 'Rumali roti', 'Sheermal'], desserts: [2, 'Phirni', 'Kheer', 'Gulab jamun'], beverages: [1, 'Rose milk', 'Kahwa'] } },
      { name: 'Platinum Awadhi Package', price: 149900, min: 20, diet: 'mixed', description: 'The full Lucknowi spread with galouti, nihari and shahi tukda.',
        rules: { openers: [3, 'Dates & Rooh Afza', 'Fruit chaat', 'Dahi phulki'], starters: [4, 'Chicken samosa', 'Veg samosa', 'Paneer tikka', 'Chicken 65', 'Seekh kebab', 'Galouti kebab'],
          mains: [3, 'Chicken haleem', 'Butter chicken', 'Dal makhani', 'Paneer lababdar', 'Mutton haleem', 'Nihari'], rice: [2, 'Chicken biryani', 'Veg biryani', 'Mutton dum biryani'],
          breads: [2, 'Khamiri roti', 'Rumali roti', 'Sheermal'], desserts: [2, 'Phirni', 'Kheer', 'Gulab jamun', 'Shahi tukda'], beverages: [2, 'Rose milk', 'Kahwa'] } },
    ],
    addons: [
      { name: 'Live Kebab Grill', category: 'food', pricing: 'per_guest', price: 18000, description: 'Chef-manned grill with seekh, boti and malai tikka served hot.' },
      { name: 'Sheer Khurma & Dessert Counter', category: 'food', pricing: 'per_guest', price: 12000, description: 'Sheer khurma, phirni, kunafa and seasonal fruit.' },
      { name: 'Ramadan Décor Package', category: 'decor', pricing: 'flat', price: 850000, description: 'Lanterns, crescent backdrop, table runners and fairy lights.' },
      { name: 'Event Photography (3 hrs)', category: 'service', pricing: 'flat', price: 1200000, description: 'Professional photographer with 150+ edited photos in 48 hours.' },
    ],
  },
  {
    owner: ['Ayesha Fatima', 'owner@charminar.test', '+919849022222'],
    r: { name: 'Charminar Grand', cuisine: 'Hyderabadi', area: 'Banjara Hills', city: 'Hyderabad', address: 'Road No. 12', description: 'Authentic Hyderabadi haleem and dum biryani in an elegant setting.' },
    venues: [
      { name: 'Nizam Banquet', min: 50, max: 300, fee: 2500000, amen: 'Air-conditioned, Separate family seating, Prayer hall, Parking', desc: 'Our largest hall, ideal for community Iftars and corporate gatherings.' },
    ],
    menus: [
      { name: 'Hyderabadi Haleem Iftar', price: 120000, diet: 'non-veg', min: 50, items: 'Dates & sherbet\nPathar ka gosht\nHaleem\nKachi gosht biryani\nDouble ka meetha\nIrani chai' },
      { name: 'Mixed Buffet', price: 99000, diet: 'mixed', min: 50, items: 'Dates & fruit platter\nMirchi bajji\nChicken 65\nVeg & chicken biryani\nQubani ka meetha' },
    ],
    addons: [
      { name: 'Irani Chai & Osmania Station', category: 'food', pricing: 'per_guest', price: 6000, description: 'Unlimited Irani chai with Osmania biscuits after Maghrib.' },
      { name: 'Qawwali Performance', category: 'service', pricing: 'flat', price: 2500000, description: 'Live qawwali ensemble, 90 minutes, after Isha.' },
    ],
  },
  {
    owner: ['Yusuf Khan', 'owner@arabian.test', '+919880033333'],
    r: { name: 'Arabian Nights', cuisine: 'Arabic, Lebanese', area: 'Frazer Town', city: 'Bengaluru', address: 'Mosque Road', description: 'Mezze, mandi and grills with traditional floor seating.' },
    venues: [
      { name: 'Majlis Lounge', min: 10, max: 40, fee: 0, amen: 'Floor seating, Air-conditioned, Prayer mats', desc: 'Intimate majlis-style lounge with low seating and lanterns.' },
    ],
    menus: [
      { name: 'Mandi Iftar', price: 110000, diet: 'non-veg', min: 10, items: 'Ajwa dates & laban\nLentil soup\nHummus & mutabal\nChicken mandi\nKunafa' },
      { name: 'Mezze Feast', price: 85000, diet: 'mixed', min: 10, items: 'Dates & jallab\nFattoush\nFalafel & hummus\nShish taouk\nUmm ali' },
    ],
  },
];

transaction(db, () => {
  const insUser = db.prepare('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  const venueIds = [];
  restaurants.forEach((spec, ri) => {
    const ownerId = Number(insUser.run(...spec.owner.slice(0, 3), hash, 'restaurant').lastInsertRowid);
    const rid = Number(db.prepare(`INSERT INTO restaurants (owner_id, name, cuisine, area, city, address, description, phone, status, payout_name, payout_upi)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ownerId, spec.r.name, spec.r.cuisine, spec.r.area, spec.r.city, spec.r.address, spec.r.description, spec.owner[2],
        spec.status || 'approved', spec.status ? '' : spec.r.name, spec.status ? '' : `${spec.r.name.split(' ')[0].toLowerCase()}@okhdfc`).lastInsertRowid);
    spec.venues.forEach((v, vi) => {
      const vid = Number(db.prepare('INSERT INTO venues (restaurant_id, name, description, amenities, min_pax, max_pax, hire_fee) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(rid, v.name, v.desc, v.amen, v.min, v.max, v.fee).lastInsertRowid);
      venueIds.push({ vid, rid, v, pending: Boolean(spec.status) });
      ['', ' – Seating', ' – Décor'].forEach((suffix, i) => {
        db.prepare('INSERT INTO venue_images (venue_id, filename, sort_order) VALUES (?, ?, ?)').run(vid, placeholder(`${v.name}${suffix}`, 210 + ri * 40 + vi * 15 + i * 10), i);
      });
    });
    const dishIds = {};
    Object.entries(spec.dishes || {}).forEach(([course, list]) => list.forEach(([name, diet]) => {
      dishIds[name] = Number(db.prepare('INSERT INTO dishes (restaurant_id, name, course, diet) VALUES (?, ?, ?, ?)').run(rid, name, course, diet).lastInsertRowid);
    }));
    (spec.packages || []).forEach((pk) => {
      const mid = Number(db.prepare(`INSERT INTO menus (restaurant_id, kind, name, description, items, diet, price_per_person, min_pax) VALUES (?, 'package', ?, ?, '', ?, ?, ?)`)
        .run(rid, pk.name, pk.description, pk.diet, pk.price, pk.min).lastInsertRowid);
      Object.entries(pk.rules).forEach(([course, [choose, ...names]]) => {
        db.prepare('INSERT INTO menu_rules (menu_id, course, choose) VALUES (?, ?, ?)').run(mid, course, choose);
        names.forEach((n) => db.prepare('INSERT INTO menu_dishes (menu_id, dish_id) VALUES (?, ?)').run(mid, dishIds[n]));
      });
    });
    (spec.addons || []).forEach((a) => db.prepare('INSERT INTO addons (restaurant_id, name, description, category, pricing, price) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rid, a.name, a.description, a.category, a.pricing, a.price));
    spec.menus.forEach((m) => db.prepare('INSERT INTO menus (restaurant_id, name, items, diet, price_per_person, min_pax) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rid, m.name, m.items, m.diet, m.price, m.min));
  });

  insUser.run('Platform Admin', 'admin@demo.test', null, hash, 'admin');
  const hostId = Number(insUser.run('Meraj Ahmed', 'host@demo.test', '+919800044444', hash, 'host').lastInsertRowid);
  const live = venueIds.filter((x) => !x.pending);
  const { vid, rid } = live[0];
  const menu = db.prepare('SELECT * FROM menus WHERE restaurant_id = ? ORDER BY id LIMIT 1').get(rid);
  const venue = db.prepare('SELECT * FROM venues WHERE id = ?').get(vid);
  const d = new Date(); d.setDate(d.getDate() + 21);
  const date = d.toISOString().slice(0, 10) > todayISO() ? d.toISOString().slice(0, 10) : todayISO();
  const q = pricing.quote({ pricePerPerson: menu.price_per_person, guestCount: 60, hireFee: venue.hire_fee });
  const bid = Number(db.prepare(`INSERT INTO bookings (venue_id, menu_id, host_id, event_date, arrival_time, guest_count, title, invite_message,
      price_per_person, food_total, hire_fee, platform_fee, total_amount, currency, status, hold_expires_at, payment_provider, payment_ref, paid_at)
      VALUES (?, ?, ?, ?, '18:15', 60, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 'demo', 'demo_seed', datetime('now'))`)
    .run(vid, menu.id, hostId, date, partyTitle('Meraj Ahmed'), 'Join our family to break the fast together this Ramadan.',
      q.pricePerPerson, q.foodTotal, q.hireFee, q.platformFee, q.total, config.currency, new Date().toISOString()).lastInsertRowid);
  db.prepare(`INSERT INTO payments (booking_id, provider, order_id, amount, currency, status, paid_at) VALUES (?, 'demo', 'demo_seed', ?, ?, 'paid', datetime('now'))`)
    .run(bid, q.total, config.currency);

  // A completed Iftar from last week, so the payouts queue has something to settle.
  const past = new Date(); past.setDate(past.getDate() - 7);
  const v2 = db.prepare('SELECT * FROM venues WHERE id = ?').get(live[1].vid);
  const q2 = pricing.quote({ pricePerPerson: menu.price_per_person, guestCount: 25, hireFee: v2.hire_fee });
  const pastId = Number(db.prepare(`INSERT INTO bookings (venue_id, menu_id, host_id, event_date, guest_count, title, price_per_person, food_total, hire_fee,
      platform_fee, total_amount, currency, status, hold_expires_at, payment_provider, payment_ref, paid_at)
      VALUES (?, ?, ?, ?, 25, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 'demo', 'demo_seed_past', datetime('now', '-20 days'))`)
    .run(v2.id, menu.id, hostId, past.toISOString().slice(0, 10), partyTitle('Meraj Ahmed'), q2.pricePerPerson, q2.foodTotal, q2.hireFee,
      q2.platformFee, q2.total, config.currency, new Date().toISOString()).lastInsertRowid);
  db.prepare(`INSERT INTO payments (booking_id, provider, order_id, amount, currency, status, paid_at) VALUES (?, 'demo', 'demo_seed_past', ?, ?, 'paid', datetime('now', '-20 days'))`)
    .run(pastId, q2.total, config.currency);

  // Reviews: one published (with an approved restaurant reply), one waiting in the moderation queue.
  db.prepare(`INSERT INTO reviews (booking_id, restaurant_id, venue_id, host_id, rating, food_rating, service_rating, ambience_rating, title, body,
      status, moderated_at, reply, reply_status, reply_at) VALUES (?, ?, ?, ?, 5, 5, 4, 5, ?, ?, 'approved', datetime('now'), ?, 'approved', datetime('now'))`)
    .run(pastId, rid, v2.id, hostId, 'Sunset Iftar our guests still talk about',
      'The rooftop was ready well before Maghrib, dates and Rooh Afza were on every table, and the haleem was outstanding. Staff kept the prayer area clean and organised. Highly recommend for family gatherings.',
      'JazakAllah khair Meraj bhai – it was an honour to host your family. See you next Ramadan!');
  const host2 = Number(insUser.run('Sana Sheikh', 'sana@demo.test', '+919800066666', hash, 'host').lastInsertRowid);
  const arabian = venueIds.find((x) => x.v.name === 'Majlis Lounge');
  const amenu = db.prepare('SELECT * FROM menus WHERE restaurant_id = ? ORDER BY id LIMIT 1').get(arabian.rid);
  const past2 = new Date(); past2.setDate(past2.getDate() - 3);
  const q3 = pricing.quote({ pricePerPerson: amenu.price_per_person, guestCount: 18, hireFee: 0 });
  const past2Id = Number(db.prepare(`INSERT INTO bookings (venue_id, menu_id, host_id, event_date, guest_count, title, price_per_person, food_total, hire_fee,
      platform_fee, total_amount, currency, status, hold_expires_at, payment_provider, payment_ref, paid_at)
      VALUES (?, ?, ?, ?, 18, ?, ?, ?, 0, ?, ?, ?, 'confirmed', ?, 'demo', 'demo_seed_past2', datetime('now', '-10 days'))`)
    .run(arabian.vid, amenu.id, host2, past2.toISOString().slice(0, 10), partyTitle('Sana Sheikh'), q3.pricePerPerson, q3.foodTotal,
      q3.platformFee, q3.total, config.currency, new Date().toISOString()).lastInsertRowid);
  db.prepare(`INSERT INTO payments (booking_id, provider, order_id, amount, currency, status, paid_at) VALUES (?, 'demo', 'demo_seed_past2', ?, ?, 'paid', datetime('now', '-10 days'))`)
    .run(past2Id, q3.total, config.currency);
  db.prepare(`INSERT INTO reviews (booking_id, restaurant_id, venue_id, host_id, rating, food_rating, service_rating, title, body)
      VALUES (?, ?, ?, ?, 4, 5, 3, ?, ?)`)
    .run(past2Id, arabian.rid, arabian.vid, host2, 'Amazing mandi, service a bit slow',
      'The chicken mandi and kunafa were excellent and the majlis seating felt special. Service slowed down after Maghrib when everyone ate at once, but the staff were very polite.');

  const guests = [
    ['Aisha Khan', 'aisha@example.com', '+919876543210', 'yes', 3],
    ['Omar Siddiqui', null, '+919876501234', 'yes', 2],
    ['Fatima Rahman', 'fatima@example.com', null, 'maybe', 1],
    ['Bilal Shaikh', 'bilal@example.com', '+919812345678', 'no', 0],
    ['Zara Mirza', 'zara@example.com', '+919898989898', 'pending', 1],
  ];
  guests.forEach(([name, email, phone, status, size]) => db.prepare(`INSERT INTO guests (booking_id, name, email, phone, rsvp_token, rsvp_status, party_size, email_status, whatsapp_status, invited_at, responded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`)
    .run(bid, name, email, phone, newToken(), status, size, email ? 'logged' : 'not_sent', phone ? 'logged' : 'not_sent', status === 'pending' ? null : new Date().toISOString()));
});

console.log(`Seeded demo data.
  Admin login:       admin@demo.test / password123
  Host login:        host@demo.test, sana@demo.test / password123
  Restaurant logins: owner@noor.test, owner@charminar.test, owner@arabian.test, owner@zaffran.test (pending) / password123`);
