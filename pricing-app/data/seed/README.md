# Seed files (real data — not committed)

Copy the four files from `SK Keong/Data/Sales/Pricing App/` here:

- `seed_products.csv`  – one row per SKU, with `cost_data_quality`, `is_core_80`, `is_branded`, FY sales/purchase figures
- `seed_customers.csv` – one row per customer, with `salesperson`, `customer_type`, `size_tier`
- `seed_bundles.csv`   – basket analysis by customer type
- `seed_crosssell.csv` – gaps per customer

Optional: a UBS sales export (item × customer, with qty and value) named `*sales*.csv` or
`seed_customer_products.csv` to populate each customer's regular items; a UBS purchase export named
`*purchase*.csv`.

Then run `npm run seed` (imports in dependency order, prints what changed, and checks that the FY
sales total reconciles to RM 27,521,859). Re-running is safe: an unchanged file is skipped and an
edited file only updates the rows that differ. Hand-entered UOM factors, verified costs, target
margins, tier prices and captured field prices are never overwritten by an import.

If a column is not recognised, run `npm run import:check -- data/seed/seed_products.csv` to see the
detected mapping and add the header to the alias list in `server/importer.js`.

`*.csv` in this folder is git-ignored.
