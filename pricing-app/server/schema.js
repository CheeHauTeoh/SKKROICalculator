// Generated from the schema below; kept as a JS string so serverless bundlers can include it.
export const SCHEMA = String.raw`
-- SK Keong pricing app schema. All money columns are integer sen. All dates ISO-8601 text (UTC).
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('salesperson','finance','owner')),
  salesperson_code     TEXT,                       -- matches customers.salesperson for salesperson users
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active               INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  item_code               TEXT PRIMARY KEY,
  description             TEXT NOT NULL DEFAULT '',
  category                TEXT NOT NULL DEFAULT '',
  subcategory             TEXT NOT NULL DEFAULT '',
  brand                   TEXT,
  is_core_80              INTEGER NOT NULL DEFAULT 0,
  is_branded              INTEGER NOT NULL DEFAULT 0,
  status                  TEXT NOT NULL DEFAULT 'active',
  -- Human-entered (never overwritten by import) ---------------------------
  uom_purchase            TEXT,
  uom_selling             TEXT,
  uom_factor              REAL,        -- selling units per purchase unit
  verified_unit_cost_sen  INTEGER,     -- per SELLING unit; overrides implied, always
  cost_updated_at         TEXT,
  cost_updated_by         TEXT,
  no_purchase_confirmed   INTEGER NOT NULL DEFAULT 0,  -- explicitly marked "no purchase data"
  target_margin_pct       REAL,
  -- Imported evidence (refreshed by import; evidence for a human to check, never truth) --
  fy_label                TEXT,
  fy_sales_qty            REAL,
  fy_sales_value_sen      INTEGER,
  fy_purchase_qty         REAL,
  fy_purchase_value_sen   INTEGER,
  implied_unit_cost_sen   INTEGER,     -- purchase value / purchase qty (purchase unit!)
  implied_unit_price_sen  INTEGER,     -- sales value / sales qty (selling unit)
  implied_margin_pct      REAL,
  cost_data_quality       TEXT NOT NULL DEFAULT 'NO_PURCHASE_DATA'
                          CHECK (cost_data_quality IN ('OK','UOM_SUSPECT','NO_PURCHASE_DATA')),
  uom_purchase_hint       TEXT,        -- unit text as it appears in purchase records
  uom_selling_hint        TEXT,        -- unit text as it appears in sales records
  updated_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_core ON products(is_core_80, cost_data_quality);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

CREATE TABLE IF NOT EXISTS price_tiers (
  code    TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);

-- customer_type + size_tier -> price_tier. '*' is a wildcard.
CREATE TABLE IF NOT EXISTS tier_rules (
  customer_type TEXT NOT NULL,
  size_tier     TEXT NOT NULL,
  price_tier    TEXT NOT NULL REFERENCES price_tiers(code),
  PRIMARY KEY (customer_type, size_tier)
);

-- Append-only price history. Current row: effective_to IS NULL.
CREATE TABLE IF NOT EXISTS product_prices (
  id              INTEGER PRIMARY KEY,
  item_code       TEXT NOT NULL REFERENCES products(item_code),
  price_tier      TEXT NOT NULL REFERENCES price_tiers(code),
  list_price_sen  INTEGER NOT NULL,
  floor_price_sen INTEGER NOT NULL,
  effective_from  TEXT NOT NULL,
  effective_to    TEXT,
  set_by          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_pp_current ON product_prices(item_code, price_tier, effective_to);

CREATE TABLE IF NOT EXISTS customers (
  customer_code       TEXT PRIMARY KEY,
  customer_name       TEXT NOT NULL DEFAULT '',
  agent_code          TEXT,
  salesperson         TEXT,
  customer_type       TEXT,
  buying_breadth      TEXT,
  size_tier           TEXT,
  price_tier          TEXT REFERENCES price_tiers(code),
  price_tier_override INTEGER NOT NULL DEFAULT 0,  -- 1 = set by hand; import/rules leave it alone
  status              TEXT NOT NULL DEFAULT 'active',
  fy_value_sen        INTEGER,
  updated_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_customers_sp ON customers(salesperson);

CREATE TABLE IF NOT EXISTS customer_products (
  customer_code TEXT NOT NULL,
  item_code     TEXT NOT NULL,
  fy_qty        REAL,
  fy_value_sen  INTEGER,
  PRIMARY KEY (customer_code, item_code)
);
CREATE INDEX IF NOT EXISTS idx_cp_item ON customer_products(item_code);

CREATE TABLE IF NOT EXISTS bundles (
  bundle_id               TEXT NOT NULL,
  customer_type           TEXT NOT NULL,
  item_code               TEXT NOT NULL,
  support_pct             REAL,
  lift                    REAL,
  median_annual_value_sen INTEGER,
  PRIMARY KEY (bundle_id, item_code)
);
CREATE INDEX IF NOT EXISTS idx_bundles_type ON bundles(customer_type);

CREATE TABLE IF NOT EXISTS crosssell_gaps (
  customer_code              TEXT NOT NULL,
  item_code                  TEXT NOT NULL,
  peer_penetration_pct       REAL,
  estimated_annual_value_sen INTEGER,
  PRIMARY KEY (customer_code, item_code)
);

-- Field intelligence: captured by salespeople. id is generated on the client so offline
-- captures can be retried without duplicating (client wins).
CREATE TABLE IF NOT EXISTS field_prices (
  id                   TEXT PRIMARY KEY,
  captured_at          TEXT NOT NULL,
  salesperson          TEXT NOT NULL,
  customer_code        TEXT,
  item_code            TEXT NOT NULL,
  our_price_sen        INTEGER,
  competitor_price_sen INTEGER,
  competitor_name      TEXT,
  outcome              TEXT NOT NULL DEFAULT 'quoted' CHECK (outcome IN ('won','lost','quoted')),
  note                 TEXT,
  client_updated_at    TEXT,
  synced_at            TEXT NOT NULL,
  deleted              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fp_item ON field_prices(item_code, captured_at);
CREATE INDEX IF NOT EXISTS idx_fp_customer ON field_prices(customer_code);

-- Market reference (branded SKUs only). Always carries source + date. Never auto-applied.
CREATE TABLE IF NOT EXISTS market_refs (
  id          INTEGER PRIMARY KEY,
  item_code   TEXT NOT NULL REFERENCES products(item_code),
  source_name TEXT NOT NULL,
  source_url  TEXT NOT NULL,
  price_sen   INTEGER NOT NULL,
  unit        TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  captured_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_mr_item ON market_refs(item_code, captured_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  who       TEXT NOT NULL,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field     TEXT,
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS imports (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  filename    TEXT,
  sha256      TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  imported_by TEXT NOT NULL,
  row_count   INTEGER NOT NULL,
  summary     TEXT,
  UNIQUE (kind, sha256)
);

INSERT OR IGNORE INTO price_tiers (code, name_zh, name_en, sort) VALUES
  ('STD', '标准价', 'Standard', 10),
  ('KEY', '大客户价', 'Key account', 20),
  ('SML', '小客户价', 'Small account', 30);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('salesperson_can_see_cost', '0'),
  ('default_price_tier', 'STD'),
  ('fy_label', 'FY2025'),
  ('default_floor_discount_pct', '5');
`;
