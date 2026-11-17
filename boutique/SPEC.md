# SPEC — WhatsApp Order & Stock Tool for Senegalese Social Sellers (v1)

Working name: `[NOM]` (to be decided). Put this file at the repo root and reference it from `CLAUDE.md`.

---

## 1. Product in one line

Sellers who sell on WhatsApp/TikTok/Instagram get a catalog link, structured orders and live stock, operated mostly from a WhatsApp bot, with a light PWA dashboard. Model inspired by Page365 (Thailand), Take App / Yezza (SEA), Bumpa (Nigeria).

**Core promise to the seller:** stop answering "c'est combien ? / dispo ?" by hand, stop losing orders, stop selling what you no longer have.

## 2. Users

| User | Access | Notes |
|---|---|---|
| Seller (shop owner) | WhatsApp bot + PWA dashboard | Identified by WhatsApp number |
| Staff (later) | Same as seller, role `staff` | Data model ready in v1, no UI in v1 |
| Buyer | Public catalog link, no account | Identified by phone at checkout |
| Admin (Harouna) | `/admin` | Shops, subscriptions, monitoring |

## 3. Business rules

- Price: **3 000 FCFA / month / shop**, first month free (trial). Paid manually by Wave to the platform; admin marks the subscription paid. Multiple shops / extra seats = future paid upgrade.
- **The platform never holds buyer money.** Wave payments go directly to the seller's own Wave number. COD is collected by the seller/courier. No escrow, no payouts, no BCEAO licensing issue.
- Expired/unpaid shop → status `suspended`: catalog shows "Boutique momentanément indisponible", bot replies with renewal instructions. Data is kept.
- Currency XOF, amounts stored as **integers** (no decimals). Timezone `Africa/Dakar`. Phones stored in **E.164** (`+2217XXXXXXXX`). UI language: **French**.
- Geography v1: Dakar. Physical products only.

## 4. Scope v1

