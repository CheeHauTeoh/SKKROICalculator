## 1. What you are building

An internal web app for **SK Keong Trading Sdn. Bhd.**, a wholesale distributor of packaging,
plastics and F&B consumables in Kota Bharu, Kelantan, Malaysia. ~RM27.5m annual sales value,
32 employees, 7 salespeople, 771 active customers, 1,093 SKUs.

The app has two jobs:

1. **For the owner and finance** — hold the product list with purchase cost, target margin and
   the selling prices, and let those be updated over time.
2. **For the salespeople, on a phone, in a van** — show the price they are allowed to quote,
   show what else this customer should be buying, and capture what competitors are charging.

The company currently has no system for this. Salespeople phone the office to ask prices.
Competitor pricing lives in people's memories. There is no agreed floor price, so discounting
is inconsistent and invisible.

## 2. Non-negotiable context

- **Users**: 7 salespeople (Chinese-speaking, varying comfort with technology), 1 owner,
  1 finance person (Yun Jun Ooi), 1 clerk.
- **UI must be bilingual** — Simplified Chinese primary, English secondary. Field labels in both.
  Salesperson-facing screens should work for someone who reads Chinese only.
- **Phone-first.** Salespeople use this standing in a customer's shop. Assume a mid-range Android
  phone, one hand, poor signal.
- **Must work offline.** Price lookup and competitor capture must function with no connection and
  sync when signal returns. This is the difference between the app being used and abandoned.
- **Salespeople must never see purchase cost or margin.** They see *list price* and *floor price*
  only. If a salesperson can see cost, every negotiation converges on cost. Owner and finance see
  everything. Build this as a role check on the server, not just hidden UI.
  *(This is a business decision by the owner and may be reversed — keep it configurable.)*

## 3. The critical data problem — read this before designing anything

**You cannot currently compute gross margin for a large part of the catalogue, and the app must
not pretend otherwise.**

Purchase records and sales records use **different units of measure**. Purchases may be booked in
cartons or bales, sales in packets or pieces. Dividing value by quantity therefore produces
nonsense for many SKUs:

| SKU | Implied unit cost | Implied unit price | "Margin" |
|---|---|---|---|
| `9.EC22` EC22A+LID | RM121.80 | RM4.86 | −2404% |
| `70.JP9` JSP 9" plate | RM53.96 | RM19.31 | −179% |
| `SXLSK` Rubbish bag XL | RM2.23 | RM4.23 | +47.4% (plausible) |

Every row in `seed_products.csv` carries a `cost_data_quality` flag:

- `OK` — implied margin falls between 2% and 60%, units probably align (588 SKUs; **104 of the 178 core SKUs**)
- `UOM_SUSPECT` — implied margin is impossible, units do not align (228 SKUs; **73 of the 178 core**)
- `NO_PURCHASE_DATA` — nothing bought in FY2025 (277 SKUs; 1 of the core)

### What this means for the build

1. **Milestone 1 is a UOM reconciliation screen**, not a price list. It presents each SKU with its
   purchase unit, selling unit and the implied numbers, and lets a human enter
   `uom_purchase`, `uom_selling` and `uom_factor`. Prioritise the 73 core SKUs flagged
   `UOM_SUSPECT` — that is the whole blocking task, and it is finite.
2. **Never display or calculate a margin from unverified cost.** If `cost_data_quality != 'OK'`
   and `verified_unit_cost` is empty, show "成本待核实 / Cost not verified" and suppress margin.
   Do not fall back to the implied figure.
3. `verified_unit_cost` overrides `implied_unit_cost` once entered, always.

Treat the implied columns as *evidence for a human to check*, never as truth.

## 4. Market price benchmarking — scope it honestly

Roughly **22% of sales value is branded goods** (Seamaster, LYG, Good World, Nestlé, Sadji,
Rosmuni and similar — flagged `is_branded` in the seed file). For those, Malaysian wholesale
prices are findable online. A live example: Seamaster 250ml × 24 quotes between RM6.15 and
RM9.38 per carton across four Malaysian wholesalers.

The other **78% — singlet bags, disposables, greaseproof paper —** is own-brand and commodity.
There is no public price. Searching for it returns supplier directories and nothing usable.

So build **two separate price-intelligence paths** and label them differently in the UI:

- **Market reference** (branded only): optional scheduled lookup, stored with source URL and
  date. Always show the source. Never auto-apply to pricing.
- **Field intelligence** (everything): prices captured by salespeople from customers and
  competitors. For the 78% this is the *only* source, so the capture flow is the product.

Do not build a feature that promises market prices for all SKUs. It will silently fail on exactly
the products the company is losing on.

## 5. Data model

