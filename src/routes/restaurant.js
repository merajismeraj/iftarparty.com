'use strict';
const express = require('express');
const money = require('../services/money');
const { requireAuth } = require('../middleware/auth');
const { images: imageUpload } = require('../middleware/uploads');
const storage = require('../services/storage');
const { todayISO, rsvpSummary, bookingAddons } = require('../services/bookings');
const reviews = require('../services/reviews');
const packages = require('../services/packages');
const { transaction } = require('../db');
const audit = require('../services/audit');
const ambience = require('../services/ambience');
const sessions = require('../services/sessions');

const DIETS = ['veg', 'non-veg', 'mixed'];
const MIN_PHOTOS = 3;
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const int = (v) => Number.parseInt(v, 10);

function venueFromBody(b) {
  const v = {
    name: str(b.name, 120), description: str(b.description), amenities: str(b.amenities, 500),
    ambience: ambience.parse(b.ambience).join(','),
    min_pax: int(b.min_pax), max_pax: int(b.max_pax), hire_fee: b.hire_fee === '' || b.hire_fee == null ? 0 : money.toMinor(b.hire_fee),
    extra_time_fee: b.extra_time_fee === '' || b.extra_time_fee == null ? 0 : money.toMinor(b.extra_time_fee),
    dinner_start: b.dinner_start == null || b.dinner_start === '' ? '21:30' : str(b.dinner_start, 5),
    dinner_minutes: b.dinner_minutes == null || b.dinner_minutes === '' ? 120 : int(b.dinner_minutes),
    mosque_name: str(b.mosque_name, 120),
    mosque_walk_minutes: b.mosque_walk_minutes == null || b.mosque_walk_minutes === '' ? null : int(b.mosque_walk_minutes),
  };
  const errors = [];
  if (!v.name) errors.push('Give the venue a name, e.g. “Noor Rooftop Lounge”.');
  if (!v.ambience) errors.push('Tick at least one option under “The space” so hosts can find this venue by its ambience.');
  if (!(v.min_pax >= 1)) errors.push('Minimum guests must be at least 1.');
  if (!(v.max_pax >= v.min_pax)) errors.push('Maximum guests must be at least the minimum.');
  if (!Number.isFinite(v.hire_fee)) errors.push('Venue hire fee must be a number (use 0 if included in the menu price).');
  if (!Number.isFinite(v.extra_time_fee) || v.extra_time_fee < 0) errors.push('Extra time price must be a number (use 0 if you don’t offer extra time).');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.dinner_start)) errors.push('Dinner start must be a time, e.g. 21:30.');
  if (!(v.dinner_minutes >= 60 && v.dinner_minutes <= 360 && v.dinner_minutes % 30 === 0)) errors.push('Dinner length must be between 1 and 6 hours, in 30-minute steps.');
  if (v.mosque_walk_minutes !== null && !(v.mosque_walk_minutes >= 1 && v.mosque_walk_minutes <= 60)) errors.push('Walk to the mosque must be between 1 and 60 minutes (leave blank if unknown).');
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
  if (!a.name) errors.push('Give the extra a name, e.g. “Live Shawarma Counter”.');
  if (!(a.price > 0)) errors.push('Enter a price.');
  return { a, errors };
}

function menuFromBody(b) {
  const m = {
    kind: b.kind === 'package' ? 'package' : 'set',
    name: str(b.name, 120), description: str(b.description, 1000), items: str(b.items, 4000),
    diet: DIETS.includes(b.diet) ? b.diet : 'non-veg', price_per_person: money.toMinor(b.price_per_person),
    min_pax: int(b.min_pax) || 1, meal: sessions.normalizeMeal(b.meal),
  };
  const errors = [];
  if (!m.name) errors.push(m.kind === 'package' ? 'Give the package a name, e.g. “Gold Iftar Package”.' : 'Give the menu a name, e.g. “Royal Iftar Platter”.');
  if (!(m.price_per_person > 0)) errors.push('Enter the price per person.');
  if (m.kind === 'set' && !m.items) errors.push('List the dishes included in this menu.');
  if (m.kind === 'package') m.items = '';
  return { m, errors };
}

