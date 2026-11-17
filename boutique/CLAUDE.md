# CLAUDE.md — Boutique (WhatsApp order & stock tool)

The product spec is **[SPEC.md](./SPEC.md)**. Read it before any change; build in the order of SPEC §13 and do not build anything listed in SPEC §5 ("Out of v1").

This app lives in `boutique/` (the repo root holds an unrelated app, PM Cockpit). Run every command from `boutique/`.

## Commands

```bash
npm run dev           # Next.js dev server
npm run typecheck     # tsc --noEmit (must pass)
npm test              # vitest; DB tests run when DATABASE_URL is set, else skipped
npm run db:generate   # after editing src/db/schema.ts → new SQL file in drizzle/
npm run db:migrate    # apply migrations (Render runs it as preDeployCommand)
npm run db:seed       # dev data: shop `demo`, owner +221770000001, 5 products, 3 zones
```

Never hand-edit an applied migration; change `schema.ts` and generate a new one. Commit the generated SQL and `drizzle/meta`.

## Conventions (non-negotiable)

- **TypeScript strict** (`strict`, `noUncheckedIndexedAccess`). No `any`; validate every external input (webhooks, forms, query params, bot text) with **zod** before use.
- **French UI.** Every user-facing string (pages, bot replies, error messages shown to sellers/buyers) is in French. Code, identifiers, comments and commit messages may be in English.
- **Money = XOF integers.** `integer` columns, `number` in TS, never floats or decimals, never cents. Format for display only (`15 000 FCFA`, narrow no-break space). Totals are computed server-side; never trust a client-sent price or total.
- **Phones = E.164** (`+2217XXXXXXXX`) everywhere they are stored or compared. Normalize at the boundary (bot sender, checkout form) with the shared phone helper; DB CHECK constraints reject anything else. `wa.me` links use the number without `+`.
- **Time:** store `timestamptz` (UTC); compute "today", cron days and display in `Africa/Dakar`.
- **Shop-scoped queries only.** Tenant data is read and written exclusively through `shopScope(shopId)` from `src/db/scoped.ts`, with `shopId` coming from the session (dashboard) or the sender's membership (bot) — never from a request body or URL param. No raw unscoped queries in route handlers or bot flows. Child tables without `shop_id` (`product_variants`, `order_items`, `order_events`, `stock_movements`) are reached only by joining a scoped parent. Public catalog pages resolve the shop by slug once, then use its scope.
- **Stock invariants:** every stock change writes a `stock_movements` row in the same transaction. Order creation locks variants with `SELECT … FOR UPDATE`, checks, decrements, and inserts order + items + movements in one transaction. `stock >= 0` is also enforced by the DB.
- **Per-shop sequences** (`products.code`, `orders.number`) come from `nextProductCode` / `nextOrderNumber` (`src/db/sequences.ts`), called inside the inserting transaction.
- **Order status changes** go through the transition graph in `src/domain/orders.ts` and log `order_events`. Cancel/return restocks.
- **WhatsApp:** verify `X-Hub-Signature-256`, dedupe on `wamid`, log every in/out message in `wa_messages`. Only the 4 templates in SPEC §9; everything else is a reply inside the 24 h window.
- **Tests (vitest):** parsers, stock logic and order transitions are mandatory test targets. Write parser tests first.
- Secrets only via env vars (see `.env.example`); never log tokens, never store raw login/session tokens (SHA-256 hash only).

## Decisions

- **Auth (SPEC §4.7): custom minimal sessions, not Better Auth.** Login link token → `login_tokens` (hash, 10 min, single use, consumed with an atomic `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`) → `sessions` row (hash of a random 32-byte token) → httpOnly, Secure, SameSite=Lax cookie. Better Auth *can* do it cleanly (a small plugin calling `internalAdapter.createSession` + `setSessionCookie`, exactly like its magic-link plugin), but its core user model requires `email`/`emailVerified`/`image`, plus `account`/`verification` tables we would never use; we'd be faking emails for phone-only users. Env var is `AUTH_SECRET` (replaces `BETTER_AUTH_SECRET` from SPEC §12).
- DB driver: `pg` (node-postgres) + `drizzle-orm/node-postgres`.
- Cron idempotency: `job_runs (job, shop_id, run_date)` primary key; insert-or-skip before sending.

## Layout

```
app/                     Next.js App Router (routes per SPEC §11)
src/db/schema.ts         Drizzle schema (source of truth for migrations)
src/db/index.ts          db + pool
src/db/scoped.ts         shopScope() — the only way to touch tenant tables
src/db/sequences.ts      per-shop code / order number
src/db/seed.ts           dev seed
drizzle/                 generated SQL migrations
tests/                   vitest (*.db.test.ts need a database)
```
