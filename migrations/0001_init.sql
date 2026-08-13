PRAGMA foreign_keys = ON;

CREATE TABLE systems (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT,
  platform TEXT,
  arch TEXT,
  codex_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE sessions (
  uid TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  system_id TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  cwd_label TEXT,
  repo TEXT,
  branch TEXT,
  source TEXT,
  cli_version TEXT,
  model TEXT,
  effort TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  user_messages INTEGER NOT NULL DEFAULT 0,
  assistant_messages INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  tool_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  subagent_count INTEGER NOT NULL DEFAULT 0,
  tools_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE INDEX sessions_started ON sessions(started_at);
CREATE INDEX sessions_system_started ON sessions(system_id, started_at);
CREATE INDEX sessions_model_started ON sessions(model, started_at);
CREATE INDEX sessions_repo_started ON sessions(repo, started_at);
