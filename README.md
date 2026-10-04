# IftarParty.com

Reserve private party halls at local restaurants for Iftar gatherings, pay online, and invite guests on WhatsApp and email with RSVP tracking.

## What it does

**Restaurants**
- Sign up as a restaurant partner. Add halls with min/max guest count (pax), a hall hire fee and photos (JPG/PNG/WebP, up to 8).
- Add Iftar menus with a per-guest price, minimum guests, veg/non-veg flag and the dishes included.
- Build a **dish catalogue** (openers, starters, mains, biryani & rice, breads, desserts, beverages; veg or non-veg).
- Offer **set menus** (a fixed list of dishes) and/or **packages**: budget tiers like *Silver ₹699 · Gold ₹999 · Platinum ₹1,499* per guest. Each package sets how many dishes the host chooses per course (e.g. *3 starters · 2 mains · 2 desserts*) and which dishes are eligible, so premium dishes can be kept for higher tiers. Marking a dish unavailable removes it from every package at once.
- Add **extras** such as a live grill, dessert counter, décor or photography, priced **per guest** or **per event**.
- Read published reviews and reply. Replies are moderated before they appear.
- The dashboard shows upcoming parties, each host's contact details, the RSVP headcount and the payout.

**Hosts**
- Search by **location**, **date**, **guest count**, **menu, dish or cuisine** (dish names inside packages match too), **budget** and diet. The budget can be **per guest** or a **total for the event**: food + hall + service fee for your guest count, before extras. Cards show a *Fits budget* estimate. Sort by price, top rated, size or newest.
- On a venue page, every menu and package is marked **Within budget** or **Over budget by ₹X**. Pick a date, guest count and menu or package, choose dishes per course (the picker stops at each course's limit) and any extras. Hosts must pick **at least 4 dishes in total** (at least one from every course in the package). The minimum is an admin setting, and packages that can't reach it are hidden. The **full price shows live**, along with how much of your budget is left.
- Dish picks and extras are saved with the booking at their quoted prices. Hosts can **change dishes until 2 days before the Iftar**; after that the menu is final for the kitchen. Picks appear on the checkout page, the host's party page, the restaurant dashboard, the admin booking page and the guests' invitations. The server recalculates it, so a client can't change the price.
- Reserving holds the hall for 30 minutes while you pay. After payment the venue shows **"Reserved · Iftar Party by <host name>"** for that evening, and search hides it for that date.
- After payment you're sent straight to **upload your invite list** as a CSV or pasted rows with name, email and mobile. Each guest gets a personalised **WhatsApp** message and **email** with a private RSVP link.
- Guests reply Yes, Maybe or No with the number of people coming and a note. The host's dashboard shows **attending, total heads, maybe, declined and awaiting reply**, plus a bar comparing confirmed heads to guests booked. You can send reminders to anyone who hasn't replied and export the RSVPs to CSV.

**Reviews (verified, moderated)**
- Only the host of a **confirmed booking whose Iftar has taken place** can review the venue, once per booking. They give an overall rating plus optional food, service and ambience ratings.
- Every review waits in the admin **moderation queue**. Editing a published review takes it offline until it's approved again. If a review is rejected, the host sees the reason and can resubmit.
- Venue pages show the average rating, the star distribution, the sub-ratings and published reviews. Reviewers are shown as "First L." with a *Verified booking* badge. Search cards show the rating, and results can be sorted by **Top rated**.

## Run it

Requires Node.js 22.13 or later. It uses the built-in `node:sqlite`, so there are no native modules to build.

```bash
npm install
cp .env.example .env      # optional – works with defaults
npm run seed              # demo restaurants, halls, menus and a booked party
npm start                 # http://localhost:3000
npm test                  # 69 integration + unit tests (Cashfree is exercised against a fake gateway)
```

Demo logins (password `password123`): admin `admin@demo.test`; host `host@demo.test`; restaurants `owner@noor.test`, `owner@charminar.test`, `owner@arabian.test`, plus `owner@zaffran.test`, which is pending approval.

## Integrations

Each integration runs in **demo mode** until you add its keys, so you can use the whole flow locally.

| Feature | Demo mode | Production |
|---|---|---|
| Payments | Simulated checkout. Refunds succeed instantly | **Cashfree Payment Gateway**: `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV=sandbox\|production` |
| Email | Printed to the server log | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (any SMTP provider, e.g. SES, Postmark, SendGrid) |
| WhatsApp | Printed to the server log | Meta WhatsApp Cloud API: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_NAME` |

### Cashfree

1. **Create the order on the server.** We call `POST /pg/orders` with API version `2023-08-01`. Cashfree returns a `payment_session_id`, which the Cashfree JS SDK uses to open its hosted checkout. The host pays there by UPI, card, netbanking or wallet.
2. **Confirm the payment two ways.** Cashfree sends the host back to `/bookings/:id/payment-return`, and it also sends a signed webhook to **`<BASE_URL>/webhooks/cashfree`**. Add that URL in *Cashfree Dashboard → Developers → Webhooks* and subscribe to **Payment success** and **Refund status**. In both cases we re-fetch the order from Cashfree and only confirm the booking if `order_status = PAID` and the amount matches.
3. **Check the webhook signature.** Each webhook must carry a valid `x-webhook-signature`: an HMAC-SHA256 of the timestamp plus the raw body, signed with your secret key. Webhooks older than 10 minutes are rejected.
4. **Record every attempt in a ledger.** Each order and refund is stored in the `payments` table. If money arrives that can't buy a booking, it is **refunded automatically** through `POST /pg/orders/{id}/refunds`. That covers three cases: a second payment for a booking that's already paid, a late payment after someone else took the night, and a payment for a booking that was cancelled in the meantime.
5. **Order ids look like `IP-<bookingId>-<random>`**, so a webhook can always be matched to its booking.

Test it with Cashfree **sandbox** keys and their test UPI ID or cards before switching `CASHFREE_ENV=production`.

**WhatsApp template.** WhatsApp only lets businesses start a conversation with an approved template. Create a *Utility* template (default name `iftar_invite`) with 5 body variables:

```
Assalamu Alaikum {{1}}, you're invited to {{2}}!
When: {{3}}
Where: {{4}}
Please RSVP here: {{5}}
```

When a booking is cancelled, invited guests who haven't declined receive a cancellation notice. On WhatsApp this uses a second *Utility* template (default `iftar_cancelled`, set with `WHATSAPP_CANCEL_TEMPLATE_NAME`) with 4 body variables:

```
Assalamu Alaikum {{1}}, we're sorry – {{2}} on {{3}} at {{4}} has been cancelled. No action is needed from you.
```

Every delivery attempt, invitation or cancellation, is recorded in the `message_log` table and shown in the admin portal.

## Admin portal (`/admin`)

Admin accounts can't be created from the website. Use the command line:

```bash
npm run admin -- create ops@iftarparty.com "Ops Team"   # asks for a password (12+ chars), or set ADMIN_PASSWORD
npm run admin -- promote someone@example.com
```

| Section | What it does |
|---|---|
| **Overview** | GMV, platform revenue, refunds, live restaurants and upcoming RSVPs. A *Needs attention* queue lists pending approvals, payouts owed, failed or processing refunds, unrefunded payments and failed invites. |
| **Restaurants** | Approve, reject, suspend or reinstate. New sign-ups stay **pending** and hidden from search until approved. Rejecting or suspending needs a reason, which the restaurant sees. Hide individual halls. View payout details. |
| **Bookings** | Filter by status, refund state, event dates or free text, including the order id. Export to CSV for accounting. Each booking shows the event, RSVPs, the money breakdown and the full **payments ledger**. **Cancel with a full, partial or no refund** through Cashfree. The host is emailed, invited guests are told by WhatsApp and email (optional), their RSVP links show the cancellation, and the night becomes free again. Re-check stuck orders with the gateway and retry failed refunds. |
| **Reviews** | Moderation queue for reviews and restaurant replies: approve, reject or unpublish, with a reason the author sees. Includes booking context and the reviewer's history. |
| **Payouts** | Lists what each restaurant is owed (total minus platform fee) for Iftars that have already happened, with their UPI and bank details. Record the bank reference (UTR) to mark them paid; the payout history is kept. |
| **Users** | Search, then suspend or reactivate hosts and restaurant owners. A suspended user is signed out immediately and can't sign back in. |
| **Messages** | WhatsApp and email delivery rates for the last 7 days, failed sends with the error from the provider, and one-click resend. |
| **Settings** | The platform fee percentage, which applies only to new bookings (each booking keeps the fee it was quoted), and the **minimum dishes per package**, default 4. |
| **Audit log** | Every admin action, with who did it, when, and the details. |

## Architecture

- **Express 5 + EJS** server-rendered pages, with a small vanilla JS file for the live quote, availability check and hold countdown.
- **Minimal, modern visual design.** Neutral white surfaces, near-black text, hairline borders instead of shadows, a single deep-green accent (`--gold` token) for primary actions, and Inter throughout. No themed decoration; colour tokens live at the top of `public/css/style.css`.
- **Mobile-first UI.** Base styles target phones and are layered up at 640px and 960px. On phones the site uses a menu-button drawer, a collapsible search summary, swipeable venue photos, a sticky *Reserve* bar with the live total, and tables that turn into stacked cards. Tap targets are at least 44px and inputs use 16px text (no iOS zoom). Everything is checked for horizontal overflow at 320, 375, 768 and 1280px. The site still works without JS: the nav and search simply render expanded.
- **SQLite** through `node:sqlite` (`src/db.js`). The schema is versioned with `PRAGMA user_version` (currently v5), so existing databases upgrade in place on startup. Money is stored as integer minor units (paise).
- **Double-booking protection:** the hold is taken inside a synchronous `BEGIN IMMEDIATE` transaction. A partial unique index allows only one *confirmed* booking per venue per night. If a payment arrives after the hold lapsed and someone else has taken the night, the booking is flagged for refund instead of being double-booked.
- **Security:** bcrypt passwords, signed httpOnly session cookies, CSRF tokens on every form, Helmet CSP, ownership checks on every restaurant and booking route, image-only uploads with size limits, rate-limited login, and spreadsheet-formula escaping in CSV exports.

```
src/
  app.js, server.js, config.js, db.js
  routes/      public (search, venue) · auth · restaurant · bookings · rsvp · admin · webhooks
  services/    bookings (holds/confirm) · packages · reviews · checkout (ledger, refunds) · payments (Cashfree) · pricing · settings · audit · invites · notify · guestlist
views/         EJS pages + email template
public/        CSS, JS
scripts/seed.js, scripts/create-admin.js
test/
```

## Production notes

- Set `NODE_ENV=production`, a long random `SESSION_SECRET` and `BASE_URL`, which is used in RSVP links.
- Store `uploads/` and the database on persistent disk. For multi-instance scale, move to Postgres and S3, which only touches `db.js` and `middleware/uploads.js`.
- For large guest lists, move `sendInvites` to a job queue. It already sends with limited concurrency.
