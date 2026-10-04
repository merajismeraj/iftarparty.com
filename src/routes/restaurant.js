'use strict';
const express = require('express');
const money = require('../services/money');
const { requireAuth } = require('../middleware/auth');
const { images: imageUpload, removeUpload } = require('../middleware/uploads');
const { todayISO, rsvpSummary, bookingAddons } = require('../services/bookings');
const reviews = require('../services/reviews');

const DIETS = ['veg', 'non-veg', 'mixed'];
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const int = (v) => Number.parseInt(v, 10);

function venueFromBody(b) {
  const v = {
    name: str(b.name, 120), description: str(b.description), amenities: str(b.amenities, 500),
    min_pax: int(b.min_pax), max_pax: int(b.max_pax), hire_fee: b.hire_fee === '' || b.hire_fee == null ? 0 : money.toMinor(b.hire_fee),
  };
  const errors = [];
  if (!v.name) errors.push('Give the hall a name, e.g. “Noor Banquet Hall”.');
  if (!(v.min_pax >= 1)) errors.push('Minimum guests must be at least 1.');
  if (!(v.max_pax >= v.min_pax)) errors.push('Maximum guests must be at least the minimum.');
  if (!Number.isFinite(v.hire_fee)) errors.push('Hall hire fee must be a number (use 0 if included in the menu price).');
  return { v, errors };
}

const ADDON_CATEGORIES = ['food', 'decor', 'service', 'other'];

function addonFromBody(b) {
  const a = {
    name: str(b.name, 120), description: str(b.description, 500),
    category: ADDON_CATEGORIES.includes(b.category) ? b.category : 'other',
    pricing: b.pricing === 'flat' ? 'flat' : 'per_guest', price: money.toMinor(b.price),
  };
  const errors = [];
  if (!a.name) errors.push('Give the package a name, e.g. “Live Shawarma Counter”.');
  if (!(a.price > 0)) errors.push('Enter a price.');
  return { a, errors };
}

function menuFromBody(b) {
  const m = {
    name: str(b.name, 120), description: str(b.description, 1000), items: str(b.items, 4000),
    diet: DIETS.includes(b.diet) ? b.diet : 'non-veg', price_per_person: money.toMinor(b.price_per_person),
    min_pax: int(b.min_pax) || 1,
  };
  const errors = [];
  if (!m.name) errors.push('Give the menu a name, e.g. “Royal Iftar Platter”.');
  if (!(m.price_per_person > 0)) errors.push('Enter the price per person.');
  if (!m.items) errors.push('List the dishes included in this menu.');
  return { m, errors };
}

