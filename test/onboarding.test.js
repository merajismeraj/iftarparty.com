'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, futureDate, seedMarketplace, request } = require('./helpers');

describe('onboarding planner', () => {
  const { db, app } = makeApp();
  let fx;
  before(() => { fx = seedMarketplace(db); });

  test('home asks guests and date first, then budget and location', async () => {
    const { text } = await request(app).get('/').expect(200);
    const step1 = text.slice(text.indexOf('data-step="1"'), text.indexOf('data-step="2"'));
    const step2 = text.slice(text.indexOf('data-step="2"'));
    assert.match(step1, /name="guests" required/);
    assert.match(step1, /name="date" required/);
    assert.doesNotMatch(step1, /name="budget"|name="location"/);
    assert.match(step2, /name="budget" value="900"/);
    assert.match(step2, /name="location"/);
    assert.doesNotMatch(text, /name="menu"/, 'dish search lives on the results page, not the first screen');
  });

  test('"Change" on results returns to a pre-filled planner', async () => {
    const date = futureDate(20);
    const res = await request(app).get(`/search?guests=40&date=${date}&budget=900&location=Bandra`).expect(200);
    assert.match(res.text, /40 guests · .+ · up to ₹900\/guest · Bandra/);
    const href = res.text.match(/href="(\/\?[^"]+)">Change</)[1].replace(/&amp;/g, '&');
    const home = await request(app).get(href).expect(200);
    assert.match(home.text, /name="guests"[^>]*value="40"/);
    assert.match(home.text, new RegExp(`name="date"[^>]*value="${date}"`));
    assert.match(home.text, /name="budget" value="900" checked/);
    assert.match(home.text, /name="location"[^>]*value="Bandra"/);
  });

  test('results carry guests, date and budget into the venue page', async () => {
    const date = futureDate(21);
    const res = await request(app).get(`/search?guests=40&date=${date}&budget=900`).expect(200);
    assert.match(res.text, new RegExp(`href="/venues/${fx.venueId}\\?date=${date}&amp;guests=40&amp;budget=900"`));
    const venue = await request(app).get(`/venues/${fx.venueId}?date=${date}&guests=40`).expect(200);
    assert.match(venue.text, /name="guests"[^>]*value="40"/);
    assert.match(venue.text, /type="hidden" name="arrival_time" value="18:00"/);
  });

  test('a search without guests or date nudges back to the planner', async () => {
    const res = await request(app).get('/search').expect(200);
    assert.match(res.text, /Add your guest count and date/);
  });
});
