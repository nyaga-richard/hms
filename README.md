# HMS — Hotel Management, PMS, POS, Inventory & Accounting ERP

An integrated, multi-property hotel ERP: front office (PMS), housekeeping & maintenance, restaurants / bars /
clubs / room service (POS + kitchen display), events & banquets, spa & services, laundry, inventory with an
immutable stock ledger, procurement (requisition → PO → GRN → invoice → payment), expenses & petty cash,
cashier shifts, full double-entry accounting with automatic journals, night audit, reporting, notifications,
approvals, audit trail and configurable role-based access control.

> **Core philosophy** — *Master Data → Request → Approval → Transaction → Inventory / Operational Effect →
> Financial Effect → Ledger → Reporting → Audit Trail.* Every operational action (a check-out, a bar sale, a
> goods receipt, a stock adjustment) produces its inventory and accounting effects automatically and
> atomically. Ledgers are append-only; corrections are reversals, never edits.

---

## Contents

1. [Architecture](#1-architecture)
2. [Quick start](#2-quick-start)
3. [Demo logins](#3-demo-logins)
4. [Module map](#4-module-map)
5. [End-to-end demo workflows](#5-end-to-end-demo-workflows)
6. [API layout](#6-api-layout)
7. [Configuration (environment variables)](#7-configuration)
8. [Testing](#8-testing)
9. [Deployment](#9-deployment)
10. [Backups & restore](#10-backups--restore)
11. [Security model](#11-security-model)
12. [Data integrity rules](#12-data-integrity-rules)
13. [Repository layout](#13-repository-layout)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Architecture

```
 Browser (desktop / tablet / phone, light & dark, installable PWA)
    │  same-origin  /api/*  and  /uploads/*
    ▼
 Next.js 14 (App Router, React 18, TypeScript, Tailwind, shadcn/ui, Lucide, TanStack Query)
    │  rewrite / nginx proxy
    ▼
 Express + TypeScript REST API  (zod validation, permission middleware, transactional services)
    │  node-postgres, one transaction per business action
    ▼
 PostgreSQL 17  (134 tables, 10 versioned SQL migrations, triggers that make ledgers immutable)
```

| Layer | Key points |
|---|---|
| **Frontend** `frontend/` | 74 routes under `src/app/(app)/*`; shared `ResourcePage`/`DataTable`/`FormDialog` building blocks; wizard-style flows for check-in, check-out, POS settlement, GRN, stocktake; permission-aware navigation and dashboards; global search (`⌘K`); notifications; offline-tolerant POS with idempotency keys; barcode/QR support for stocktakes & assets. |
| **Backend** `backend/` | Modules: `auth`, `admin` (users/roles/permissions), `platform` (properties, settings, workflows, approvals, audit, notifications, imports, backups, reports, assets), `pms`, `ops` (housekeeping, laundry, maintenance), `fnb` (outlets, menus, POS, kitchen, shifts, clubs), `inventory`, `procurement`, `finance` (COA, journals, periods, payments, AR/AP, expenses, petty cash, night audit), `events`, `workflow`. Every route declares the permission it requires. |
| **Database** `backend/src/db` | `migrate.ts` applies `migrations/NNN_*.sql` once each in order (tracked in `schema_migrations`). `bootstrap.ts` syncs the permission catalogue (144 permissions / 42 modules). `seed.ts` creates the idempotent demo dataset — it **never deletes or overwrites production rows**. |

Multi-property: every transactional table carries `property_id`; the active property is sent as the
`X-Property-Id` header (defaults to the user's default property) and users can be restricted to properties.

---

## 2. Quick start

### Option A — Docker (recommended)

```bash
git clone <repo> hms && cd hms
cp .env.example .env                 # edit POSTGRES_PASSWORD / JWT_SECRET / SESSION_SECRET at least
docker compose up --build            # postgres + backend (tsx watch) + frontend (next dev)
# first run only — demo data (roles, Demo Hotel, rooms, outlets, menus, products, opening stock…)
docker compose exec backend npm run seed -w backend
```

Open **http://localhost:3000** and log in as `admin` / `Password123`.

### Option B — Local Node + PostgreSQL

Requirements: Node 20+, PostgreSQL 15+ (17 recommended).

```bash
cp .env.example .env
# create role + databases (adjust to your local PostgreSQL)
psql -U postgres -c "CREATE ROLE hms LOGIN PASSWORD 'hms_dev_password'"
psql -U postgres -c "CREATE DATABASE hms OWNER hms" -c "CREATE DATABASE hms_test OWNER hms"
# point DATABASE_URL / DATABASE_URL_TEST in .env (and backend/.env) at 127.0.0.1
npm install
npm run migrate && npm run seed
npm run dev:backend        # http://localhost:4000/api/health
npm run dev:frontend       # http://localhost:3000  (proxies /api to :4000)
```

For throw-away sandboxes, `scripts/dev-up.sh` does all of the above in one go: it installs PostgreSQL 17 if
missing, runs a private cluster under `.cache/pgdata` (git-ignored), creates `hms`/`hms_test`, restores
`data/dev-snapshot.dump` when present (otherwise `migrate` + `seed`) and installs dependencies.
`scripts/dev-snapshot.sh` refreshes that compact dump; `scripts/dev-pg.sh start|stop|status` controls the cluster.

### Production

See [Deployment](#9-deployment): `docker compose -f docker-compose.prod.yml up -d --build`.

---

## 3. Demo logins

All demo users share the password **`Password123`** — change them (or disable the demo users) before going live; *Settings → Users → Reset password* forces a change at next login.

| Username | Role | Typical use |
|---|---|---|
| `admin` | SUPER_ADMIN | everything, settings, roles, workflows, backups |
| `gm` | GENERAL_MANAGER | management dashboards, high-value approvals |
| `fom` | FRONT_OFFICE_MANAGER | reservations, rates, folio reversals, overbooking |
| `reception` | RECEPTIONIST | reservations, check-in / check-out, folios, payments |
| `hkmanager` / `housekeeper` | HOUSEKEEPING_MANAGER / HOUSEKEEPER | room status board, tasks, inspections, laundry |
| `restaurant` / `waiter` | RESTAURANT_MANAGER / WAITER | POS orders, table map, discounts, settlement |
| `barmanager` / `bartender` | BAR_MANAGER / BARTENDER | bar POS, recipe-based stock consumption |
| `chef` | CHEF | kitchen display, recipes, kitchen requisitions |
| `storekeeper` | STOREKEEPER | stores, issues, transfers, stocktakes, GRNs |
| `purchasing` | PURCHASING_OFFICER | purchase requisitions, quotations, POs, supplier invoices |
| `accountant` | ACCOUNTS_MANAGER | journals, periods, AR/AP, expenses, night audit, approvals |
| `cashier` | CASHIER | shifts, payments, ticket sales |
| `maintenance` / `technician` | MAINTENANCE_MANAGER / MAINTENANCE_TECHNICIAN | work orders, assets, preventive maintenance |
| `auditor` | AUDITOR | read-only across finance, inventory and the audit trail |

Roles are **data**, not code: Settings → Roles lets you clone/edit any role, grant per-permission overrides
per user (ALLOW/DENY) and set authority limits (discount %, void amount, purchase approval, cash variance…).

---

## 4. Module map

| Area | Screens (frontend) | What it does |
|---|---|---|
| Dashboard | `/` | Role-aware KPIs: occupancy, ADR, RevPAR, arrivals/departures, in-house, revenue by outlet, open orders, pending approvals, low stock, unpaid invoices, cash position. |
| Front office | `/front-office/*` | Guests & CRM, reservations (calendar, availability, no double-booking, overbooking permission, groups, deposits), check-in wizard (walk-ins, registration card, deposit, dirty-room override), in-house list, folios (ledger style, transfers, splits, reversals), check-out wizard (preview, settle, refund, invoice), rooms & room items, rate plans & packages, room blocks. |
| Housekeeping | `/housekeeping/*` | Room status board (Clean/Dirty/Inspected/OOO), auto-generated checkout/stay-over tasks, assignment, mobile task flow, inspections, minibar/room-item events, lost & found notes. Laundry orders (guest & house) with status history. |
| Maintenance & assets | `/maintenance/*` | Requests → work orders, parts issued from engineering store, room out-of-order blocking, preventive schedules, asset register with movements and depreciation categories. |
| POS / F&B | `/pos/*` | Outlet selection (restaurants, bars, clubs, room service, coffee shop), table map & sections, order taking with modifiers/courses/seat numbers, kitchen/bar display (KDS) tickets, discounts within limits, bill, split/merge/transfer, settle (cash, card, M-Pesa, room charge to folio, corporate credit, complimentary), refunds, receipts, cashier shifts with expected-vs-actual cash and variance approval. Every sale consumes stock via recipes (bars) or direct product links and posts revenue, tax, service charge and COGS journals. |
| Clubs & events | `/clubs/*`, `/events/*` | Club events, ticket types & QR tickets, guest lists, door check-in; banquets/conferences with venues, quotes, BEOs (event items), deposits, invoices, and automatic venue clean-up tasks. |
| Services & spa | `/services/*` | Service catalogue, resources (therapists, rooms), bookings charged to folio or paid directly. |
| Inventory | `/inventory/*` | Products/units/categories, multi-store stock, stock ledger (append-only), requisitions & issues, transfers (dispatch/receive), adjustments & waste with approval, blind stocktakes with variance posting, recipes & costing, valuation, expiry tracking, low-stock alerts. |
| Procurement | `/procurement/*` | Suppliers, purchase requisitions (workflow approval), quotations & comparison, purchase orders (approval limits, SoD), goods received notes (partial, rejected/damaged, expiry), supplier invoices (3-way match with tolerance), AP aging, supplier payment requests & approvals. |
| Finance | `/finance/*` | Configurable chart of accounts & account mappings, taxes (inclusive/exclusive), payment methods, currencies & rates, accounting periods (close/lock/reopen), manual & automatic journals with reversals, trial balance, P&L, balance sheet, tax report, payments & receipts, customers/AR aging & receipts/credit notes, expenses (receipt rules, workflow), petty cash funds & reconciliation, business days & night audit (posts room charges, closes the day, rolls the business date). |
| HR / staff | `/hr/*` | Departments, employees, shift templates and rosters. |
| Approvals & notifications | `/approvals`, bell menu | Unified inbox for workflow steps (PR, PO, expense, waste, adjustment, credit note, supplier payment…), act with comments; in-app notifications routed by permission or user. |
| Reports | `/reports` | 28 filterable reports — daily revenue, manager flash, occupancy forecast, arrivals/departures/in-house, guest ledger & history, housekeeping status & productivity, maintenance log, POS sales, menu-item sales, voids & discounts, cashier shifts, payments, stock valuation/movements/consumption/waste, purchases, AP & AR aging, expenses, tax summary, events pipeline, staff attendance, audit trail — each exportable to CSV / Excel / PDF. |
| Settings | `/settings/*` | Hotel/company & properties, numbering formats, general settings (service charge, tax mode, checkout rules), users, roles & permissions, approval workflows, audit log, CSV imports (guests, products, suppliers, rooms, accounts…), backups. |

---

## 5. End-to-end demo workflows

The seed lets you walk every acceptance scenario without setup:

1. **Guest lifecycle** — `reception`: create a reservation (Front office → Reservations → New) for a
   Standard room, then *Check in* (assign 101, take a deposit), post a minibar charge on the folio, then
   *Check out*: the wizard shows nights + charges, settles by cash/card/M-Pesa, prints the invoice, room 101
   becomes **Dirty** and a *Checkout clean* task appears on the housekeeping board (`housekeeper` marks it
   clean → `hkmanager` inspects). Attempting to check a new guest into 101 before that is blocked.
2. **Restaurant** — `waiter`: open a shift (POS → Shifts), pick *Main Restaurant*, open table T3, add
   *Chicken Burger* + *Cappuccino*, *Send* (visible on the kitchen display for `chef`), bill, settle as
   *Room charge* to an in-house guest → the charge is on the guest folio; or settle in cash and close the
   shift with actual cash counted (variance needs a reason / approval).
3. **Bar with recipes** — `bartender`: Rooftop Bar, sell a *Gin & Tonic* → 50 ml gin, a tonic and lime are
   consumed from the Rooftop Bar store via the stock ledger, COGS is posted automatically.
4. **Kitchen requisition & waste** — `chef` raises a requisition from the Food Store to the Kitchen;
   `storekeeper` approves & issues (paired transfer movements). Record spoilage as *Waste*; the
   `accountant`/`gm` approves it from the Approvals inbox and the waste expense journal posts.
5. **Procure-to-pay** — `purchasing` raises a purchase requisition for cooking oil (approved by the
   storekeeper per the seeded workflow) → PO (approved by `accountant`; > 500k needs the GM too) →
   `storekeeper` receives the GRN (stock in, GRNI/AP accrued) → `purchasing` records the supplier invoice
   (quantities matched to GRN, price tolerance 2 %) → `accountant` raises & approves a supplier payment →
   AP aging clears.
6. **Stocktake** — `storekeeper` opens a blind stocktake for the Housekeeping Store, counts (barcode or
   list), submits; `accountant` reviews variances and approves → adjustment + journal posted.
7. **Finance close** — `accountant`: run *Night audit* (posts room charges for all in-house stays, blocks
   if shifts or orders are still open, rolls the business date), review trial balance / P&L, reverse a
   wrong journal (original stays, marked REVERSED), close the accounting period (posting into it is then
   refused until reopened).
8. **Management** — `gm`: dashboards, approvals over limits, reports export (Excel/PDF), audit trail of
   who did what, when, from where.

---

## 6. API layout

Base URL `/api`, JSON, bearer token from `POST /api/auth/login`. Lists support
`?page&pageSize&sort&order&search&<filters>` and `?format=csv` where an export is defined.
Errors are `{ "error": { "code", "message", "details?" } }` with stable codes
(`FORBIDDEN`, `VALIDATION_ERROR`, `RESERVATION_CONFLICT`, `ROOM_DIRTY`, `BALANCE_OUTSTANDING`,
`CLOSED_SHIFT`, `CLOSED_PERIOD`, `UNBALANCED`, `DUPLICATE_TRANSACTION`, …).

| Prefix | Resources |
|---|---|
| `/auth` | `login`, `logout`, `me`, `change-password` |
| `/users` `/roles` `/permissions` | user & role management, overrides, authority limits, login history |
| `/properties` `/companies` `/departments` `/employees` `/shift-templates` `/staff-shifts` | organisation & HR |
| `/settings` `/settings/numbering` `/workflows` `/approvals` `/audit` `/notifications` `/imports` `/backups` `/system` `/search` `/attachments` | platform |
| `/guests` `/room-types` `/rooms` `/rate-plans` `/reservations` `/checkins` `/stays` `/checkouts` `/folios` `/invoices` `/room-item-types` `/room-items` | PMS |
| `/housekeeping/rooms` `/housekeeping/tasks` `/laundry` `/laundry-services` `/maintenance` `/asset-categories` `/assets` | operations |
| `/outlets` `/restaurants` `/bars` `/clubs` `/kitchens` `/tables` `/sections` `/pos-terminals` `/menus` (`/menus/for-outlet/:id`) `/menu-categories` `/menu-items` `/orders` `/kitchen/tickets` `/shifts` `/club-events` | F&B / POS |
| `/units` `/product-categories` `/products` `/stores` `/stock` (`/ledger`, `/valuation`, `/expiry`, `/issue`) `/requisitions` `/stock-transfers` `/stock-adjustments` `/stocktakes` `/recipes` | inventory |
| `/suppliers` `/purchase-requisitions` `/quotations` `/purchase-orders` `/grns` `/supplier-invoices` (`/aging`) `/supplier-payments` | procurement |
| `/accounts` `/account-mappings` `/taxes` `/payment-methods` `/currencies` `/accounting-periods` `/journals` (`/trial-balance`, `/profit-loss`, `/balance-sheet`, `/tax-report`, `/:id/reverse`) `/payments` `/customers` `/receivables` `/party-ledger` `/expense-categories` `/expenses` `/petty-cash` `/business-days` (`/night-audit/preview|run`) | finance |
| `/venues` `/events` `/services` `/service-resources` `/service-bookings` | events & services |
| `/dashboard` `/reports/:code` | KPIs and exports (`?format=xlsx|pdf|csv`) |

State-changing endpoints accept an `idempotency_key` where a retry could double-post (payments,
settlements, folio postings) — retries return `DUPLICATE_TRANSACTION` instead of a second posting.

---

## 7. Configuration

All configuration is via environment variables; copy `.env.example` → `.env` (never commit `.env`).

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `DATABASE_URL_TEST` | PostgreSQL connection strings (test DB name must contain `test`) |
| `JWT_SECRET`, `SESSION_SECRET`, `SESSION_TTL_MINUTES` | session security (sessions are stored server-side and revocable) |
| `BCRYPT_ROUNDS`, `MAX_FAILED_LOGINS`, `LOCKOUT_MINUTES` | password hashing & brute-force lockout |
| `PORT`, `NODE_ENV`, `CORS_ORIGINS` | backend runtime (`production` hides stack traces & enables strict rate limits) |
| `STORAGE_PATH`, `UPLOAD_MAX_SIZE`, `BACKUP_PATH` | attachments & backup folders (Docker volumes `uploads`, `backups`) |
| `NEXT_PUBLIC_API_URL`, `BACKEND_INTERNAL_URL` | frontend → backend proxy target (`http://backend:4000` in Docker) |
| `DEFAULT_CURRENCY`, `DEFAULT_TIMEZONE`, `DEFAULT_LOCALE` | defaults for new properties (multi-currency & i18n ready) |
| `SMTP_*` | optional e-mail notifications |
| `POSTGRES_PASSWORD`, `HTTP_PORT`, `CLOUDFLARE_TUNNEL_TOKEN`, `BACKUP_CRON`, `BACKUP_KEEP_DAYS` | docker-compose only |

Business configuration (service charge %, tax mode, document numbering — prefix, padding, yearly reset, e.g. `RES-2026-000123`,
check-out balance rules, overbooking, discount/void limits, approval workflows, chart of accounts and
account mappings) lives in the database and is edited under **Settings** — no redeploy needed.

---

## 8. Testing

Integration tests (Vitest + Supertest) exercise the real Express app against a **dedicated test
database** that is dropped and rebuilt (migrations + permission bootstrap + seed) before every run.

```bash
npm test                       # from the repo root (== npm test -w backend)
cd backend && npx vitest       # watch mode
```

| Suite | Covers |
|---|---|
| `auth.test.ts` | login, token protection on every route, logout/session revocation, account lockout |
| `rbac.test.ts` | backend permission enforcement, data-driven roles taking effect immediately, per-user DENY overrides |
| `reservations.test.ts` | reservation validation, **no double-booking**, check-in, folio charges/payments, reversal instead of delete, checkout blocked by balance, invoice + dirty room + housekeeping task, dirty-room check-in guard, balanced journals |
| `pos.test.ts` | shift required, shift lifecycle, order → send → settle, idempotent settlement, recipe/product stock consumption via the ledger, revenue + COGS journals, cash variance rules |
| `inventory.test.ts` | requisition → issue (paired transfer movements), adjustments with approval & segregation of duties, blind stocktake → variance posting, **DB-level immutability** of stock movements and journals |
| `procurement.test.ts` | PR workflow approval, PO approval by finance, GRN stock + AP accrual, 3-way matched supplier invoice, AP aging, duplicate invoice guard |
| `accounting.test.ts` | unbalanced journal rejection, manual journals, reversal semantics, trial balance, closed-period control, COA as data |

The global setup refuses to run unless the target database name contains `test`, so it can never wipe a
production database.

Other checks: `npm run typecheck -w backend`, `npm run typecheck -w frontend`, `npm run lint -w frontend`,
`npm run build -w frontend`.

---

## 9. Deployment

### docker-compose.prod.yml

```bash
cp .env.example .env            # strong POSTGRES_PASSWORD, JWT_SECRET, SESSION_SECRET; CORS_ORIGINS=https://your.domain
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f backend      # "HMS backend listening on :4000 (production)"
docker compose -f docker-compose.prod.yml exec backend npm run seed:prod   # optional demo data
```

* `postgres` — PostgreSQL 17 with the `pgdata` volume (not published to the host).
* `backend` — multi-stage image (`backend/Dockerfile`); applies pending migrations and syncs permissions on
  every start; volumes `uploads` and `backups`; healthcheck on `/api/health`.
* `frontend` — Next.js standalone image (`frontend/Dockerfile`); the `/api` rewrite target is baked at build
  time from the `BACKEND_INTERNAL_URL` build arg (defaults to `http://backend:4000`).
* `nginx` — single entry point on `HTTP_PORT` (80): `/api` and `/uploads` → backend, everything else →
  frontend, long cache for `/_next/static`, 25 MB uploads.
* `cloudflared` (`--profile tunnel`) — publishes the stack over HTTPS through a Cloudflare Tunnel using
  `CLOUDFLARE_TUNNEL_TOKEN`; point the tunnel's public hostname at `http://nginx:80`. No inbound ports needed.
* `db-backup` (`--profile backup`) — cron-driven `pg_dump -Fc` into the `backups` volume with retention.

Terminate TLS at Cloudflare / your load balancer, or add a 443 server block to `deploy/nginx/hms.conf`.

Zero-downtime-ish upgrade: `git pull && docker compose -f docker-compose.prod.yml up -d --build` — migrations
are additive and run automatically before the new backend accepts traffic.

### Bare metal / PaaS

`npm ci && npm run build -w backend && npm run build -w frontend`, then run `node backend/dist/server.js`
and `node frontend/.next/standalone/frontend/server.js` behind any reverse proxy. Set `NODE_ENV=production`.

---

## 10. Backups & restore

* **In-app**: Settings → Backups → *Create backup* runs `pg_dump` into `BACKUP_PATH`, lists and verifies
  files and lets authorised users download them (permission `settings.backup`, fully audited).
* **Scheduled**: enable the `backup` profile (`docker compose -f docker-compose.prod.yml --profile backup up -d`).
  Files: `hms-YYYYMMDD-HHMMSS.dump` in the `backups` volume; copy them off-site (rclone/S3/…).
* **Restore** (to an empty database):

  ```bash
  docker compose -f docker-compose.prod.yml stop backend frontend
  docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U hms -d hms --clean --if-exists < backups/hms-YYYYMMDD-HHMMSS.dump
  docker compose -f docker-compose.prod.yml start backend frontend
  ```

  Attachments live in the `uploads` volume — back it up alongside the database.

---

## 11. Security model

* **Authentication** — bcrypt-hashed passwords, server-side sessions (revocable, TTL), login history with IP
  and device, lockout after `MAX_FAILED_LOGINS`, forced password change flag, rate limiting on `/api` and on
  the login endpoint (`express-rate-limit`), Helmet headers, CORS allow-list.
* **Authorisation** — every backend route declares `requirePermission(...)`; the UI only *hides* what a user
  cannot do, the backend *enforces* it. Roles → permissions are editable data; per-user ALLOW/DENY
  overrides; authority limits (discount %, void amount, purchase approval, refund, cash variance); property
  and outlet scoping; segregation-of-duties checks (you cannot approve your own PO/adjustment/stocktake).
* **Input validation** — zod schemas on every payload; parameterised SQL everywhere.
* **Auditability** — `audit_logs` records who/what/when/old→new for every create/update/approve/reverse,
  including reasons; reservation, event, laundry and maintenance histories; login history.
* **Production hygiene** — no stack traces in responses when `NODE_ENV=production`, secrets only via env,
  uploads served through the authenticated `/uploads` route, backups permission-gated, non-root containers.

---

## 12. Data integrity rules

* **No double-booking**: room/date overlap is checked inside the reservation transaction with row locks;
  overbooking requires the `reservations.overbook` permission and is flagged.
* **Folios & journals are append-only**: `journal_entries`/`journal_lines` and `stock_movements` have
  database triggers that reject `UPDATE`/`DELETE`; wrong postings are reversed with a linked contra entry.
* **Balanced by construction**: `postJournal` refuses unbalanced entries and postings into closed periods;
  every operational transaction (folio payment, POS settlement, GRN, supplier invoice, expense, waste,
  adjustment, night audit) posts through it in the *same* database transaction as the operational change.
* **Stock balances are derived from the ledger**: every movement records quantity, unit cost, running
  balance, reference type/number, business date and user; valuation is weighted-average.
* **Configurable numbering** per document type (`RES`, `INV`, `RCT`, `PO`, `GRN`, `JE`, …) with prefix,
  padding and optional yearly reset, allocated per property inside the transaction (Settings → Numbering).
* **Business date** is separate from calendar date; night audit closes the day, posts room charges, and
  blocks when cashier shifts or orders are still open.
* **Seed is safe**: `npm run seed` only inserts missing demo rows (`ON CONFLICT DO NOTHING` / existence
  checks) and never touches live data.

---

## 13. Repository layout

```
.
├── backend/                 Express + TypeScript API
│   ├── src/app.ts           app factory (used by server and tests)
│   ├── src/server.ts        boot: migrations → permission bootstrap → listen
│   ├── src/core/            errors, crud/listing helpers, numbering, permissions, audit, notify, settings
│   ├── src/middleware/      auth (bearer + property context), error handler
│   ├── src/modules/         auth, admin, platform, pms, ops, fnb, inventory, procurement, finance, events, workflow
│   ├── src/db/              pool, migrate, bootstrap, seed, migrations/*.sql
│   ├── tests/               vitest + supertest integration suites (see §8)
│   └── Dockerfile
├── frontend/                Next.js 14 app (src/app/(app)/<module>/…, src/components, src/lib)
│   └── Dockerfile
├── deploy/                  nginx config, backup script, postgres init (test DB)
├── scripts/                 dev-up.sh / dev-pg.sh / dev-snapshot.sh (local PostgreSQL helpers)
├── data/                    dev-snapshot.dump — compact pg_dump used by dev-up.sh (optional)
├── docker-compose.yml       development stack (hot reload)
├── docker-compose.prod.yml  production stack (nginx, optional cloudflared & backups)
├── .env.example             every supported variable, documented
└── README.md
```

---

## 14. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing required environment variable DATABASE_URL` | copy `.env.example` to `.env` (backend reads `<cwd>/.env`; compose injects variables directly) |
| Login returns 429 | login rate limit hit — wait a minute (limits are relaxed outside `production`) |
| `ACCOUNT_LOCKED` | too many failed logins; wait `LOCKOUT_MINUTES` or have an admin reset the password (Settings → Users), which also clears the lock |
| Checkout says `BALANCE_OUTSTANDING` | settle the folio, or check out *with balance* (transfers it to receivables; needs `receivables.manage`) |
| Night audit refuses to run | close all cashier shifts and open POS orders first (it lists them) |
| POS says `CLOSED_SHIFT` | open a cashier shift for your user before creating orders |
| Frontend cannot reach the API in Docker | rebuild the frontend image with the right `BACKEND_INTERNAL_URL` build arg (default `http://backend:4000`) |
| Tests refuse to start | `DATABASE_URL_TEST` must point at a database whose name contains `test` (e.g. `hms_test`) |

---

Built with Next.js 14, React 18, TypeScript, Tailwind CSS, shadcn/ui, Lucide, TanStack Query, Express,
zod, node-postgres, ExcelJS, PDFKit, Vitest, Supertest and PostgreSQL 17.