module.exports = (db) => {
  const router = express.Router();
  router.use(requireAuth('restaurant'));
  router.use((req, res, next) => {
    if (!req.restaurant) return res.status(500).render('error', { title: 'Profile missing', message: 'Your restaurant profile is missing. Please contact support.' });
    next();
  });

  const ownVenue = (req) => db.prepare('SELECT * FROM venues WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurant.id);
  const ownMenu = (req) => db.prepare('SELECT * FROM menus WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurant.id);
  const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That item doesn’t belong to your restaurant.' });

  router.get('/', (req, res) => {
    const rid = req.restaurant.id;
    const venues = db.prepare(
      `SELECT v.*, (SELECT filename FROM venue_images WHERE venue_id = v.id ORDER BY sort_order, id LIMIT 1) AS image,
              (SELECT COUNT(*) FROM bookings b WHERE b.venue_id = v.id AND b.status = 'confirmed' AND b.event_date >= ?) AS upcoming
       FROM venues v WHERE v.restaurant_id = ? ORDER BY v.active DESC, v.name`
    ).all(todayISO(), rid);
    const menus = db.prepare('SELECT * FROM menus WHERE restaurant_id = ? ORDER BY active DESC, price_per_person').all(rid);
    const addons = db.prepare('SELECT * FROM addons WHERE restaurant_id = ? ORDER BY active DESC, category, price').all(rid);
    const bookings = db.prepare(
      `SELECT b.*, v.name AS venue_name, m.name AS menu_name, u.name AS host_name, u.phone AS host_phone, u.email AS host_email
       FROM bookings b JOIN venues v ON v.id = b.venue_id JOIN menus m ON m.id = b.menu_id JOIN users u ON u.id = b.host_id
       WHERE v.restaurant_id = ? AND b.status = 'confirmed' AND b.event_date >= ?
       ORDER BY b.event_date LIMIT 50`
    ).all(rid, todayISO()).map((b) => ({ ...b, rsvp: rsvpSummary(db, b.id), addons: bookingAddons(db, b.id) }));
    const stats = db.prepare(
      `SELECT COUNT(*) AS bookings, COALESCE(SUM(b.total_amount - b.platform_fee), 0) AS revenue,
              COALESCE(SUM(CASE WHEN b.payout_status = 'paid' THEN b.total_amount - b.platform_fee END), 0) AS paid_out
       FROM bookings b JOIN venues v ON v.id = b.venue_id WHERE v.restaurant_id = ? AND b.status = 'confirmed'`
    ).get(rid);
    res.render('restaurant/dashboard', { title: 'Restaurant dashboard', venues, menus, addons, bookings, stats, rating: reviews.summary(db, rid) });
  });

  router.get('/profile', (req, res) => res.render('restaurant/profile', { title: 'Restaurant profile', form: req.restaurant, errors: [] }));
  router.post('/profile', (req, res) => {
    const b = req.body;
    const form = {
      name: str(b.name, 120), description: str(b.description), cuisine: str(b.cuisine, 200),
      address: str(b.address, 300), area: str(b.area, 120), city: str(b.city, 120), phone: str(b.phone, 30),
      payout_name: str(b.payout_name, 120), payout_upi: str(b.payout_upi, 120),
      payout_account: str(b.payout_account, 34).replace(/\s/g, ''), payout_ifsc: str(b.payout_ifsc, 11).toUpperCase(),
    };
    const errors = [];
    if (!form.name) errors.push('Restaurant name is required.');
    if (!form.city) errors.push('City is required so hosts can find you.');
    if (form.payout_upi && !/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(form.payout_upi)) errors.push('UPI ID looks invalid (e.g. noormahal@okhdfc).');
    if (form.payout_ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(form.payout_ifsc)) errors.push('IFSC code looks invalid (e.g. HDFC0001234).');
    if (form.payout_account && !/^\d{9,18}$/.test(form.payout_account)) errors.push('Bank account number should be 9–18 digits.');
    if (errors.length) return res.status(422).render('restaurant/profile', { title: 'Restaurant profile', form, errors });
    db.prepare(`UPDATE restaurants SET name=?, description=?, cuisine=?, address=?, area=?, city=?, phone=?,
                payout_name=?, payout_upi=?, payout_account=?, payout_ifsc=? WHERE id=?`)
      .run(form.name, form.description, form.cuisine, form.address, form.area, form.city, form.phone,
        form.payout_name, form.payout_upi, form.payout_account, form.payout_ifsc, req.restaurant.id);
    req.flash('success', 'Profile updated.');
    res.redirect('/restaurant');
  });

  // ---- Venues / halls ----
  router.get('/venues/new', (req, res) => res.render('restaurant/venue-form', { title: 'Add a party hall', venue: { min_pax: 20, max_pax: 100 }, images: [], errors: [] }));

  router.post('/venues', imageUpload.array('images', 8), (req, res) => {
    const { v, errors } = venueFromBody(req.body);
    if (!req.files?.length) errors.push('Add at least one photo of the hall (JPG, PNG or WebP, up to 5 MB each).');
    if (errors.length) {
      (req.files || []).forEach((f) => removeUpload(f.filename));
      return res.status(422).render('restaurant/venue-form', { title: 'Add a party hall', venue: { ...req.body, hire_fee: req.body.hire_fee }, images: [], errors, rawFee: true });
    }
    const id = Number(db.prepare(
      'INSERT INTO venues (restaurant_id, name, description, amenities, min_pax, max_pax, hire_fee) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.restaurant.id, v.name, v.description, v.amenities, v.min_pax, v.max_pax, v.hire_fee).lastInsertRowid);
    const ins = db.prepare('INSERT INTO venue_images (venue_id, filename, sort_order) VALUES (?, ?, ?)');
    req.files.forEach((f, i) => ins.run(id, f.filename, i));
    req.flash('success', `${v.name} is live. Hosts can now find and book it.`);
    res.redirect('/restaurant');
  });

  router.get('/venues/:id/edit', (req, res) => {
    const venue = ownVenue(req);
    if (!venue) return notFound(res);
    const images = db.prepare('SELECT * FROM venue_images WHERE venue_id = ? ORDER BY sort_order, id').all(venue.id);
    res.render('restaurant/venue-form', { title: `Edit ${venue.name}`, venue, images, errors: [] });
  });

  router.post('/venues/:id', imageUpload.array('images', 8), (req, res) => {
    const venue = ownVenue(req);
    if (!venue) {
      (req.files || []).forEach((f) => removeUpload(f.filename));
      return notFound(res);
    }
    const { v, errors } = venueFromBody(req.body);
    const images = db.prepare('SELECT * FROM venue_images WHERE venue_id = ? ORDER BY sort_order, id').all(venue.id);
    if (errors.length) {
      (req.files || []).forEach((f) => removeUpload(f.filename));
      return res.status(422).render('restaurant/venue-form', { title: `Edit ${venue.name}`, venue: { ...req.body, id: venue.id }, images, errors, rawFee: true });
    }
    db.prepare('UPDATE venues SET name=?, description=?, amenities=?, min_pax=?, max_pax=?, hire_fee=? WHERE id=?')
      .run(v.name, v.description, v.amenities, v.min_pax, v.max_pax, v.hire_fee, venue.id);
    const ins = db.prepare('INSERT INTO venue_images (venue_id, filename, sort_order) VALUES (?, ?, ?)');
    (req.files || []).forEach((f, i) => ins.run(venue.id, f.filename, images.length + i));
    req.flash('success', 'Hall updated.');
    res.redirect(`/restaurant/venues/${venue.id}/edit`);
  });

  router.post('/venues/:id/images/:imageId/delete', (req, res) => {
    const venue = ownVenue(req);
    if (!venue) return notFound(res);
    const count = db.prepare('SELECT COUNT(*) AS n FROM venue_images WHERE venue_id = ?').get(venue.id).n;
    const img = db.prepare('SELECT * FROM venue_images WHERE id = ? AND venue_id = ?').get(req.params.imageId, venue.id);
    if (img && count <= 1) req.flash('error', 'Keep at least one photo – upload a replacement first.');
    else if (img) {
      db.prepare('DELETE FROM venue_images WHERE id = ?').run(img.id);
      removeUpload(img.filename);
      req.flash('success', 'Photo removed.');
    }
    res.redirect(`/restaurant/venues/${venue.id}/edit`);
  });

  router.post('/venues/:id/toggle', (req, res) => {
    const venue = ownVenue(req);
    if (!venue) return notFound(res);
    db.prepare('UPDATE venues SET active = 1 - active WHERE id = ?').run(venue.id);
    req.flash('success', venue.active ? `${venue.name} is hidden from search. Existing bookings are unaffected.` : `${venue.name} is listed again.`);
    res.redirect('/restaurant');
  });

  // ---- Menus ----
  router.get('/menus/new', (req, res) => res.render('restaurant/menu-form', { title: 'Add an Iftar menu', menu: { diet: 'non-veg', min_pax: 1 }, errors: [] }));

  router.post('/menus', (req, res) => {
    const { m, errors } = menuFromBody(req.body);
    if (errors.length) return res.status(422).render('restaurant/menu-form', { title: 'Add an Iftar menu', menu: req.body, errors, rawPrice: true });
    db.prepare('INSERT INTO menus (restaurant_id, name, description, items, diet, price_per_person, min_pax) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.restaurant.id, m.name, m.description, m.items, m.diet, m.price_per_person, m.min_pax);
    req.flash('success', `Menu “${m.name}” added.`);
    res.redirect('/restaurant');
  });

  router.get('/menus/:id/edit', (req, res) => {
    const menu = ownMenu(req);
    if (!menu) return notFound(res);
    res.render('restaurant/menu-form', { title: `Edit ${menu.name}`, menu, errors: [] });
  });

  router.post('/menus/:id', (req, res) => {
    const menu = ownMenu(req);
    if (!menu) return notFound(res);
    const { m, errors } = menuFromBody(req.body);
    if (errors.length) return res.status(422).render('restaurant/menu-form', { title: `Edit ${menu.name}`, menu: { ...req.body, id: menu.id }, errors, rawPrice: true });
    // Existing bookings keep the price they were quoted (stored on the booking).
    db.prepare('UPDATE menus SET name=?, description=?, items=?, diet=?, price_per_person=?, min_pax=? WHERE id=?')
      .run(m.name, m.description, m.items, m.diet, m.price_per_person, m.min_pax, menu.id);
    req.flash('success', 'Menu updated. Existing bookings keep their original price.');
    res.redirect('/restaurant');
  });

  router.post('/menus/:id/toggle', (req, res) => {
    const menu = ownMenu(req);
    if (!menu) return notFound(res);
    db.prepare('UPDATE menus SET active = 1 - active WHERE id = ?').run(menu.id);
    req.flash('success', menu.active ? `“${menu.name}” is no longer offered.` : `“${menu.name}” is offered again.`);
    res.redirect('/restaurant');
  });

  // ---- Reviews (published only; replies are moderated) ----
  router.get('/reviews', (req, res) => {
    res.render('restaurant/reviews', {
      title: 'Reviews', summary: reviews.summary(db, req.restaurant.id), list: reviews.published(db, req.restaurant.id, 100),
      pending: db.prepare(`SELECT COUNT(*) n FROM reviews WHERE restaurant_id = ? AND status = 'pending'`).get(req.restaurant.id).n,
    });
  });

  router.post('/reviews/:id/reply', (req, res) => {
    try {
      reviews.submitReply(db, Number(req.params.id), req.restaurant.id, req.body.reply);
      req.flash('success', 'Reply submitted. It will appear under the review once approved.');
    } catch (err) {
      if (!(err instanceof reviews.ReviewError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(`/restaurant/reviews#review-${Number(req.params.id)}`);
  });

  // ---- Packages & add-ons ----
  const ownAddon = (req) => db.prepare('SELECT * FROM addons WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurant.id);
  const addonForm = (res, title, addon, errors, rawPrice = false, status = 200) =>
    res.status(status).render('restaurant/addon-form', { title, addon, errors, rawPrice, categories: ADDON_CATEGORIES });

  router.get('/addons/new', (req, res) => addonForm(res, 'Add a package', { pricing: 'per_guest', category: 'food' }, []));

  router.post('/addons', (req, res) => {
    const { a, errors } = addonFromBody(req.body);
    if (errors.length) return addonForm(res, 'Add a package', req.body, errors, true, 422);
    db.prepare('INSERT INTO addons (restaurant_id, name, description, category, pricing, price) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.restaurant.id, a.name, a.description, a.category, a.pricing, a.price);
    req.flash('success', `Package “${a.name}” added. Hosts can add it to any booking.`);
    res.redirect('/restaurant#addons');
  });

  router.get('/addons/:id/edit', (req, res) => {
    const addon = ownAddon(req);
    if (!addon) return notFound(res);
    addonForm(res, `Edit ${addon.name}`, addon, []);
  });

  router.post('/addons/:id', (req, res) => {
    const addon = ownAddon(req);
    if (!addon) return notFound(res);
    const { a, errors } = addonFromBody(req.body);
    if (errors.length) return addonForm(res, `Edit ${addon.name}`, { ...req.body, id: addon.id }, errors, true, 422);
    db.prepare('UPDATE addons SET name=?, description=?, category=?, pricing=?, price=? WHERE id=?')
      .run(a.name, a.description, a.category, a.pricing, a.price, addon.id);
    req.flash('success', 'Package updated. Existing bookings keep the price they paid.');
    res.redirect('/restaurant#addons');
  });

  router.post('/addons/:id/toggle', (req, res) => {
    const addon = ownAddon(req);
    if (!addon) return notFound(res);
    db.prepare('UPDATE addons SET active = 1 - active WHERE id = ?').run(addon.id);
    req.flash('success', addon.active ? `“${addon.name}” is no longer offered.` : `“${addon.name}” is offered again.`);
    res.redirect('/restaurant#addons');
  });

  return router;
};
