-- Idempotent bootstrap executed on every server start (kept in sync with schema.ts).
-- drizzle-kit migrations are a follow-up once the schema changes between releases.
-- Search-block columns (tsv, embedding) are added via ALTER TABLE ... IF NOT
-- EXISTS below the base tables, so one statement covers both a fresh database
-- and one created before the search block existed.

-- pgvector: bundled with PGlite (db/client.ts loads it); a real-Postgres
-- deployment via DATABASE_URL needs the extension installed (DESIGN.md §2).
CREATE EXTENSION IF NOT EXISTS vector;

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
  description text,
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
  -- keep in sync with MAX_CLAIM_BODY_LENGTH in @crosscheck/schema
  body text NOT NULL CONSTRAINT claims_body_length_check CHECK (char_length(body) <= 400),
  status text NOT NULL,
  confidence double precision NOT NULL,
  capture_mode text NOT NULL,
  provenance text NOT NULL,
  dedup_count integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz,
  stale_at timestamptz,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
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

CREATE UNIQUE INDEX IF NOT EXISTS claim_edges_from_to_kind_idx
  ON claim_edges (from_claim_id, to_claim_id, kind);

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

-- ── Search block (DESIGN.md §6) ─────────────────────────────────────────────

-- FTS over the normalized doc (title + status + target values + claim-kind
-- summaries, services/normalized-doc.ts) and over claim bodies. GENERATED
-- columns so the tsv can never drift from the text it indexes.
ALTER TABLE work_contexts ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(normalized_doc, ''))) STORED;
CREATE INDEX IF NOT EXISTS work_contexts_tsv_idx
  ON work_contexts USING gin (tsv);

ALTER TABLE claims ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', body)) STORED;
CREATE INDEX IF NOT EXISTS claims_tsv_idx
  ON claims USING gin (tsv);

-- Optional vector tier: null until an embedder is configured AND has embedded
-- the row. embedding_model records WHICH embedder minted the vector, because
-- vectors from different models are not comparable — a model change makes old
-- rows invisible to the vector tier instead of silently mis-ranked (§6:
-- "model change = re-embed migration").
ALTER TABLE work_contexts ADD COLUMN IF NOT EXISTS embedding vector(768);
ALTER TABLE work_contexts ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS embedding vector(768);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS embedding_model text;

-- Backfill for contexts created before the search block existed: title +
-- status only. The full doc regenerates on the next ingest that touches the
-- context (services/normalized-doc.ts is the single builder; this is the one
-- place that cannot call it, so it stores the minimal honest subset).
UPDATE work_contexts SET normalized_doc = title || ' ' || status
  WHERE normalized_doc IS NULL;

-- Similarity-detected contradiction candidates (DESIGN.md §3 ingest gate).
-- A TABLE for these, and only these: they exist only while an embedder is
-- configured, and recomputing pairwise cosine at read time would be O(n²) over
-- the claim store. The DETERMINISTIC candidates (shared target + opposite
-- status) are deliberately NOT stored — services/contradictions.ts derives
-- them fresh per read, so a target that arrives after both claims still forms
-- the pair, with no ingest-order dependence and nothing to go stale.
CREATE TABLE IF NOT EXISTS contradiction_candidates (
  id text PRIMARY KEY,
  claim_a_id text NOT NULL REFERENCES claims(id),
  claim_b_id text NOT NULL REFERENCES claims(id),
  similarity double precision NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS contradiction_candidates_pair_idx
  ON contradiction_candidates (claim_a_id, claim_b_id);