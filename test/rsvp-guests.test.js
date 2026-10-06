'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, futureDate, seedMarketplace, paidBooking, signin, request } = require('./helpers');
const invites = require('../src/services/invites');

describe('RSVP page: who is coming', () => {
  const { db, app } = makeApp();
  let bookingId;
  const tokens = {};
  const section = (html) => {
    const start = html.indexOf('class="coming"');
    return start < 0 ? '' : html.slice(start, html.indexOf('</section>', start));
  };

  before(async () => {
    const fx = await seedMarketplace(db);
    bookingId = await paidBooking(db, { ...fx, date: futureDate(12) });
    const add = async (name, email, phone, status, size) => {
      const t = invites.newToken();
      await db.prepare(`INSERT INTO guests (booking_id, name, email, phone, rsvp_token, rsvp_status, party_size, invited_at, responded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ts_now(), ts_now(?::interval))`).run(bookingId, name, email, phone, t, status, size, `-${Object.keys(tokens).length} minutes`);
      tokens[name] = t;
    };
    await add('Aisha Khan', 'aisha@g.test', '+919811111111', 'yes', 3);
    await add('Omar Siddiqui', null, '+919822222222', 'yes', 1);
    await add('Bilal Shaikh', 'bilal@g.test', null, 'no', 0);
    await add('Fatima Rahman', 'fatima@g.test', null, 'maybe', 1);
    await add('Zara Mirza', 'zara@g.test', null, 'pending', 1);
  });

  test('shows confirmed guests only, privacy-safe, with total heads', async () => {
    const page = await request(app).get(`/rsvp/${tokens['Zara Mirza']}`).expect(200);
    const s = section(page.text);
    assert.match(s, /Who’s coming <span class="muted">· 4 people/);
    assert.match(s, /Aisha K\.<\/span>|Aisha K\. <span class="muted">\+2/);
    assert.match(s, /Omar S\./);
    assert.doesNotMatch(s, /Bilal|Fatima|Zara/, 'declined, maybe and pending replies are not listed');
    assert.doesNotMatch(page.text, /aisha@g\.test|9811111111|Khan|Siddiqui/, 'no contact details or surnames leak');
    assert.match(s, /Join them – reply below/);
  });

  test('the viewer sees themselves as "You", listed first', async () => {
    const s = section((await request(app).get(`/rsvp/${tokens['Omar Siddiqui']}`)).text);
    assert.ok(s.indexOf('>You<') > -1);
    assert.ok(s.indexOf('>You<') < s.indexOf('Aisha K.'));
    assert.doesNotMatch(s, /Omar S\./);
  });

  test('confirming adds the guest to everyone’s list', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent, `/rsvp/${tokens['Zara Mirza']}`);
    await agent.post(`/rsvp/${tokens['Zara Mirza']}`).type('form').send({ _csrf: token, status: 'yes', party_size: '2' }).expect(303);
    const s = section((await request(app).get(`/rsvp/${tokens['Aisha Khan']}`)).text);
    assert.match(s, /Zara M\. <span class="muted">\+1/);
    assert.match(s, /· 6 people/);
  });

  test('the host can hide the list', async () => {
    const host = await signin(app, 'host@fixture.test');
    let token = await csrf(host, `/bookings/${bookingId}`);
    await host.post(`/bookings/${bookingId}/details`).type('form').send({ _csrf: token, arrival_time: '18:00', invite_message: '' }).expect(302);
    assert.equal((await db.prepare('SELECT show_guest_list FROM bookings WHERE id = ?').get(bookingId)).show_guest_list, 0);
    assert.equal(section((await request(app).get(`/rsvp/${tokens['Zara Mirza']}`)).text), '');
    token = await csrf(host, `/bookings/${bookingId}`);
    await host.post(`/bookings/${bookingId}/details`).type('form').send({ _csrf: token, arrival_time: '18:00', invite_message: '', show_guest_list: 'on' }).expect(302);
    assert.notEqual(section((await request(app).get(`/rsvp/${tokens['Zara Mirza']}`)).text), '');
  });

  test('cancelled parties do not show the list', async () => {
    await db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ts_now() WHERE id = ?`).run(bookingId);
    const page = await request(app).get(`/rsvp/${tokens['Aisha Khan']}`).expect(200);
    assert.equal(section(page.text), '');
    await db.prepare(`UPDATE bookings SET status = 'confirmed', cancelled_at = NULL WHERE id = ?`).run(bookingId);
  });
});
