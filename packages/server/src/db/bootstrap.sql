-- Idempotent bootstrap executed on every server start (kept in sync with schema.ts).
-- drizzle-kit migrations are a follow-up once the schema changes between releases.
-- vector/embedding + tsv columns arrive with the search block.

CREATE TABLE IF NOT EXISTS developers (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  api_key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id text PRIMARY KEY,
  developer_id text NOT NULL REFERENCES developers(id),
  agent_kind text NOT NULL,
  repo text NOT NULL,
  branch text NOT NULL,
  base_commit text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS agent_sessions_repo_idx
  ON agent_sessions (repo);
CREATE INDEX IF NOT EXISTS agent_sessions_heartbeat_idx
  ON agent_sessions (last_heartbeat_at);

CREATE TABLE IF NOT EXISTS work_contexts (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_sessions(id),
  title text NOT NULL,
  intent jsonb,
  status text NOT NULL,
  normalized_doc text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz
);

CREATE TABLE IF NOT EXISTS work_context_targets (
  work_context_id text NOT NULL REFERENCES work_contexts(id),
  kind text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (work_context_id, kind, value)
);

CREATE TABLE IF NOT EXISTS claims (
  id text PRIMARY KEY,
  work_context_id text NOT NULL REFERENCES work_contexts(id),
  author_session_id text NOT NULL REFERENCES agent_sessions(id),
  kind text NOT NULL,
  body text NOT NULL,
  status text NOT NULL,
  confidence double precision NOT NULL,
  capture_mode text NOT NULL,
  provenance text NOT NULL,
  dedup_count integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz,
  stale_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_edges (
  id text PRIMARY KEY,
  from_claim_id text NOT NULL REFERENCES claims(id),
  to_claim_id text NOT NULL REFERENCES claims(id),
  kind text NOT NULL,
  author_session_id text NOT NULL REFERENCES agent_sessions(id),
  note text,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  claim_id text NOT NULL REFERENCES claims(id),
  kind text NOT NULL,
  content text NOT NULL,
  sensitivity text NOT NULL,
  approved_by text REFERENCES developers(id),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hint_deliveries (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES agent_sessions(id),
  ref_kind text NOT NULL,
  ref_id text NOT NULL,
  delivered_at timestamptz NOT NULL,
  pulled_at timestamptz
);