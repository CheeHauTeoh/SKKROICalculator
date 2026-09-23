# Import column mapping

Headers are matched case-insensitively after normalising to `snake_case`; `FY2025 ` / `Total ` prefixes
and ` (RM)` suffixes are ignored. The full alias list is `KINDS` in `server/importer.js`. Use
`npm run import:check -- file.csv` (or the 检查 / Check button in 导入 / Import) to see the mapping
before committing anything.

| Kind | Required | Recognised columns (canonical name → what it becomes) |
|---|---|---|
| products | `item_code` | `description`, `category`, `subcategory`, `brand`, `is_core_80`, `is_branded`, `status`, `uom_purchase`, `uom_selling`, `uom_factor`, `uom_purchase_hint`, `uom_selling_hint`, `fy_sales_qty`, `fy_sales_value`, `fy_purchase_qty`, `fy_purchase_value`, `implied_unit_cost`, `implied_unit_price`, `implied_margin_pct`, `cost_data_quality`, `target_margin_pct`, `verified_unit_cost` |
| customers | `customer_code` | `customer_name`, `agent_code`, `salesperson`, `customer_type`, `buying_breadth`, `size_tier`, `price_tier`, `price_tier_override` (Y = set by hand, rules leave it alone), `status`, `fy_value` |
| bundles | `bundle_id`, `customer_type`, `item_code` | `support_pct`, `lift`, `median_annual_value` |
| crosssell | `customer_code`, `item_code` | `peer_penetration_pct`, `estimated_annual_value` |
| uom (the 单位核对 worksheet) | `item_code` | `uom_purchase`, `uom_selling`, `uom_factor`, `verified_unit_cost`, `no_purchase_confirmed`, `target_margin_pct` (applied through the audited product update, so a later round overwrites an earlier one) |
| prices (the 核心价格 sheet) | `item_code` | wide: `list_STD`, `floor_STD`, `list_KEY`, … per tier; or long: `price_tier`, `list_price`, `floor_price`; plus `effective_from`, `note`. Appends to price history, skips unchanged |
| users (owner only) | `username`, `role` | `display_name`, `salesperson_code`, `password` (default `sk1234`, change forced), `active`. Existing users' passwords are never changed |
| sales (UBS export, or `seed_customer_products.csv`) | `item_code`, `customer_code` | `qty`, `value`, `description`, `customer_name`, `uom`, `date` |
| purchases (UBS export) | `item_code` | `qty`, `value`, `description`, `supplier`, `uom`, `date` |

## What each import does

- **products**: upserts by `item_code`. Descriptive fields come from the file when non-empty. Evidence
  fields (`fy_*`, implied figures, `cost_data_quality`, unit hints) are replaced. Implied unit cost /
  price / margin are recomputed from qty and value whenever both exist; the file's own implied columns
  only fill gaps. `cost_data_quality` from the file is kept when present, otherwise computed (OK when
  implied margin is 2–60 %, NO_PURCHASE_DATA when there is no purchase value, else UOM_SUSPECT).
  `uom_*`, `target_margin_pct` and `verified_unit_cost` from the file are used **only when the
  database value is still empty**.
- **customers**: upserts by `customer_code`. `price_tier` = file value if it is a known tier, else the
  tier rules (customer type × size), else the existing value, else the default tier. Customers whose
  tier was set by hand (override) are left alone. Creates a salesperson login for each new
  salesperson code.
- **bundles**, **crosssell**: replace the whole table (they are analysis outputs, not edited by hand).
- **sales**: aggregates to (customer, item), replaces `customer_products`, recomputes each product's
  FY sales qty/value and implied figures, and each customer's FY value. Unknown products/customers get
  stub rows.
- **purchases**: aggregates to item, updates FY purchase qty/value and implied figures.

Every commit records the file's SHA-256; the same file committed again is skipped, and even a forced
re-run produces `inserted: 0, updated: 0`. The reconciliation card compares the sum of FY sales value in
the product table with RM 27,521,859 from the brief.

## Fill-in forms for SK Keong

`docs/data-request/SK_Keong_Pricing_App_Data_Request.xlsx` holds bilingual forms (users, UOM
worksheet, tiers and rules, target margins, core price list, customer tiers, competitors, owner
decisions). Its column headers are `canonical_name 中文`, which the importer normalises to the
canonical name, so a sheet saved as CSV imports directly. `build_workbook.py` regenerates it;
`build_memo.cjs` builds the cover memo (`docs/data-request/*_Memo.docx`).
