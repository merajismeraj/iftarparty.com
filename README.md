# IftarParty.com

Reserve private party venues at local restaurants for Iftar gatherings, pay online, and invite guests on WhatsApp and email with RSVP tracking.

## What it does

**Restaurants**
- Sign up as a restaurant partner. Add venues with min/max guest count (pax), a venue hire fee and photos (JPG/PNG/WebP, up to 8).
- Add Iftar menus with a per-guest price, minimum guests, veg/non-veg flag and the dishes included.
- Build a **dish catalogue** (openers, starters, mains, biryani & rice, breads, desserts, beverages; veg or non-veg).
- Offer **set menus** (a fixed list of dishes) and/or **packages**: budget tiers like *Silver ₹699 · Gold ₹999 · Platinum ₹1,499* per guest. Each package sets how many dishes the host chooses per course (e.g. *3 starters · 2 mains · 2 desserts*) and which dishes are eligible, so premium dishes can be kept for higher tiers. Marking a dish unavailable removes it from every package at once.
- Add **extras** such as a live grill, dessert counter, décor or photography, priced **per guest** or **per event**.
- Read published reviews and reply. Replies are moderated before they appear.
- The dashboard shows upcoming parties, each host's contact details, the RSVP headcount and the payout.

**Hosts**
- Search by **location**, **date**, **guest count**, **menu, dish or cuisine** (dish names inside packages match too), **budget** and diet. The budget can be **per guest** or a **total for the event**: food + venue + service fee for your guest count, before extras. Cards show a *Fits budget* estimate. Sort by price, top rated, size or newest.
- On a venue page, every menu and package is marked **Within budget** or **Over budget by ₹X**. Pick a date, guest count and menu or package, choose dishes per course (the picker stops at each course's limit) and any extras. Hosts must pick **at least 4 dishes in total** (at least one from every course in the package). The minimum is an admin setting, and packages that can't reach it are hidden. The **full price shows live**, along with how much of your budget is left.
- Dish picks and extras are saved with the booking at their quoted prices. Hosts can **change dishes until 2 days before the Iftar**; after that the menu is final for the kitchen. Picks appear on the checkout page, the host's party page, the restaurant dashboard, the admin booking page and the guests' invitations. The server recalculates it, so a client can't change the price.
- Reserving holds the venue for 30 minutes while you pay. After payment the venue shows **"Reserved · Iftar Party by <host name>"** for that evening, and search hides it for that date.
- After payment you're sent straight to **upload your invite list** as a CSV or pasted rows with name, email and mobile. Each guest gets a personalised **WhatsApp** message and **email** with a private RSVP link.
- Guests reply Yes, Maybe or No with the number of people coming and a note. The host's dashboard shows **attending, total heads, maybe, declined and awaiting reply**, plus a bar comparing confirmed heads to guests booked. You can send reminders to anyone who hasn't replied and export the RSVPs to CSV.
- The RSVP page shows **who's coming**: the confirmed guests as "First L." with any "+N" family members, plus a total headcount. The guest viewing it appears first as "You". Contact details, declines and maybes are never shown, and the host can switch the list off in their invitation settings.

**Reviews (verified, moderated)**
- Only the host of a **confirmed booking whose Iftar has taken place** can review the venue, once per booking. They give an overall rating plus optional food, service and ambience ratings.
- Every review waits in the admin **moderation queue**. Editing a published review takes it offline until it's approved again. If a review is rejected, the host sees the reason and can resubmit.
- Venue pages show the average rating, the star distribution, the sub-ratings and published reviews. Reviewers are shown as "First L." with a *Verified booking* badge. Search cards show the rating, and results can be sorted by **Top rated**.

## Run it

Requires Node.js 22. The database is **Postgres**: Supabase in production. Locally and in tests it uses **PGlite**, a full Postgres compiled to WebAssembly that runs in-process, so there is nothing to install. Data is kept in `data/pglite`.

```bash
npm install
cp .env.example .env      # optional – works with defaults
npm run seed              # demo restaurants, venues, menus and a booked party
npm start                 # http://localhost:3000
npm test                  # 98 integration + unit tests on PGlite (Cashfree, Google, Supabase Storage faked)
TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm test   # same suite on a real Postgres server
```

Demo logins (password `password123`): admin `admin@demo.test`; host `host@demo.test`; restaurants `owner@noor.test`, `owner@charminar.test`, `owner@arabian.test`, plus `owner@zaffran.test`, which is pending approval.

## Integrations

Each integration runs in **demo mode** until you add its keys, so you can use the whole flow locally.

| Feature | Demo mode | Production |
|---|---|---|
| Payments | Simulated checkout. Refunds succeed instantly | **Cashfree Payment Gateway**: `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV=sandbox\|production` |
| Email | Printed to the server log | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (any SMTP provider, e.g. SES, Postmark, SendGrid) |
| Google sign-in | Button hidden; email + password only | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (see below) |
| WhatsApp | Printed to the server log | **OpenWA** self-hosted gateway (default): `OPENWA_URL`, `OPENWA_API_KEY`, `OPENWA_SESSION_ID`. Or the official Meta Cloud API with `WHATSAPP_PROVIDER=meta` |

### Cashfree

1. **Create the order on the server.** We call `POST /pg/orders` with API version `2023-08-01`. Cashfree returns a `payment_session_id`, which the Cashfree JS SDK uses to open its hosted checkout. The host pays there by UPI, card, netbanking or wallet.
2. **Confirm the payment two ways.** Cashfree sends the host back to `/bookings/:id/payment-return`, and it also sends a signed webhook to **`<BASE_URL>/webhooks/cashfree`**. Add that URL in *Cashfree Dashboard → Developers → Webhooks* and subscribe to **Payment success** and **Refund status**. In both cases we re-fetch the order from Cashfree and only confirm the booking if `order_status = PAID` and the amount matches.
3. **Check the webhook signature.** Each webhook must carry a valid `x-webhook-signature`: an HMAC-SHA256 of the timestamp plus the raw body, signed with your secret key. Webhooks older than 10 minutes are rejected.
4. **Record every attempt in a ledger.** Each order and refund is stored in the `payments` table. If money arrives that can't buy a booking, it is **refunded automatically** through `POST /pg/orders/{id}/refunds`. That covers three cases: a second payment for a booking that's already paid, a late payment after someone else took the night, and a payment for a booking that was cancelled in the meantime.
5. **Order ids look like `IP-<bookingId>-<random>`**, so a webhook can always be matched to its booking.

Test it with Cashfree **sandbox** keys and their test UPI ID or cards before switching `CASHFREE_ENV=production`.

### Google sign-in

1. In *Google Cloud Console → APIs & Services → Credentials*, create an **OAuth client ID** of type **Web application**.
2. **Authorized JavaScript origin:** your `BASE_URL` (e.g. `https://iftarparty.com`).
3. **Authorized redirect URI:** **`<BASE_URL>/auth/google/callback`**. It must match `BASE_URL` exactly, so set `BASE_URL` in production. Add `http://localhost:3000/auth/google/callback` for local development.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The *Continue with Google* button then appears on sign-in and sign-up.

How it works: authorization-code flow with PKCE, `state` and `nonce` held in the session. The ID token is fetched server-to-server and its issuer, audience, expiry, nonce and `email_verified` are checked. A verified Google email that matches an existing account is linked to it. Google gives no mobile number, so new users are asked for one once (restaurants also give their name and city) before they can continue.

### WhatsApp (OpenWA)

Invites, reminders and cancellation notices go out through [OpenWA](https://github.com/rmyndharis/OpenWA), a self-hosted WhatsApp Web gateway. It sends the full personalised message as plain text, so **no Meta template approval is needed**.

1. **Run OpenWA** on a server with persistent storage (it keeps the WhatsApp session):
   ```bash
   git clone https://github.com/rmyndharis/OpenWA.git && cd OpenWA
   docker compose up -d          # API + dashboard on :2785
   ```
2. **Link a number.** Create and start a session (`POST /api/sessions` with `{"name":"iftarparty"}`, then `POST /api/sessions/{id}/start`), open `GET /api/sessions/{id}/qr`, and scan it with WhatsApp on the **dedicated** phone.
3. **Configure IftarParty:** set `OPENWA_URL=http://<host>:2785/api`, `OPENWA_API_KEY` (from OpenWA's `/app/data/.api-key`) and `OPENWA_SESSION_ID`.

> **Risk:** OpenWA is unofficial (it automates WhatsApp Web), and WhatsApp may restrict numbers that look automated. Use a **dedicated number you can afford to lose**, never your main business line. Sends are **paced**: one at a time, at least `OPENWA_MIN_INTERVAL_MS` apart (default 1.5s, with jitter). Keep invite lists to people who expect the message. A failed send shows up in **Admin → Messages** with OpenWA's error (for example "session not connected") and can be resent once fixed.

**Official alternative.** Set `WHATSAPP_PROVIDER=meta` with `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` to use Meta's WhatsApp Cloud API. That route needs two approved *Utility* templates: `iftar_invite` with 5 body variables (guest name, party title, date & time, venue, RSVP link), and `iftar_cancelled` with 4 (guest name, party title, date, venue).

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
| **Restaurants** | Approve, reject, suspend or reinstate. New sign-ups stay **pending** and hidden from search until approved. Rejecting or suspending needs a reason, which the restaurant sees. Hide individual venues. View payout details. |
| **Bookings** | Filter by status, refund state, event dates or free text, including the order id. Export to CSV for accounting. Each booking shows the event, RSVPs, the money breakdown and the full **payments ledger**. **Cancel with a full, partial or no refund** through Cashfree. The host is emailed, invited guests are told by WhatsApp and email (optional), their RSVP links show the cancellation, and the night becomes free again. Re-check stuck orders with the gateway and retry failed refunds. |
| **Reviews** | Moderation queue for reviews and restaurant replies: approve, reject or unpublish, with a reason the author sees. Includes booking context and the reviewer's history. |
| **Payouts** | Lists what each restaurant is owed (total minus platform fee) for Iftars that have already happened, with their UPI and bank details. Record the bank reference (UTR) to mark them paid; the payout history is kept. |
| **Users** | Search, then suspend or reactivate hosts and restaurant owners. A suspended user is signed out immediately and can't sign back in. |
| **Messages** | WhatsApp and email delivery rates for the last 7 days, failed sends with the error from the provider, and one-click resend. |
| **Settings** | The platform fee percentage, which applies only to new bookings (each booking keeps the fee it was quoted), and the **minimum dishes per package**, default 4. |
| **Audit log** | Every admin action, with who did it, when, and the details. |

## Architecture

- **Express 5 + EJS** server-rendered pages, with a small vanilla JS file for the live quote, availability check and hold countdown.
- **Warm, modern visual design.** An ivory background with white cards that lift off it, a deep aubergine-to-terracotta "dusk" gradient for the hero, call-to-action and footer bands, a saffron-terracotta accent for primary actions, soft peach/saffron/plum/sage tints for badges, and Plus Jakarta Sans headings over Inter body text. There is no themed decoration. Colour tokens live at the top of `public/css/style.css`, and the theme layer is at the end of it.
- **Mobile-first UI.** Base styles target phones and are layered up at 640px and 960px. On phones the site uses a menu-button drawer, a collapsible search summary, swipeable venue photos, a sticky *Reserve* bar with the live total, and tables that turn into stacked cards. Tap targets are at least 44px and inputs use 16px text (no iOS zoom). Everything is checked for horizontal overflow at 320, 375, 768 and 1280px. The site still works without JS: the nav and search simply render expanded.
- **Postgres** (`src/db.js`): Supabase through `pg` when `DATABASE_URL`/`POSTGRES_URL` is set, otherwise in-process PGlite. A small async adapter (`db.prepare(sql).get/all/run`, `?` placeholders) keeps queries readable. Migrations live in `schema_migrations` and run automatically under an advisory lock, so concurrent serverless cold starts are safe. Row Level Security is enabled on every table, which closes Supabase's public REST API; the app connects as the table owner. Money is stored as integer minor units (paise).
- **Photos** go to **Supabase Storage** (a public bucket, `venue-photos`, created automatically) when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, otherwise to `UPLOAD_DIR`. Browsers shrink photos to 1600px JPEG before upload, which keeps requests under Vercel's 4.5 MB limit.
- **Double-booking protection:** holds are taken inside a transaction that holds an advisory lock, so check-then-insert is serialised; a test fires six simultaneous reservations and exactly one wins. A partial unique index allows only one *confirmed* booking per venue per night. If a payment arrives after the hold lapsed and someone else has taken the night, the booking is flagged for refund instead of being double-booked.
- **Security:** bcrypt passwords, signed httpOnly session cookies, CSRF tokens on every form, Helmet CSP, ownership checks on every restaurant and booking route, image-only uploads with size limits, rate-limited login, and spreadsheet-formula escaping in CSV exports.

```
src/
  app.js, server.js, config.js, db.js
  routes/      public (search, venue) · auth · restaurant · bookings · rsvp · admin · webhooks
  services/    bookings (holds/confirm) · packages · reviews · checkout (ledger, refunds) · payments (Cashfree) · storage (Supabase) · google · pricing · settings · audit · invites · notify · guestlist
views/         EJS pages + email template
public/        CSS, JS
scripts/seed.js, scripts/create-admin.js
test/
```

## Deploying

### Production: Vercel + Supabase
The app runs as one Vercel function, and data lives in Supabase Postgres with photos in Supabase Storage. **The function region in `vercel.json` must match the Supabase project's region.** Each page makes several sequential queries, so a cross-region database adds ~190 ms per query. `/healthz` reports the round trip in `X-DB-Time`: 1–3 ms means the regions match. The project currently runs in `iad1`, next to its Supabase database (US East). For Indian users, move both to Mumbai (`bom1` + Supabase `ap-south-1`).

1. **Create the Supabase project in the same region as the functions.** Mumbai (`ap-south-1`, with `bom1`) is best for Indian users. The easiest way is Vercel → Project → **Storage → Supabase** (Marketplace), which creates the project and adds its variables. **Connect it to Production only.** If previews shared it, they would write into the live database.
2. **Variables (Production):**

   | Variable | Value |
   |---|---|
   | `POSTGRES_URL` (or `DATABASE_URL`) | Supabase **transaction pooler** URL (port 6543). Added by the integration |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Added by the integration. Used server-side only, for photo storage |
   | `DEMO_MODE` | `false` |
   | `ADMIN_EMAIL` | First admin. While no admin exists, whoever signs in with Google using this address becomes the admin, so no password is stored. Alternatively add `ADMIN_PASSWORD` (12+ chars) to create the account at boot |
   | `SESSION_SECRET`, `BASE_URL`, `GOOGLE_*`, `CASHFREE_*`, `SMTP_*`, `OPENWA_*` | As before |
3. **Redeploy.** The first request migrates the schema (about a second) and creates the `venue-photos` bucket.
4. **Backups:** Supabase takes daily backups. *Admin → Settings → Download database backup* exports every table as JSON on demand.

Previews always run on an in-memory PGlite database seeded with demo data, even if an integration shares its variables with the Preview environment. Set `ALLOW_PREVIEW_DATABASE=true` to opt out. They're safe to click through, and everything resets.

Notes:
- `DATABASE_CA_CERT` (Supabase → Database → SSL certificate) turns on full TLS certificate verification. Without it the connection is encrypted but the certificate isn't verified.
- WhatsApp through OpenWA still needs an always-on host for the gateway itself, outside Vercel. The app only calls its HTTP API.

### Elsewhere (Docker)
The `Dockerfile` runs the same app on any container host (Railway, Render, Fly.io, a VPS). Set `DATABASE_URL` to Postgres, or leave it unset to keep PGlite on a persistent volume at `/data`.

## Production notes

- Set `NODE_ENV=production`, a long random `SESSION_SECRET` and `BASE_URL`, which is used in RSVP links.
- For large guest lists, move `sendInvites` to a job queue. It already sends with limited concurrency.
