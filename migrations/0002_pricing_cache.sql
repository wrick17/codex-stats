CREATE TABLE IF NOT EXISTS pricing_cache (
  day TEXT PRIMARY KEY,
  rates_json TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
