'use strict';
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, csrf, futureDate, signupRestaurant, signupHost, PNG, request } = require('./helpers');

describe('end-to-end: list → search → reserve → pay → invite → RSVP', () => {
  const { db, app } = makeApp();
  let restaurant, host, venueId, menuId, bookingId;
  const date = futureDate(30);

  before(async () => {
    restaurant = await signupRestaurant(app);
    host = await signupHost(app);
  });

  test('restaurant adds a hall with photos and a menu', async () => {
    let token = await csrf(restaurant, '/restaurant/venues/new');
    await restaurant.post(`/restaurant/venues?_csrf=${token}`)
      .field('name', 'Shahi Darbar').field('min_pax', '20').field('max_pax', '100').field('hire_fee', '10000')
      .field('description', 'Grand hall').field('amenities', 'AC, Prayer area')
      .attach('images', PNG, { filename: 'hall.png', contentType: 'image/png' })
      .expect(302);
    venueId = db.prepare('SELECT id FROM venues').get().id;
    assert.equal(db.prepare('SELECT COUNT(*) n FROM venue_images WHERE venue_id = ?').get(venueId).n, 1);
    assert.equal(db.prepare('SELECT hire_fee FROM venues').get().hire_fee, 1000000);

    token = await csrf(restaurant, '/restaurant/menus/new');
    await restaurant.post('/restaurant/menus').type('form').send({
      _csrf: token, name: 'Classic Iftar', price_per_person: '950', min_pax: '20', diet: 'non-veg', items: 'Dates\nHaleem\nBiryani',
    }).expect(302);
    menuId = db.prepare('SELECT id FROM menus').get().id;
  });

  test('a hall without photos is rejected', async () => {
    const token = await csrf(restaurant, '/restaurant/venues/new');
    const res = await restaurant.post(`/restaurant/venues?_csrf=${token}`)
      .field('name', 'No Photo Hall').field('min_pax', '10').field('max_pax', '20').expect(422);
    assert.match(res.text, /at least one photo/);
  });

  test('search finds the hall by location, menu, price and capacity', async () => {
    const hit = (q) => request(app).get(`/search?${new URLSearchParams(q)}`).then((r) => r.text.includes('Shahi Darbar'));
    assert.ok(await hit({ location: 'bandra' }));
    assert.ok(await hit({ menu: 'haleem' }));
    assert.ok(await hit({ max_price: '1000' }));
    assert.ok(await hit({ guests: '50', date }));
    assert.ok(!(await hit({ location: 'delhi' })));
    assert.ok(!(await hit({ max_price: '500' })));
    assert.ok(!(await hit({ guests: '500' })));
  });

  test('restaurants cannot book; guests outside capacity are refused', async () => {
    let token = await csrf(restaurant, `/venues/${venueId}`);
    await restaurant.post(`/venues/${venueId}/reserve`).type('form').send({ _csrf: token, date, guests: 50, menu_id: menuId }).expect(403);
    token = await csrf(host, `/venues/${venueId}`);
    await host.post(`/venues/${venueId}/reserve`).type('form').send({ _csrf: token, date, guests: 500, menu_id: menuId }).expect(302);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bookings').get().n, 0);
  });

  test('host reserves: price is computed server-side and venue is held', async () => {
    const token = await csrf(host, `/venues/${venueId}`);
    const res = await host.post(`/venues/${venueId}/reserve`).type('form')
      .send({ _csrf: token, date, guests: 50, menu_id: menuId, arrival_time: '18:15' }).expect(302);
    bookingId = Number(res.headers.location.match(/\/bookings\/(\d+)\/checkout/)[1]);
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    assert.equal(b.status, 'pending_payment');
    assert.equal(b.food_total, 95000 * 50);
    assert.equal(b.hire_fee, 1000000);
    assert.equal(b.platform_fee, Math.round((95000 * 50 + 1000000) * 0.05));
    assert.equal(b.total_amount, b.food_total + b.hire_fee + b.platform_fee);
    assert.equal(b.title, 'Iftar Party by Meraj Ahmed');
  });

  test('a second host cannot grab the same night while it is held', async () => {
    const other = await signupHost(app, 'Sara Ali', 'sara@host.test');
    const token = await csrf(other, `/venues/${venueId}`);
    await other.post(`/venues/${venueId}/reserve`).type('form').send({ _csrf: token, date, guests: 40, menu_id: menuId }).expect(302);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM bookings WHERE venue_id = ? AND event_date = ?`).get(venueId, date).n, 1);
    // ...and cannot see the first host's booking
    await other.get(`/bookings/${bookingId}/checkout`).expect(404);
  });

  test('host pays and the venue shows "Iftar Party by <name>"', async () => {
    let token = await csrf(host, `/bookings/${bookingId}/checkout`);
    const pay = await host.post(`/bookings/${bookingId}/pay`).type('form').send({ _csrf: token }).expect(303);
    assert.equal(pay.headers.location, `/bookings/${bookingId}/demo-pay`);
    token = await csrf(host, pay.headers.location);
    const done = await host.post(`/bookings/${bookingId}/demo-pay`).type('form').send({ _csrf: token }).expect(302);
    assert.match(done.headers.location, new RegExp(`/bookings/${bookingId}\\?welcome=1`));
    assert.equal(db.prepare('SELECT status FROM bookings WHERE id = ?').get(bookingId).status, 'confirmed');

    const page = await request(app).get(`/venues/${venueId}`);
    assert.match(page.text, /Reserved · <strong>Iftar Party by Meraj Ahmed<\/strong>/);
    const avail = await request(app).get(`/api/venues/${venueId}/availability?date=${date}`);
    assert.deepEqual(avail.body, { date, available: false, label: 'Iftar Party by Meraj Ahmed' });
    const search = await request(app).get(`/search?date=${date}`);
    assert.ok(!search.text.includes('Shahi Darbar'), 'booked hall hidden from date search');
  });

  test('host uploads invite list (CSV) and invites go out on both channels', async () => {
    const token = await csrf(host, `/bookings/${bookingId}`);
    const csv = 'Name,Email,Mobile\nAisha Khan,aisha@example.com,98765 43210\nOmar,,+44 7700 900123\nBad Row,not-an-email,\nNo Contact,,\nAisha Dup,AISHA@example.com,\n';
    await host.post(`/bookings/${bookingId}/guests?_csrf=${token}`)
      .field('send_now', 'on')
      .attach('file', Buffer.from(csv), { filename: 'guests.csv', contentType: 'text/csv' })
      .expect(302);
    const guests = db.prepare('SELECT * FROM guests WHERE booking_id = ? ORDER BY id').all(bookingId);
    assert.deepEqual(guests.map((g) => [g.name, g.email, g.phone]), [
      ['Aisha Khan', 'aisha@example.com', '+919876543210'],
      ['Omar', null, '+447700900123'],
    ]);
    assert.ok(guests.every((g) => g.invited_at));
    assert.equal(guests[0].email_status, 'logged');
    assert.equal(guests[0].whatsapp_status, 'logged');
    assert.equal(guests[1].email_status, 'not_sent');
    const log = db.prepare('SELECT channel, COUNT(*) n FROM message_log GROUP BY channel ORDER BY channel').all();
    assert.deepEqual(log.map((r) => [r.channel, r.n]), [['email', 1], ['whatsapp', 2]]);
  });

  test('pasted list skips guests already invited', async () => {
    const token = await csrf(host, `/bookings/${bookingId}`);
    await host.post(`/bookings/${bookingId}/guests?_csrf=${token}`)
      .field('list', 'Aisha Again, aisha@example.com\nFatima, fatima@example.com, ')
      .expect(302);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM guests WHERE booking_id = ?').get(bookingId).n, 3);
    const fatima = db.prepare(`SELECT * FROM guests WHERE name = 'Fatima'`).get();
    assert.equal(fatima.invited_at, null, 'not sent without send_now');
  });

  test('guests RSVP via their personal link and the host sees the counts', async () => {
    const [aisha, omar, fatima] = db.prepare('SELECT * FROM guests WHERE booking_id = ? ORDER BY id').all(bookingId);
    const guestAgent = request.agent(app);
    const page = await guestAgent.get(`/rsvp/${aisha.rsvp_token}`).expect(200);
    assert.match(page.text, /Iftar Party by Meraj Ahmed/);
    assert.match(page.text, /Dear Aisha Khan/);
    let token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    await guestAgent.post(`/rsvp/${aisha.rsvp_token}`).type('form').send({ _csrf: token, status: 'yes', party_size: '4', note: 'Bringing kids' }).expect(303);

    const omarAgent = request.agent(app);
    token = await csrf(omarAgent, `/rsvp/${omar.rsvp_token}`);
    await omarAgent.post(`/rsvp/${omar.rsvp_token}`).type('form').send({ _csrf: token, status: 'no', party_size: '3' }).expect(303);

    const g = db.prepare('SELECT rsvp_status, party_size, note FROM guests WHERE id IN (?, ?) ORDER BY id').all(aisha.id, omar.id);
    assert.deepEqual(g.map((x) => ({ ...x })), [
      { rsvp_status: 'yes', party_size: 4, note: 'Bringing kids' },
      { rsvp_status: 'no', party_size: 0, note: '' },
    ]);

    const party = await host.get(`/bookings/${bookingId}`).expect(200);
    const stat = (label) => Number(party.text.match(new RegExp(`stat-n">(\\d+)</span><span class="muted">${label}`))[1]);
    assert.equal(stat('Attending'), 1);
    assert.equal(stat('Total heads \\(incl\\. family\\)'), 4);
    assert.equal(stat('Declined'), 1);
    assert.equal(stat('Awaiting reply'), 1);

    const list = await host.get('/my-parties').expect(200);
    assert.match(list.text, /stat-n">4<\/span><span class="muted small">Total heads/);
    assert.ok(fatima);
  });

  test('restaurant dashboard shows the booking with RSVP heads', async () => {
    const res = await restaurant.get('/restaurant').expect(200);
    assert.match(res.text, /Iftar Party by Meraj Ahmed/);
    assert.match(res.text, /<td>1 \(4\)<\/td>/);
  });

  test('RSVP export neutralises spreadsheet formulas', async () => {
    db.prepare(`UPDATE guests SET note = '=HYPERLINK("x")' WHERE booking_id = ? AND rsvp_status = 'yes'`).run(bookingId);
    const res = await host.get(`/bookings/${bookingId}/guests.csv`).expect(200);
    assert.match(res.text, /"'=HYPERLINK\(""x""\)"/);
  });
});

describe('security & edge cases', () => {
  const { db, app } = makeApp();

  test('POST without CSRF token is rejected', async () => {
    await request(app).post('/login').type('form').send({ email: 'a@b.c', password: 'x' }).expect(403);
  });

  test('protected pages redirect to login', async () => {
    const res = await request(app).get('/my-parties').expect(302);
    assert.equal(res.headers.location, '/login');
    await request(app).get('/restaurant').expect(302);
  });

  test('a restaurant cannot edit another restaurant’s hall', async () => {
    const a = await signupRestaurant(app);
    const token = await csrf(a, '/restaurant/venues/new');
    await a.post(`/restaurant/venues?_csrf=${token}`).field('name', 'Hall A').field('min_pax', '1').field('max_pax', '10')
      .attach('images', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(302);
    const vid = db.prepare('SELECT id FROM venues').get().id;

    const b = request.agent(app);
    const t2 = await csrf(b, '/signup?role=restaurant');
    await b.post('/signup').type('form').send({ _csrf: t2, role: 'restaurant', name: 'Other', email: 'other@r.test', phone: '9000000000',
      password: 'password123', restaurant_name: 'Other', city: 'Pune' }).expect(302);
    await b.get(`/restaurant/venues/${vid}/edit`).expect(404);
    const t3 = await csrf(b, '/restaurant');
    await b.post(`/restaurant/venues/${vid}/toggle`).type('form').send({ _csrf: t3 }).expect(404);
    assert.equal(db.prepare('SELECT active FROM venues WHERE id = ?').get(vid).active, 1);
  });

  test('wrong password fails, right one signs in', async () => {
    await signupHost(app, 'Zed', 'zed@host.test');
    const agent = request.agent(app);
    let token = await csrf(agent);
    await agent.post('/login').type('form').send({ _csrf: token, email: 'zed@host.test', password: 'nope' }).expect(401);
    token = await csrf(agent);
    const ok = await agent.post('/login').type('form').send({ _csrf: token, email: 'ZED@host.test', password: 'password123' }).expect(302);
    assert.equal(ok.headers.location, '/my-parties');
  });

  test('unknown RSVP tokens 404', async () => {
    await request(app).get('/rsvp/doesnotexist123').expect(404);
  });
});
