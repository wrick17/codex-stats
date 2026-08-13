CREATE TABLE systems_by_owner (
  owner_email TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  hostname TEXT,
  platform TEXT,
  arch TEXT,
  codex_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (owner_email, id)
);

INSERT INTO systems_by_owner
SELECT 'wrick17@gmail.com', id, name, hostname, platform, arch, codex_version, created_at, last_seen_at
FROM systems;

CREATE TABLE sessions_by_owner (
  owner_email TEXT NOT NULL,
  uid TEXT NOT NULL,
  id TEXT NOT NULL,
  system_id TEXT NOT NULL,
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
  skills_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_email, uid),
  FOREIGN KEY (owner_email, system_id) REFERENCES systems_by_owner(owner_email, id) ON DELETE CASCADE
);

INSERT INTO sessions_by_owner
SELECT 'wrick17@gmail.com', uid, id, system_id, started_at, ended_at, cwd_label, repo, branch, source,
  cli_version, model, effort, status, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens,
  reasoning_tokens, total_tokens, duration_ms, user_messages, assistant_messages, turn_count, tool_count,
  error_count, subagent_count, tools_json, skills_json, updated_at
FROM sessions;

CREATE INDEX sessions_by_owner_started ON sessions_by_owner(owner_email, started_at);
CREATE INDEX sessions_by_owner_system_started ON sessions_by_owner(owner_email, system_id, started_at);
CREATE INDEX sessions_by_owner_model_started ON sessions_by_owner(owner_email, model, started_at);
CREATE INDEX sessions_by_owner_repo_started ON sessions_by_owner(owner_email, repo, started_at);
