# SK Keong pricing app

Internal web app for SK Keong Trading Sdn. Bhd.: the product list with cost, target margin and tier
prices for the owner and finance; price lookup, visit prep and competitor-price capture for the
salespeople, on a phone, offline. Built to `docs/DATA_SPEC.md`.

## Run it

Requires Node 22.13+ (uses the built-in SQLite; there are **no npm dependencies**).

```bash
cd pricing-app
npm run seed:sample     # synthetic data so you can click around (see data/sample/README.md)
npm start               # http://localhost:3000
```

First start creates user `owner` with password `changeme` (or `ADMIN_PASSWORD` from the environment)
and forces a password change at first login. Importing `seed_customers.csv` creates a `salesperson`
login for every distinct salesperson code (username = code in lower case, password `sk1234`, must
change on first login). Finance and extra users are added by the owner under 设置 / Settings.

Real data: copy the four seed CSVs into `data/seed/` (git-ignored) and run `npm run seed`. The
command prints what changed per file and whether the FY sales total reconciles to RM 27,521,859.
Re-running is safe. See `data/seed/README.md` and `docs/IMPORT.md` for the column mapping.

```bash
npm test                # node --test: money, CSV, importer idempotence, API/acceptance criteria
npm run import:check -- path/to/file.csv [kind]   # dry run: shows detected column mapping
```

Environment: `PORT` (3000), `HOST`, `DB_PATH` (default `data/pricing.sqlite`), `ADMIN_PASSWORD`,
`SECURE_COOKIES=1` when served over HTTPS (do this in production), `LOG=1` for request logging.

## Hosting

**Option A, Netlify (no server to run).** `netlify.toml`, `netlify/functions/api` and `scripts/prepare-netlify.mjs`
deploy the same code as one serverless function running SQLite in WebAssembly (`sql.js`), with the
database file persisted in Netlify Blobs. Static files are served from `public/`. Set up once in the
Netlify UI: *Add new project → Import an existing project → GitHub → this repository*, **base directory
`pricing-app`**, keep the detected build command (`npm run build:netlify`) and publish directory
(`public`), and add environment variables `ADMIN_PASSWORD` (first owner password) and, for a demo,
`SEED_SAMPLE=1` (loads the synthetic sample on first start). Every push to the chosen branch then
deploys. Notes:

- Writes are serialised with a short lock and the whole database file is written back after each
  change. That is fine for ~10 internal users; it is not a high-concurrency design. If the lock
  expires mid-request (15 s) a concurrent write can be lost, so treat this as pilot hosting and move
  to Option B (or Postgres) before it becomes the system of record for many users.
- To go from sample data to real data: log in as owner, 设置 → 清空业务数据 (Reset business data),
  then import the four CSVs on the 导入 page. Unset `SEED_SAMPLE` afterwards.
- `npm test` covers this runtime against an in-memory fake of the blob store (`test/netlify.test.js`).

**Option B, your own Node process.** Anything that runs Node 22 with a persistent disk: a small VPS
behind Caddy/nginx (for HTTPS, which the PWA needs to install and to run its service worker), or the
`Dockerfile` with a volume at `/data`. Back up the single file `pricing.sqlite`. No npm install is
needed for this option.

## Screens and milestones

| Milestone | Screen | Where |
|---|---|---|
| M1 | 单位核对 UOM reconciliation with progress against the core SKUs | `#/uom` (finance, owner) |
| M2 | 产品与价格 cost, target margin, tier list/floor, bulk edit by category, full price history and audit | `#/products` |
| M3 | 价格查询 Price lookup, offline, list and floor for the customer's tier | `#/lookup` (phone) |
| M4 | 记录竞争价 Capture: customer → SKU → number → save; queued offline, synced silently | `#/capture` (phone) |
| M5 | 拜访准备 Visit prep: type, regular items, gaps vs peers, bundles, opening question | `#/visit` (phone) |
| M6 | 价格情报 Intelligence: our price vs captured competitor prices vs market reference, per SKU over time; flags SKUs priced above every competitor price seen | `#/intel` |
| M7 | Market reference entry for branded SKUs (manual, always with source URL and date) | inside `#/intel`; no scheduled lookup yet |
| — | 导入 Import / update with dry-run mapping preview, idempotent commit, reconciliation total | `#/import` |
| — | 设置 Tiers, tier rules (customer type × size), customer tier overrides, users, cost-visibility switch, audit log, CSV exports | `#/admin` (owner; finance without users/settings) |

## Rules the code enforces

- **Salespeople never receive cost or margin.** Every JSON response for a user who cannot see cost is
  passed through `server/redact.js`, which strips any key matching cost / margin / purchase / UOM
  factor, whatever route produced it. Exports and management routes are role-gated on top of that.
  The owner can reverse the decision with one setting (`salesperson_can_see_cost`), also server-side.
- **No margin from unverified cost.** `verified_unit_cost` always wins. Without it, an implied cost is
  used only when `cost_data_quality = 'OK'`, and it is labelled 推算成本 (未核实). `UOM_SUSPECT` and
  `NO_PURCHASE_DATA` SKUs show 成本待核实 / Cost not verified and no margin anywhere.
- **Prices are append-only.** Setting a price closes the current row (`effective_to`) and inserts a
  new one with `set_by`; `/api/prices/at?date=` answers "what were we charging in March?".
- **Every change is attributed.** Product, price, customer tier, tier rule, setting, user and import
  changes write `audit_log` rows with who, when, field, old and new value.
- **Imports are idempotent** (file hash + merge-by-key) and never overwrite hand-entered UOM, verified
  cost, target margin, tier overrides, prices, captures or market references.
- **Money is integer sen** in the database, the API and the client; parsing is string-based.
- **Offline**: the service worker caches the app shell; products, current prices, the salesperson's
  customers, their regular items, gaps and bundles live in IndexedDB and are replaced on every sync
  (server wins). Captures go to an outbox with a client-generated id and are upserted by id when
  signal returns (client wins), so retries never duplicate.

## Layout

```
server/   app.js (HTTP, static, cookie auth, response redaction)  routes.js (API)  importer.js
          pricing.js (price history, cost basis, bulk)  auth.js  redact.js  audit.js  money.js  csv.js
          db.js + schema.sql (node:sqlite)  cli.js (seed / check / reconcile)
public/   index.html  app.js (router, layout)  store.js (IndexedDB cache + outbox)  sw.js  i18n.js
          views/  login lookup visit capture uom products intel import admin
data/     sample/ (synthetic)  seed/ (real, git-ignored)  pricing.sqlite (git-ignored)
test/     node --test suites
docs/     DATA_SPEC.md (the brief)  IMPORT.md (column mapping)
```

When you deploy a new version, bump `VERSION` in `public/sw.js` so phones pick up the new shell.