```
products          item_code (PK), description, category, subcategory,
                  is_core_80, is_branded, uom_purchase, uom_selling, uom_factor,
                  verified_unit_cost, cost_updated_at, cost_updated_by,
                  target_margin_pct, status
product_prices    item_code, price_tier, list_price, floor_price,
                  effective_from, effective_to, set_by        -- full history, never overwrite
customers         customer_code (PK), customer_name, agent_code, salesperson,
                  customer_type, buying_breadth, size_tier, price_tier, status
customer_products item_code, customer_code, fy_qty, fy_value      -- purchase history
bundles           bundle_id, customer_type, item_code, support_pct, lift, median_annual_value
crosssell_gaps    customer_code, item_code, peer_penetration_pct, estimated_annual_value
field_prices      id, captured_at, salesperson, customer_code, item_code,
                  our_price, competitor_price, competitor_name, outcome, note, synced
market_refs       item_code, source_name, source_url, price, unit, captured_at
audit_log         who, when, what changed, old value, new value
```

Notes:
- `product_prices` is **append-only with effective dates**. The owner will want to answer "what
  were we charging in March?" Overwriting prices destroys that.
- `price_tier` sits on the **customer**, not decided per visit. Tiers should map from
  `customer_type` + `size_tier` initially — a hypermarket and a small kedai runcit should not get
  the same price, and today that judgement lives in people's heads.
- `outcome` on `field_prices`: won / lost / quoted-only. This is what turns the log into win-rate
  data later.

## 6. Screens

### Salesperson (phone)

1. **Price lookup** — search by code or description, big text, shows list price and floor price
   for that customer's tier. Works offline. No cost, no margin, anywhere.
2. **Visit prep** — pick a customer → shows their type, their regular items, and *what customers
   like them buy that this one doesn't* (from `crosssell_gaps` and `bundles`), with the suggested
   opening question. This is the highest-value screen; the analysis behind it is already done and
   sits in the seed CSVs.
3. **Capture competitor price** — must be **two taps and a number**. Customer → SKU → their price
   → save. Competitor name and outcome optional, defaulted, editable later. If this takes more
   than about 15 seconds it will not be used. Queue offline, sync silently.

### Owner / finance (desktop)

4. **UOM reconciliation** — the milestone-1 screen described above, with progress against the
   73 core SKUs.
5. **Product & price management** — cost, target margin, tier prices, floor. Bulk edit by
   category. Every change written to `audit_log`.
6. **Price intelligence** — per SKU: our price vs captured competitor prices vs market reference,
   over time. Flag SKUs where we are above every competitor price seen.
7. **Import / update** — re-upload the UBS exports (sales, purchases) to refresh history without
   losing entered cost, tier prices or captured field data. **Idempotent: re-importing the same
   file twice must not duplicate anything.**

## 7. Technical constraints

- Web app, mobile-first. A PWA is the pragmatic choice — installable, offline-capable, no app
  store. Use your judgement on stack; something a small team can host and maintain cheaply.
- Offline: IndexedDB or equivalent for the product/price/customer cache plus an outbox queue for
  captures. Conflict rule: server wins for prices, client wins for captures.
- Auth with roles: `salesperson`, `finance`, `owner`. Enforce the cost-visibility rule server-side.
- Seed from the four CSVs in this folder. Import must be re-runnable.
- Currency RM, two decimals. Dates as ISO. All money as integers in sen or as decimal — never float.

## 8. Build order

| Milestone | Deliverable | Done when |
|---|---|---|
| **M1** | UOM reconciliation + product import | All 178 core SKUs have `uom_factor` and a verified cost, or are explicitly marked "no purchase" |
| **M2** | Price management + tiers + audit | Owner can set target margin and tier prices for the 178 core SKUs and see the history |
| **M3** | Salesperson price lookup, offline | A salesperson with no signal can find any core SKU's price for their customer in under 10 seconds |
| **M4** | Competitor capture, offline | Capture in ≤3 taps + a number; queued captures sync automatically |
| **M5** | Visit prep | Open a customer, see their gaps and bundles from the seed data |
| **M6** | Price intelligence dashboard | Per-SKU comparison of our price vs captured competitor prices over time |
| **M7** | Market reference for branded SKUs | Optional; only after M1–M6 are in use |

**Start with 178 SKUs, not 1,093.** Those 178 are 79.9% of sales value. A catalogue of 1,093
prices will not be maintained, and an out-of-date price is worse than no app.

## 9. Acceptance criteria

- A salesperson in airplane mode can look up a price and log a competitor price; both work, and
  the capture appears on the server once signal returns.
- No screen, API response or export available to a `salesperson` role contains cost or margin.
- A SKU with `cost_data_quality = 'UOM_SUSPECT'` and no verified cost shows no margin anywhere.
- Re-importing the same UBS export twice changes nothing.
- Every price change is attributable to a person and a timestamp.
- Total FY2025 value in the imported product table reconciles to **RM27,521,859**.

## 10. Do not build

- Order taking, invoicing, stock or delivery. UBS does that. This app is prices and intelligence.
- Automatic price changes based on competitor data. It surfaces; a human decides.
- Customer-facing anything. Internal only.
- A discount-approval workflow in v1. Get the floor price working first.