### 4.1 Seller onboarding (bot, ~30 s)
1. Unknown number writes anything ("Bonjour") → bot offers to create a shop.
2. Bot asks: shop name → delivery zones + fees (e.g. `Plateau 1500, Parcelles 2000, Pikine 2500`) → Wave number (default = sender's number).
3. Bot creates user + shop (slug from name, unique) + membership(owner) + trial subscription (30 days) and replies with the catalog link `https://[domain]/[slug]` and the list of commands.

### 4.2 Products (bot)
- **Create:** photo + caption `Nom - prix - qté` → product with one default variant.
  Variants: `Robe wax - 15000 - S:2 M:3 L:1` → one variant per size.
  Product gets a sequential per-shop `code` (1, 2, 3…) used everywhere in the bot.
- **Replace photo:** photo + caption = product code only (e.g. `12`).
- Parse errors → bot replies with the expected format and an example. Never create a half-parsed product silently.
- PWA can edit name, price, description, variants, active/inactive.

### 4.3 Stock (bot)
- `stock` → bot replies with numbered list: `3. Robe wax — S:2 M:3 L:1`.
- Update: `3 12, 5 0` (single-variant products) or `3S 4, 3M 0` (variant by label). Bot echoes the changes and confirms.
- Every stock change writes a `stock_movements` row (traceability).
- Daily **09:00** reminder (template) inviting the seller to update stock.
- Stock decrements automatically on order creation; restocks on cancel/return.

### 4.4 Buyer checkout (public PWA pages)
- `/[slug]` catalog grid (photo, name, price, "Épuisé" badge). `/[slug]/p/[code]` product page.
- Single-shop cart → checkout form: name, phone, delivery zone (shows fee), address/landmark, payment `COD` or `Wave`.
- On submit, **in one DB transaction**: `SELECT … FOR UPDATE` the variants, check stock, decrement, create order + items + stock_movements, upsert customer. Insufficient stock → clear error, nothing written.
- After submit: confirmation page, then redirect to `https://wa.me/<seller>?text=` with prefilled message: `Bonjour, je viens de passer la commande #<n> : <items> — Total <x> FCFA (<paiement>)`. The conversation stays in the seller's WhatsApp.
- If Wave: confirmation page shows seller's Wave number + exact amount + "envoyez la capture dans la discussion".

### 4.5 Orders (bot + PWA)
- New order → seller notified via WhatsApp (utility template `nouvelle_commande`): number, items, total, buyer phone, zone, link to the order.
- `commandes` → today's open orders list.
- Statuses: `new → confirmed → shipping → delivered`, plus `cancelled` (from new/confirmed) and `returned` (from shipping/delivered). Cancel/return restocks.
- Payment status: `unpaid | paid_wave | paid_cash`.
- Status changes in PWA (one-tap buttons). Every change logged in `order_events`.
- Customers list builds automatically from orders (by phone).

### 4.6 Daily summary
- **21:00** template: orders of the day, revenue (delivered + paid), low-stock products (stock ≤ 2).

### 4.7 Auth
- No passwords, no SMS. Seller types `dashboard` (or `connexion`) to the bot → bot replies with a one-time signed link valid **10 min**, single use → opening it creates a session (httpOnly cookie).
- Because the seller initiates, the bot reply is a service message (inside the monthly free allowance).
- Implementation: **Better Auth** (Drizzle adapter, own Postgres) for sessions/cookies; a custom endpoint `/auth/wa?token=` verifies `login_tokens` (store hash only) and creates the session via Better Auth's internal adapter. If that proves awkward, fall back to a minimal custom `sessions` table + cookie. Decide in step 1, don't over-engineer.
- Admin: same flow, role flag on user.

### 4.8 Admin
- Shops list (status, trial end, orders count, last activity), mark subscription paid (amount, Wave reference, period), suspend/reactivate.
- Webhook/message error log view.

## 5. Out of v1 (do NOT build)

Multi-channel inbox (Instagram/FB DMs), resellers/affiliates, platform-held payments/escrow, payouts, courier integration, Orange Money API, staff UI, multiple shops UI, product recognition from photos, Wolof voice-note orders, public marketplace, native app.

## 6. v1.5 — Live selling orders (after v1 is in pilot)

- Read TikTok LIVE comments via **Euler Stream** WebSocket (unofficial, read-only, free tier 25 concurrent sockets). Never make the core depend on it.
- Buyer comments `PRENDS A12` → reservation for that TikTok username, 15 min, first come first served, stock held.
- Seller dashboard shows live demand board ("A12 : 7 demandes, 3 en stock").
- Seller shows QR / says "envoie A12 au bot". Buyer messages the bot (buyer-initiated = free window, clean opt-in) → bot asks TikTok username → matches reservation → asks zone + address step by step → order created.
- Unconfirmed reservations expire and release stock to the next in queue.
- **Never** collect phone numbers from public comments; never message buyers first.

## 7. Stack

- **Next.js** (App Router, TypeScript strict) as PWA (manifest + service worker, installable). Deployed as a **Render Web Service**.
- **Postgres on Render**. **Drizzle ORM** + `drizzle-kit` migrations.
- **Cloudflare R2** (S3 API) for product photos; resize to ~1080px + thumbnail with `sharp` on upload.
- **WhatsApp Cloud API** (Meta Graph API), one dedicated business number.
- **Better Auth** (see 4.7).
- **Render Cron Jobs** for scheduled tasks.
- Validation with **zod**. Tests with **vitest** (parsers and stock logic are mandatory test targets).
- Realtime on dashboard: polling every 10–15 s or SSE. No websocket infra in v1.

## 8. Data model (Drizzle, Postgres)

All tenant tables carry `shop_id`. **Every query on tenant data goes through a helper that enforces `shop_id` from the session** — no raw unscoped queries in route handlers.

```
users            id uuid pk, phone text unique (E.164), name text, is_admin bool default false, created_at
shops            id uuid pk, slug text unique, name text, wave_number text, status enum(trial|active|suspended),
                 trial_ends_at timestamptz, next_product_code int default 1, next_order_number int default 1, created_at
memberships      user_id fk, shop_id fk, role enum(owner|staff), pk(user_id, shop_id)
subscriptions    id uuid pk, shop_id fk, amount int (3000), period_start date, period_end date,
                 status enum(pending|paid), wave_ref text, paid_at timestamptz, created_at
delivery_zones   id uuid pk, shop_id fk, name text, fee int, is_active bool
products         id uuid pk, shop_id fk, code int, name text, description text, price int, photo_url text,
                 thumb_url text, is_active bool default true, created_at, updated_at, unique(shop_id, code)
product_variants id uuid pk, product_id fk, label text null (null = default variant), stock int not null check (stock >= 0),
                 unique(product_id, label)
customers        id uuid pk, shop_id fk, phone text, name text, last_zone_id fk null, last_address text,
                 created_at, unique(shop_id, phone)
orders           id uuid pk, shop_id fk, number int, customer_id fk, zone_id fk, address text,
                 subtotal int, delivery_fee int, total int,
                 payment_method enum(cod|wave), payment_status enum(unpaid|paid_wave|paid_cash),
                 status enum(new|confirmed|shipping|delivered|cancelled|returned),
                 source enum(link|bot|live), note text, created_at, updated_at, unique(shop_id, number)
order_items      id uuid pk, order_id fk, variant_id fk, product_name text (snapshot), variant_label text (snapshot),
                 unit_price int (snapshot), qty int check (qty > 0)
order_events     id uuid pk, order_id fk, from_status, to_status, by_user_id fk null, created_at
stock_movements  id uuid pk, variant_id fk, delta int, reason enum(order|cancel|return|manual|bot_update|create),
                 order_id fk null, by_user_id fk null, created_at
wa_conversations phone text pk, state text, context jsonb, updated_at        -- bot state machine
wa_messages      id uuid pk, wamid text unique, direction enum(in|out), phone text, type text,
                 payload jsonb, status text, error text, created_at          -- idempotency + audit
login_tokens     id uuid pk, user_id fk, token_hash text, expires_at, used_at null
(+ Better Auth tables: session, account, verification — its `user` table maps to `users`)
```

Per-shop sequential `code` and `number`: increment `shops.next_*` inside the same transaction (`UPDATE … RETURNING`).

## 9. WhatsApp integration

- `GET /api/whatsapp/webhook` → verify token handshake.
- `POST /api/whatsapp/webhook` → verify `X-Hub-Signature-256` with app secret, insert into `wa_messages` (skip if `wamid` exists = idempotent), return 200 fast, then process.
- Router: sender phone → membership → shop. No membership → onboarding flow. Otherwise dispatch on conversation `state` then on command keywords.
- Commands (case/accent-insensitive): `aide`, `stock`, `commandes`, `dashboard`/`connexion`, `résumé`, `lien` (resend catalog link). Photo messages → product create / photo replace.
- Media: download via Graph API media URL → `sharp` → R2.
- Outbound helper with typed functions per message type; log every send in `wa_messages`.
- **Templates to submit to Meta (French, category Utility):**
  - `nouvelle_commande` — new order alert with button "Voir la commande"
  - `rappel_stock` — 09:00 reminder
  - `resume_journee` — 21:00 summary
  - `abonnement_expire` — trial/subscription ending
- Pricing reality (since Oct 2026): service messages free up to 1 000/month/number, then billed; templates billed per message. Keep outbound templates to the 4 above.

## 10. Scheduled jobs (Render Cron, Africa/Dakar)

| Time | Job |
|---|---|
| 09:00 daily | `rappel_stock` to active/trial shops |
| 21:00 daily | `resume_journee` to shops with activity |
| 08:00 daily | trial/subscription expiry: J-3 reminder, suspend at expiry |

Jobs are idempotent (store last run per shop/day).

## 11. Suggested structure

```
/app
  /(public)/[slug]/page.tsx            catalog
  /(public)/[slug]/p/[code]/page.tsx   product
  /(public)/[slug]/checkout/page.tsx
  /(public)/[slug]/commande/[id]/page.tsx  confirmation
  /(seller)/dashboard/...              orders, products, customers, settings
  /(admin)/admin/...
  /api/whatsapp/webhook/route.ts
  /api/cron/[job]/route.ts             protected by CRON_SECRET
  /auth/wa/route.ts
/src
  /db/schema.ts, /db/index.ts, /db/scoped.ts   (shop-scoped query helpers)
  /bot/router.ts, /bot/flows/*.ts, /bot/parsers.ts
  /wa/client.ts, /wa/templates.ts
  /domain/orders.ts, /domain/stock.ts  (transactions, status transitions)
  /storage/r2.ts
/drizzle (migrations)
/tests (parsers, stock, order transitions)
```

## 12. Environment variables

```
DATABASE_URL
WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_APP_SECRET, WA_VERIFY_TOKEN, WA_BUSINESS_NUMBER
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL
BETTER_AUTH_SECRET, APP_URL
CRON_SECRET
PLATFORM_WAVE_NUMBER (for subscription payments)
```

## 13. Build order and acceptance criteria

1. **Foundations** — Next.js + Drizzle + Render Postgres + schema + migrations + seed (1 shop, 5 products, zones). Auth decision made. ✅ `drizzle-kit migrate` runs clean on Render.
2. **Parsers (TDD)** — product caption, variants, stock update, zones list. ✅ vitest covers valid, invalid, accents, extra spaces, `15 000` / `15000F`.
3. **Webhook + onboarding** — signature check, idempotency, onboarding flow. ✅ New number creates a shop and receives its link.
4. **Products + stock via bot** — photo → R2, create/replace, `stock` list and update. ✅ Every change produces a `stock_movements` row.
5. **Public catalog + checkout** — transactional order creation, wa.me redirect, Wave instructions. ✅ Two concurrent checkouts on the last unit: exactly one succeeds.
6. **Seller notifications + dashboard** — `nouvelle_commande` template, orders list, status buttons, payment status, restock on cancel. ✅ Status transitions outside the allowed graph are rejected.
7. **Login link** — `dashboard` command → 10-min single-use link. ✅ Reused or expired token rejected.
8. **Cron jobs + admin** — reminders, summary, expiry/suspension, admin subscriptions. ✅ Suspended shop catalog shows unavailable page.
9. **PWA polish + pilot** — manifest, install prompt, mobile-first check on low-end Android, 3 pilot sellers.

## 14. Prerequisites outside the code (start now)

- Meta Business verification + dedicated WhatsApp number + Cloud API app; submit the 4 templates early (approval delay).
- Domain name; Cloudflare R2 bucket; Render account (web service, Postgres, cron).
- 10 seller interviews (Instagram shops, WhatsApp Status sellers, Sandaga/HLM) — not only from close circle.

## 15. Success test (8 weeks of pilot)

10 sellers paying 3 000 FCFA after their free month, with ≥ 60 % of their orders going through the tool in week 4.

## 16. Open items

- Product name + domain.
- Staff seats / multi-shop pricing (model ready, UI later).
