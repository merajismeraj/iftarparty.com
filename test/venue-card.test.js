'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, seedMarketplace, request } = require('./helpers');
const ambience = require('../src/services/ambience');

describe('space-first venue cards', () => {
  const { db, app } = makeApp();
  let fx;
  let other;

  before(async () => {
    fx = await seedMarketplace(db);
    await db.prepare(`UPDATE venues SET name = 'Rooftop terrace', ambience = 'rooftop,open_air,prayer_area,family,parking' WHERE id = ?`).run(fx.venueId);
    await db.prepare(`UPDATE menus SET items = ? WHERE id = ?`).run('Dates & Rooh Afza\nFruit chaat\nChicken haleem\nMutton biryani\nPhirni', fx.menuId);
    for (const [i, f] of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'].entries()) {
      await db.prepare('INSERT INTO venue_images (venue_id, filename, sort_order) VALUES (?, ?, ?)').run(fx.venueId, f, i);
    }
    other = await seedMarketplace(db, { hostEmail: 'host2@fixture.test' });
    await db.prepare(`UPDATE restaurants SET name = 'Garden Grill' WHERE id = ?`).run(other.restaurantId);
    await db.prepare(`UPDATE venues SET name = 'Lawn', ambience = 'garden,open_air' WHERE id = ?`).run(other.venueId);
    // A package: dishes are ordered mains first, ahead of openers.
    await db.prepare(`UPDATE menus SET kind = 'package', items = '' WHERE id = ?`).run(other.menuId);
    const dish = async (name, course) => Number((await db.prepare('INSERT INTO dishes (restaurant_id, name, course) VALUES (?, ?, ?)').run(other.restaurantId, name, course)).lastInsertRowid);
    for (const id of [await dish('Dates', 'openers'), await dish('Kalmi kebab', 'starters'), await dish('Nihari', 'mains'), await dish('Double ka meetha', 'desserts')]) {
      await db.prepare('INSERT INTO menu_dishes (menu_id, dish_id) VALUES (?, ?)').run(other.menuId, id);
    }
  });

  test('ambience vocabulary accepts keys and labels and keeps a stable order', () => {
    assert.deepEqual(ambience.parse(['Prayer area', 'rooftop', 'nonsense', 'ROOFTOP']), ['rooftop', 'prayer_area']);
    assert.deepEqual(ambience.parse('Garden|Ladies\' area'), ['garden', 'ladies']);
    assert.deepEqual(ambience.labels('family,rooftop'), ['Rooftop', 'Family section']);
  });

  test('cards lead with the restaurant, then the space, ambience, signature dishes and price', async () => {
    const page = (await request(app).get('/search?guests=50').expect(200)).text;
    const card = page.slice(page.indexOf(`href="/venues/${fx.venueId}`), page.indexOf('</a>', page.indexOf(`href="/venues/${fx.venueId}`)));
    assert.match(card, /<h2 class="vcard-title">Fixture Kitchen<\/h2>\s*<p class="vcard-space">Rooftop terrace<\/p>/);
    // Three photos in the gallery, the rest counted on the last one.
    assert.equal((card.match(/<div class="vcard-ph/g) || []).length, 3);
    assert.match(card, /vcard-gal n3/);
    assert.match(card, /\+2 photos/);
    // Up to four ambience chips, in vocabulary order.
    assert.match(card, /<span>Rooftop<\/span><span>Open air<\/span><span>Family section<\/span><span>Prayer area<\/span><\/div>/);
    assert.doesNotMatch(card, /Parking/);
    // Set menu: openers move to the back, so the first three are the signature dishes.
    assert.match(card, /<span>Chicken haleem<\/span><span>Mutton biryani<\/span><span>Phirni<\/span><span class="muted">\+2<\/span>/);
    assert.match(card, /≈ ₹[\d,]+ for 50/);

    const pkg = page.slice(page.indexOf(`href="/venues/${other.venueId}`));
    assert.match(pkg, /<span>Nihari<\/span><span>Kalmi kebab<\/span><span>Double ka meetha<\/span><span class="muted">\+1<\/span>/);
  });

  test('space filter chips narrow results by ambience', async () => {
    let page = (await request(app).get('/search?vibe=garden').expect(200)).text;
    assert.match(page, /Garden Grill/);
    assert.doesNotMatch(page, /<h2 class="vcard-title">Fixture Kitchen/);
    assert.match(page, /class="chip on" href="[^"]*">Garden<\/a>/);
    page = (await request(app).get('/search?vibe=rooftop').expect(200)).text;
    assert.match(page, /<h2 class="vcard-title">Fixture Kitchen/);
    assert.doesNotMatch(page, /Garden Grill/);
    // Unknown values are ignored rather than matching nothing.
    page = (await request(app).get('/search?vibe=%25').expect(200)).text;
    assert.match(page, /Garden Grill/);
    assert.match(page, /Fixture Kitchen/);
  });

  test('the venue page shows the same ambience tags', async () => {
    const page = (await request(app).get(`/venues/${fx.venueId}`).expect(200)).text;
    assert.match(page, /venue-vibes"><span>Rooftop<\/span><span>Open air<\/span><span>Family section<\/span><span>Prayer area<\/span><span>Parking<\/span>/);
  });
});
