# IftarParty.com

Reserve private party halls at local restaurants for Iftar gatherings, pay online, and invite guests on WhatsApp and email with RSVP tracking.

## What it does

**Restaurants**
- Sign up as a restaurant partner. Add halls with min/max guest count (pax), a hall hire fee and photos (JPG/PNG/WebP, up to 8).
- Add Iftar menus with a per-guest price, minimum guests, veg/non-veg flag and the dishes included.
- The dashboard shows upcoming parties, each host's contact details, the RSVP headcount and the payout.

**Hosts**
- Search by **location**, **date**, **guest count**, **menu or cuisine** (e.g. "haleem"), **max price per guest** and diet. You can sort by price, size or newest.
- On a venue page, pick a date, guest count and menu, and the **full price shows live** (food + hall fee + service fee). The server recalculates it, so a client can't change the price.
- Reserving holds the hall for 30 minutes while you pay. After payment the venue shows **"Reserved · Iftar Party by <host name>"** for that evening, and search hides it for that date.
- After payment you're sent straight to **upload your invite list** as a CSV or pasted rows with name, email and mobile. Each guest gets a personalised **WhatsApp** message and **email** with a private RSVP link.
- Guests reply Yes, Maybe or No with the number of people coming and a note. The host's dashboard shows **attending, total heads, maybe, declined and awaiting reply**, plus a bar comparing confirmed heads to guests booked. You can send reminders to anyone who hasn't replied and export the RSVPs to CSV.

## Run it

Requires Node.js 22.13 or later. It uses the built-in `node:sqlite`, so there are no native modules to build.

```bash
npm install
cp .env.example .env      # optional – works with defaults
npm run seed              # demo restaurants, halls, menus and a booked party
npm start                 # http://localhost:3000
npm test                  # 23 integration + unit tests
```

Demo logins (password `password123`): host `host@demo.test`; restaurants `owner@noor.test`, `owner@charminar.test`, `owner@arabian.test`.

## Integrations

Each integration runs in **demo mode** until you add its keys, so you can use the whole flow locally.

| Feature | Demo mode | Production |
|---|---|---|
| Payments | Built-in simulated checkout | `STRIPE_SECRET_KEY` turns on Stripe Checkout. Point a webhook at `POST /webhooks/stripe` (event `checkout.session.completed`) and set `STRIPE_WEBHOOK_SECRET` |
| Email | Printed to the server log | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (any SMTP provider, e.g. SES, Postmark, SendGrid) |
| WhatsApp | Printed to the server log | Meta WhatsApp Cloud API: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME` |

**WhatsApp template.** WhatsApp only lets businesses start a conversation with an approved template. Create a *Utility* template (default name `iftar_invite`) with 5 body variables:

```
Assalamu Alaikum {{1}}, you're invited to {{2}}!
When: {{3}}
Where: {{4}}
Please RSVP here: {{5}}
```

Every delivery attempt is recorded in the `message_log` table, and the guest list shows the WhatsApp and email status for each guest.

## Architecture

- **Express 5 + EJS** server-rendered pages, with a small vanilla JS file for the live quote, availability check and hold countdown.
- **SQLite** through `node:sqlite` (`src/db.js`). Money is stored as integer minor units (paise).
- **Double-booking protection:** the hold is taken inside a synchronous `BEGIN IMMEDIATE` transaction. A partial unique index allows only one *confirmed* booking per venue per night. If a payment arrives after the hold lapsed and someone else has taken the night, the booking is flagged for refund instead of being double-booked.
- **Security:** bcrypt passwords, signed httpOnly session cookies, CSRF tokens on every form, Helmet CSP, ownership checks on every restaurant and booking route, image-only uploads with size limits, rate-limited login, and spreadsheet-formula escaping in CSV exports.

```
src/
  app.js, server.js, config.js, db.js
  routes/      public (search, venue) · auth · restaurant · bookings · rsvp · webhooks
  services/    bookings (holds/confirm) · pricing · payments · invites · notify · guestlist
views/         EJS pages + email template
public/        CSS, JS
scripts/seed.js
test/
```

## Production notes

- Set `NODE_ENV=production`, a long random `SESSION_SECRET` and `BASE_URL`, which is used in RSVP links.
- Store `uploads/` and the database on persistent disk. For multi-instance scale, move to Postgres and S3, which only touches `db.js` and `middleware/uploads.js`.
- For large guest lists, move `sendInvites` to a job queue. It already sends with limited concurrency.
