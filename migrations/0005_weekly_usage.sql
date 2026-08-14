CREATE TABLE weekly_usage_by_owner (
  owner_email TEXT PRIMARY KEY,
  remaining_percent REAL NOT NULL,
  resets_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