const DISH_DIETS = ['veg', 'non-veg'];
function dishFromBody(b) {
  const d = {
    name: str(b.name, 120), description: str(b.description, 300),
    course: packages.COURSE_KEYS.includes(b.course) ? b.course : null, diet: DISH_DIETS.includes(b.diet) ? b.diet : 'non-veg',
  };
  const errors = [];
  if (!d.name) errors.push('Enter the dish name.');
  if (!d.course) errors.push('Choose a course.');
  return { d, errors };
}

module.exports = (db) => {
  const router = express.Router();
  router.use(requireAuth('restaurant'));
  router.use((req, res, next) => {
    if (!req.restaurant) return res.status(500).render('error', { title: 'Profile missing', message: 'Your restaurant profile is missing. Please contact support.' });
    next();
  });
  // Every change an admin saves while managing a listing goes in the audit log.
  router.use((req, res, next) => {
    if (req.managing && req.method === 'POST') {
      res.on('finish', () => {
        if (res.statusCode < 400) {
          audit.log(db, req.user.id, 'restaurant.edit', 'restaurant', req.restaurant.id, `${req.method} ${req.path}`)
            .catch((err) => console.error('[audit] restaurant.edit', err.message));
        }
      });
    }
    next();
  });

  const ownVenue = async (req) => await db.prepare('SELECT * FROM venues WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurant.id);
  const ownMenu = async (req) => await db.prepare('SELECT * FROM menus WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurant.id);
  const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That item doesn’t belong to your restaurant.' });

  router.get('/', async (req, res) => {
    const rid = req.restaurant.id;
    const venues = await db.prepare(
      `SELECT v.*, (SELECT filename FROM venue_images WHERE venue_id = v.id ORDER BY sort_order, id LIMIT 1) AS image,
              (SELECT COUNT(*) FROM bookings b WHERE b.venue_id = v.id AND b.status = 'confirmed' AND b.event_date >= ?) AS upcoming
       FROM venues v WHERE v.restaurant_id = ? ORDER BY v.active DESC, v.name`
    ).all(todayISO(), rid);
    const menuRows = await db.prepare('SELECT * FROM menus WHERE restaurant_id = ? ORDER BY active DESC, price_per_person').all(rid);
    const menus = await Promise.all(menuRows.map(async (m) => (m.kind === 'package' ? { ...m, rules: await packages.summary(await packages.load(db, m.id)) } : m)));
    const addons = await db.prepare('SELECT * FROM addons WHERE restaurant_id = ? ORDER BY active DESC, category, price').all(rid);
    const bookingRows = (await db.prepare(
      `SELECT b.*, v.name AS venue_name, m.name AS menu_name, u.name AS host_name, u.phone AS host_phone, u.email AS host_email
       FROM bookings b JOIN venues v ON v.id = b.venue_id JOIN menus m ON m.id = b.menu_id JOIN users u ON u.id = b.host_id
       WHERE v.restaurant_id = ? AND b.status = 'confirmed' AND b.event_date >= ?
       ORDER BY b.event_date LIMIT 50`
    ).all(rid, todayISO()));
    const bookings = await Promise.all(bookingRows.map(async (b) => ({ ...b, rsvp: await rsvpSummary(db, b.id), addons: await bookingAddons(db, b.id), dishes: await packages.bookingSelection(db, b.id) })));
    const stats = await db.prepare(
      `SELECT COUNT(*) AS bookings, COALESCE(SUM(b.total_amount - b.platform_fee), 0) AS revenue,
              COALESCE(SUM(CASE WHEN b.payout_status = 'paid' THEN b.total_amount - b.platform_fee END), 0) AS paid_out
       FROM bookings b JOIN venues v ON v.id = b.venue_id WHERE v.restaurant_id = ? AND b.status = 'confirmed'`
    ).get(rid);
    res.render('restaurant/dashboard', { title: 'Restaurant dashboard', venues, menus, addons, bookings, stats, rating: await reviews.summary(db, rid) });
  });

  router.get('/profile', (req, res) => res.render('restaurant/profile', { title: 'Restaurant profile', form: req.restaurant, errors: [] }));
  router.post('/profile', async (req, res) => {
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
    await db.prepare(`UPDATE restaurants SET name=?, description=?, cuisine=?, address=?, area=?, city=?, phone=?,
                payout_name=?, payout_upi=?, payout_account=?, payout_ifsc=? WHERE id=?`)
      .run(form.name, form.description, form.cuisine, form.address, form.area, form.city, form.phone,
        form.payout_name, form.payout_upi, form.payout_account, form.payout_ifsc, req.restaurant.id);
    req.flash('success', 'Profile updated.');
    res.redirect('/restaurant');
  });

  // ---- Venues ----
  router.get('/venues/new', (req, res) => res.render('restaurant/venue-form', { title: 'Add a party venue', venue: { min_pax: 20, max_pax: 100 }, images: [], errors: [] }));

  router.post('/venues', imageUpload.array('images', 8), async (req, res) => {
    const { v, errors } = venueFromBody(req.body);
    // Hosts choose on the space, so a new venue needs a few angles of it.
    if ((req.files?.length || 0) < MIN_PHOTOS) errors.push(`Add at least ${MIN_PHOTOS} photos of the space – the room, the seating and the setting (JPG, PNG or WebP, up to 5 MB each).`);
    if (errors.length) {
      return res.status(422).render('restaurant/venue-form', { title: 'Add a party venue', venue: { ...req.body, hire_fee: req.body.hire_fee }, images: [], errors, rawFee: true });
    }
    const id = Number((await db.prepare(
      'INSERT INTO venues (restaurant_id, name, description, amenities, ambience, min_pax, max_pax, hire_fee, extra_time_fee, dinner_start, dinner_minutes, mosque_name, mosque_walk_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.restaurant.id, v.name, v.description, v.amenities, v.ambience, v.min_pax, v.max_pax, v.hire_fee, v.extra_time_fee, v.dinner_start, v.dinner_minutes, v.mosque_name, v.mosque_walk_minutes)).lastInsertRowid);
    const ins = db.prepare('INSERT INTO venue_images (venue_id, filename, sort_order) VALUES (?, ?, ?)');
    for (const [i, name] of (await storage.saveImages(req.files)).entries()) await ins.run(id, name, i);
    req.flash('success', `${v.name} is live. Hosts can now find and book it.`);
    res.redirect('/restaurant');
  });

  router.get('/venues/:id/edit', async (req, res) => {
    const venue = await ownVenue(req);
    if (!venue) return notFound(res);
    const images = await db.prepare('SELECT * FROM venue_images WHERE venue_id = ? ORDER BY sort_order, id').all(venue.id);
    res.render('restaurant/venue-form', { title: `Edit ${venue.name}`, venue, images, errors: [] });
  });

  router.post('/venues/:id', imageUpload.array('images', 8), async (req, res) => {
    const venue = await ownVenue(req);
    if (!venue) {
      return notFound(res);
    }
    const { v, errors } = venueFromBody(req.body);
    const images = await db.prepare('SELECT * FROM venue_images WHERE venue_id = ? ORDER BY sort_order, id').all(venue.id);
    if (errors.length) {
      return res.status(422).render('restaurant/venue-form', { title: `Edit ${venue.name}`, venue: { ...req.body, id: venue.id }, images, errors, rawFee: true });
    }
    await db.prepare('UPDATE venues SET name=?, description=?, amenities=?, ambience=?, min_pax=?, max_pax=?, hire_fee=?, extra_time_fee=?, dinner_start=?, dinner_minutes=?, mosque_name=?, mosque_walk_minutes=? WHERE id=?')
      .run(v.name, v.description, v.amenities, v.ambience, v.min_pax, v.max_pax, v.hire_fee, v.extra_time_fee, v.dinner_start, v.dinner_minutes, v.mosque_name, v.mosque_walk_minutes, venue.id);
    const ins = db.prepare('INSERT INTO venue_images (venue_id, filename, sort_order) VALUES (?, ?, ?)');
    const added = await storage.saveImages(req.files);
    for (const [i, name] of added.entries()) await ins.run(venue.id, name, images.length + i);
    const photos = images.length + added.length;
    req.flash('success', photos < MIN_PHOTOS
      ? `Venue updated. Add ${MIN_PHOTOS - photos} more photo${MIN_PHOTOS - photos === 1 ? '' : 's'} – hosts pick venues by how the space looks.`
      : 'Venue updated.');
    res.redirect(`/restaurant/venues/${venue.id}/edit`);
  });

  router.post('/venues/:id/images/:imageId/delete', async (req, res) => {
    const venue = await ownVenue(req);
    if (!venue) return notFound(res);
    const count = (await db.prepare('SELECT COUNT(*) AS n FROM venue_images WHERE venue_id = ?').get(venue.id)).n;
    const img = await db.prepare('SELECT * FROM venue_images WHERE id = ? AND venue_id = ?').get(req.params.imageId, venue.id);
    if (img && count <= 1) req.flash('error', 'Keep at least one photo – upload a replacement first.');
    else if (img) {
      await db.prepare('DELETE FROM venue_images WHERE id = ?').run(img.id);
      await storage.remove(img.filename);
      req.flash('success', 'Photo removed.');
    }
    res.redirect(`/restaurant/venues/${venue.id}/edit`);
  });

  router.post('/venues/:id/toggle', async (req, res) => {
    const venue = await ownVenue(req);
    if (!venue) return notFound(res);
    await db.prepare('UPDATE venues SET active = 1 - active WHERE id = ?').run(venue.id);
    req.flash('success', venue.active ? `${venue.name} is hidden from search. Existing bookings are unaffected.` : `${venue.name} is listed again.`);
    res.redirect('/restaurant');
  });

  // ---- Menus ----
  const dishCatalog = async (rid) => await db.prepare('SELECT * FROM dishes WHERE restaurant_id = ? AND active = 1 ORDER BY name').all(rid);
  const menuForm = async (req, res, { title, menu, def = {}, errors = [], rawPrice = false, status = 200 }) =>
    res.status(status).render('restaurant/menu-form', {
      title, menu, def, errors, rawPrice, courses: packages.COURSES, dishes: await dishCatalog(req.restaurant.id),
      minDishes: await require('../services/settings').minPackageDishes(db),
    });

  /** Validate + persist a set menu or package in one transaction. Returns the menu id or null with errors rendered. */
  async function saveMenu(req, res, existing) {
    const { m, errors } = menuFromBody(req.body);
    const def = m.kind === 'package' ? await packages.parseDefinition(db, req.restaurant.id, req.body) : null;
    if (def) errors.push(...def.errors);
    if (errors.length) {
      await menuForm(req, res, {
        title: existing ? `Edit ${existing.name}` : 'Add a menu or package', menu: { ...req.body, id: existing?.id },
        def: req.body, errors, rawPrice: true, status: 422,
      });
      return null;
    }
    return transaction(db, async () => {
      let id = existing?.id;
      if (existing) {
        // Existing bookings keep the price and dishes they were quoted (stored on the booking).
        await db.prepare('UPDATE menus SET kind=?, meal=?, name=?, description=?, items=?, diet=?, price_per_person=?, min_pax=? WHERE id=?')
          .run(m.kind, m.meal, m.name, m.description, m.items, m.diet, m.price_per_person, m.min_pax, id);
      } else {
        id = Number((await db.prepare('INSERT INTO menus (restaurant_id, kind, meal, name, description, items, diet, price_per_person, min_pax) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(req.restaurant.id, m.kind, m.meal, m.name, m.description, m.items, m.diet, m.price_per_person, m.min_pax)).lastInsertRowid);
      }
      await packages.saveDefinition(db, id, def || { rules: [], dishIds: [] });
      return id;
    });
  }

  router.get('/menus/new', async (req, res) => {
    const kind = req.query.kind === 'package' ? 'package' : 'set';
    const meal = sessions.normalizeMeal(req.query.meal);
    await menuForm(req, res, { title: kind === 'package' ? 'Add a package' : `Add a${meal === 'iftar' ? 'n' : ''} ${sessions.mealLabel(meal)} menu`, menu: { kind, meal, diet: 'non-veg', min_pax: 1 } });
  });

  router.post('/menus', async (req, res) => {
    const id = await saveMenu(req, res, null);
    if (!id) return;
    req.flash('success', `${req.body.kind === 'package' ? 'Package' : 'Menu'} “${str(req.body.name, 120)}” added.`);
    res.redirect('/restaurant#menus');
  });

  router.get('/menus/:id/edit', async (req, res) => {
    const menu = await ownMenu(req);
    if (!menu) return notFound(res);
    await menuForm(req, res, { title: `Edit ${menu.name}`, menu, def: await packages.definitionForForm(db, menu.id) });
  });

  router.post('/menus/:id', async (req, res) => {
    const menu = await ownMenu(req);
    if (!menu) return notFound(res);
    if (!await saveMenu(req, res, menu)) return;
    req.flash('success', 'Saved. Existing bookings keep their original price and dishes.');
    res.redirect('/restaurant#menus');
  });

  // ---- Dish catalogue (used to build packages) ----
  router.get('/dishes', async (req, res) => {
    const all = await db.prepare('SELECT * FROM dishes WHERE restaurant_id = ? ORDER BY active DESC, name').all(req.restaurant.id);
    const groups = packages.COURSES.map(([course, label]) => ({ course, label, dishes: all.filter((d) => d.course === course) }));
    res.render('restaurant/dishes', { title: 'Dish catalogue', groups, courses: packages.COURSES, form: {}, errors: [], editing: null });
  });

  router.post('/dishes', async (req, res) => {
    const { d, errors } = dishFromBody(req.body);
    if (errors.length) {
      req.flash('error', errors.join(' '));
      return res.redirect('/restaurant/dishes');
    }
    await db.prepare('INSERT INTO dishes (restaurant_id, name, course, diet, description) VALUES (?, ?, ?, ?, ?)')
      .run(req.restaurant.id, d.name, d.course, d.diet, d.description);
    req.flash('success', `${d.name} added to ${packages.courseLabel(d.course).toLowerCase()}.`);
    res.redirect(`/restaurant/dishes#${d.course}`);
  });

  const ownDish = async (req) => await db.prepare('SELECT * FROM dishes WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurant.id);

  router.post('/dishes/:id', async (req, res) => {
    const dish = await ownDish(req);
    if (!dish) return notFound(res);
    const { d, errors } = dishFromBody(req.body);
    if (errors.length) req.flash('error', errors.join(' '));
    else {
      await db.prepare('UPDATE dishes SET name=?, course=?, diet=?, description=? WHERE id=?').run(d.name, d.course, d.diet, d.description, dish.id);
      if (d.course !== dish.course) await db.prepare('DELETE FROM menu_dishes WHERE dish_id = ?').run(dish.id); // no longer eligible in its old course
      req.flash('success', 'Dish updated.');
    }
    res.redirect(`/restaurant/dishes#${d.course || dish.course}`);
  });

  router.post('/dishes/:id/toggle', async (req, res) => {
    const dish = await ownDish(req);
    if (!dish) return notFound(res);
    await db.prepare('UPDATE dishes SET active = 1 - active WHERE id = ?').run(dish.id);
    req.flash('success', dish.active ? `${dish.name} is unavailable – hidden from all packages.` : `${dish.name} is available again.`);
    res.redirect(`/restaurant/dishes#${dish.course}`);
  });

  router.post('/menus/:id/toggle', async (req, res) => {
    const menu = await ownMenu(req);
    if (!menu) return notFound(res);
    await db.prepare('UPDATE menus SET active = 1 - active WHERE id = ?').run(menu.id);
    req.flash('success', menu.active ? `“${menu.name}” is no longer offered.` : `“${menu.name}” is offered again.`);
    res.redirect('/restaurant');
  });

  // ---- Reviews (published only; replies are moderated) ----
  router.get('/reviews', async (req, res) => {
    res.render('restaurant/reviews', {
      title: 'Reviews', summary: await reviews.summary(db, req.restaurant.id), list: await reviews.published(db, req.restaurant.id, 100),
      pending: (await db.prepare(`SELECT COUNT(*) n FROM reviews WHERE restaurant_id = ? AND status = 'pending'`).get(req.restaurant.id)).n,
    });
  });

  router.post('/reviews/:id/reply', async (req, res) => {
    try {
      await reviews.submitReply(db, Number(req.params.id), req.restaurant.id, req.body.reply);
      req.flash('success', 'Reply submitted. It will appear under the review once approved.');
    } catch (err) {
      if (!(err instanceof reviews.ReviewError)) throw err;
      req.flash('error', err.message);
    }
    res.redirect(`/restaurant/reviews#review-${Number(req.params.id)}`);
  });

  // ---- Packages & add-ons ----
  const ownAddon = async (req) => await db.prepare('SELECT * FROM addons WHERE id = ? AND restaurant_id = ?').get(req.params.id, req.restaurant.id);
  const addonForm = (res, title, addon, errors, rawPrice = false, status = 200) =>
    res.status(status).render('restaurant/addon-form', { title, addon, errors, rawPrice, categories: ADDON_CATEGORIES });

  router.get('/addons/new', (req, res) => addonForm(res, 'Add an extra', { pricing: 'per_guest', category: 'food' }, []));

  router.post('/addons', async (req, res) => {
    const { a, errors } = addonFromBody(req.body);
    if (errors.length) return addonForm(res, 'Add an extra', req.body, errors, true, 422);
    await db.prepare('INSERT INTO addons (restaurant_id, name, description, category, pricing, price) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.restaurant.id, a.name, a.description, a.category, a.pricing, a.price);
    req.flash('success', `Extra “${a.name}” added. Hosts can add it to any booking.`);
    res.redirect('/restaurant#addons');
  });

  router.get('/addons/:id/edit', async (req, res) => {
    const addon = await ownAddon(req);
    if (!addon) return notFound(res);
    addonForm(res, `Edit ${addon.name}`, addon, []);
  });

  router.post('/addons/:id', async (req, res) => {
    const addon = await ownAddon(req);
    if (!addon) return notFound(res);
    const { a, errors } = addonFromBody(req.body);
    if (errors.length) return addonForm(res, `Edit ${addon.name}`, { ...req.body, id: addon.id }, errors, true, 422);
    await db.prepare('UPDATE addons SET name=?, description=?, category=?, pricing=?, price=? WHERE id=?')
      .run(a.name, a.description, a.category, a.pricing, a.price, addon.id);
    req.flash('success', 'Extra updated. Existing bookings keep the price they paid.');
    res.redirect('/restaurant#addons');
  });

  router.post('/addons/:id/toggle', async (req, res) => {
    const addon = await ownAddon(req);
    if (!addon) return notFound(res);
    await db.prepare('UPDATE addons SET active = 1 - active WHERE id = ?').run(addon.id);
    req.flash('success', addon.active ? `“${addon.name}” is no longer offered.` : `“${addon.name}” is offered again.`);
    res.redirect('/restaurant#addons');
  });

  return router;
};
