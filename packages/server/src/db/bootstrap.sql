-- Idempotent bootstrap executed on every server start (kept in sync with schema.ts).
-- drizzle-kit migrations are a follow-up once the schema changes between releases.
-- Search-block columns (tsv, embedding) are added via ALTER TABLE ... IF NOT
-- EXISTS below the base tables, so one statement covers both a fresh database
-- and one created before the search block existed. The upgrade half is
-- exercised against a real pre-search-block persistent dir by
-- test/upgrade.test.ts (fixture: test/fixtures/pre-search-block-bootstrap.sql).

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

-- The derived-contradictions join matches targets on (kind, value) with the
-- PK's leading column unconstrained (services/contradictions.ts) — without
-- this, every read of GET /api/contradictions scans the whole targets table.
CREATE INDEX IF NOT EXISTS work_context_targets_kind_value_idx
  ON work_context_targets (kind, value);

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

-- The hints candidates path probes "is this claim a supersedes TARGET" per
-- candidate row (services/hints.ts notSuperseded); the unique index above
-- leads on from_claim_id and cannot serve a to_claim_id lookup.
CREATE INDEX IF NOT EXISTS claim_edges_to_kind_idx
  ON claim_edges (to_claim_id, kind);

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

-- ANN index for the ingest gate's nearest-neighbor probes over claim
-- embeddings (similarity-gate.ts): without it every claim ingest runs a
-- sequential scan over all embedded claims, inside the transaction, on the
-- single connection — O(n²) for the store. hnsw is supported by the pgvector
-- build bundled with the pinned PGlite (proved by the index assertion in
-- similarity-gate.test.ts); creation on an existing table is cheap and
-- inserts pay a few ms of graph maintenance only when a row has a vector.
CREATE INDEX IF NOT EXISTS claims_embedding_hnsw_idx
  ON claims USING hnsw (embedding vector_cosine_ops);

-- Backfill for contexts created before the search block existed: title +
-- status only. The full doc regenerates on the next ingest that touches the
-- context (services/normalized-doc.ts is the single builder; this is the one
-- place that cannot call it, so it stores the minimal honest subset).
UPDATE work_contexts SET normalized_doc = title || ' ' || status
  WHERE normalized_doc IS NULL;

-- ── Collective memory (VISION.md §1) ────────────────────────────────────────

-- Merged-branch detection (DESIGN.md §5): stamped when landed_evidence maps
-- the owning session's base commit onto the default branch. ALTER so one
-- statement covers fresh databases and ones created before this column.
ALTER TABLE work_contexts ADD COLUMN IF NOT EXISTS landed_at timestamptz;

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
-- ── Absence detection (roadmap item 3) ──────────────────────────────────────

-- Latest commit-authorship evidence per (repo, commit author): the absence
-- check's ground truth. Upsert-only — one row per author per repo, bounded by
-- team size; ingest prunes rows older than the retention window
-- (services/commit-evidence.ts). author_email is stored lowercased and is the
-- matching key against developers.email; it never leaves the hub — absence
-- responses carry names only (services/absences.ts).
CREATE TABLE IF NOT EXISTS commit_evidence (
  repo text NOT NULL,
  author_email text NOT NULL,
  author_name text NOT NULL,
  latest_commit_at timestamptz NOT NULL,
  commit_count integer NOT NULL,
  window_days integer NOT NULL,
  collected_at timestamptz NOT NULL,
  reported_by text NOT NULL REFERENCES developers(id),
  PRIMARY KEY (repo, author_email)
);

-- ── Alias emails (trial finding #7) ─────────────────────────────────────────

-- Every email a developer is known by: the primary plus admin-linked aliases.
-- The PRIMARY KEY on email is the invariant — an email belongs to AT MOST one
-- developer — enforced by the database rather than promised by a service
-- (schema.ts developerEmails carries the full table-vs-column reasoning).
-- Emails are stored lowercased; the absence check joins commit evidence here.
CREATE TABLE IF NOT EXISTS developer_emails (
  email text PRIMARY KEY,
  developer_id text NOT NULL REFERENCES developers(id),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS developer_emails_developer_idx
  ON developer_emails (developer_id);

-- Backfill for databases created before aliases existed: each developer's
-- single stored email becomes their primary row (test/upgrade.test.ts drives
-- this against a real pre-alias persistent dir). Idempotent on every boot —
-- ON CONFLICT covers both the re-run and a developer created mid-upgrade.
-- DISTINCT ON makes the case-fold DETERMINISTIC: when two legacy developers'
-- emails differ only by case, the one already stored lowercase wins the
-- folded row (then oldest, then id — never insert order). That guarantee is
-- what the second pass below leans on: every loser's verbatim email carries
-- an uppercase letter, so it can never collide with any lower() output.
INSERT INTO developer_emails (email, developer_id, is_primary, created_at)
  SELECT DISTINCT ON (lower(email)) lower(email), id, true, created_at
  FROM developers
  ORDER BY lower(email), (email = lower(email)) DESC, created_at, id
  ON CONFLICT (email) DO NOTHING;

-- Case-variant legacy edge (adversarial review): two pre-normalization
-- developers whose stored emails differ only by case (reachable — the v0
-- foundation stored input.email raw, and developers.email UNIQUE is
-- case-sensitive) FOLD to one row above; the loser would own ZERO rows —
-- invisible to GET /:id/emails and regressed in absence matching. Give every
-- developer still empty their stored email VERBATIM as primary: the account
-- stays visible and admin-repairable. Deliberately not lowercased — the
-- lowercased identity belongs to the fold winner (the PK is the "at most one
-- developer per email" invariant), and a non-normalized row never matches
-- the absence join (which compares lowercased evidence), which is exactly
-- honest: that email's commits belong to the winner. This insert cannot
-- itself conflict (losers carry an uppercase letter; every existing row is a
-- lower() output or a unique verbatim), but ON CONFLICT stays as belt and
-- braces. Idempotent: NOT EXISTS makes re-runs no-ops. Driven by
-- test/upgrade.test.ts against a real pre-alias dir.
INSERT INTO developer_emails (email, developer_id, is_primary, created_at)
  SELECT d.email, d.id, true, d.created_at FROM developers d
  WHERE NOT EXISTS (
    SELECT 1 FROM developer_emails de WHERE de.developer_id = d.id
  )
  ON CONFLICT (email) DO NOTHING;

-- ── Presence opt-out + mute (DESIGN.md §2.1, §10 risk 3) ────────────────────

-- Presence opt-out: while true, this developer's LIVE presence is hidden from
-- every OTHER developer's reads (services/visibility.ts names the surfaces).
-- ALTER so one statement covers fresh databases and ones created before the
-- column existed. Published knowledge is deliberately NOT touched by it.
ALTER TABLE developers ADD COLUMN IF NOT EXISTS presence_opt_out boolean NOT NULL DEFAULT false;

-- Reader-side mutes: one row per (reader, muted) pair, filtering the READER's
-- unasked surfaces only. Hub-side so a mute follows the reader across
-- machines; bounded per reader by MAX_MUTES_PER_READER at write time
-- (services/developer-settings.ts).
CREATE TABLE IF NOT EXISTS developer_mutes (
  reader_developer_id text NOT NULL REFERENCES developers(id),
  muted_developer_id text NOT NULL REFERENCES developers(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (reader_developer_id, muted_developer_id)
);

-- ── The session's intent on presence (trial finding #16) ────────────────────

-- `work_contexts.session_id` is a foreign key with no index of its own, and
-- services/presence.ts now reads the newest context of each live session to
-- put its intent on the "active now" line. That read happens on every
-- SessionStart briefing and every `crosscheck status`, so without this index
-- it is a sequential scan of every work context on the hub, per live session.
-- Leading with session_id and descending on created_at makes the subquery's
-- `order by created_at desc limit 1` a single index lookup.
CREATE INDEX IF NOT EXISTS work_contexts_session_created_idx
  ON work_contexts (session_id, created_at DESC);

-- ── WHO and WHEN in search (roadmap R1) ─────────────────────────────────────

-- `GET /api/search?developer=…` filters INSIDE every tier query, which joins
-- work_contexts to agent_sessions. `developer_id` is a foreign key, and
-- Postgres does not index those on its own, so the filter was a scan of every
-- session on the hub. Leading with developer_id and carrying repo lets one
-- lookup serve "Ken, on this repo" — the only shape the search route asks
-- for; repo ALONE keeps its own index above.
CREATE INDEX IF NOT EXISTS agent_sessions_developer_repo_idx
  ON agent_sessions (developer_id, repo);

-- `?since=14d` filters on ACTIVITY — coalesce(updated_at, created_at), the
-- timestamp every surface renders as the row's age and the one time-decay is
-- computed from. The same expression is the recency tier's ORDER BY, so this
-- index serves both the window filter and the "what is happening here"
-- listing, which without it reads every work context on the hub and top-N
-- sorts them to answer a LIMIT 30.
CREATE INDEX IF NOT EXISTS work_contexts_activity_idx
  ON work_contexts (coalesce(updated_at, created_at) DESC);

-- The unknown-developer refusal reads a bounded, name-ordered page of
-- developers to offer the closest spellings (services/developer-lookup.ts
-- DEVELOPER_SUGGESTION_SCAN). Bounded listing, index behind the ORDER BY.
CREATE INDEX IF NOT EXISTS developers_name_idx
  ON developers (name, email);

-- ── The asynchronous question channel (roadmap R2) ──────────────────────────

-- A question addressed to a teammate: one row, targeted, expiring, answered
-- by a claim. The addressee CHECK is what makes "never a broadcast" a
-- database fact rather than a service promise, and the body CHECK mirrors
-- MAX_QUESTION_BODY_LENGTH in @crosscheck/schema (pinned by ddl-sync.test.ts).
CREATE TABLE IF NOT EXISTS questions (
  id text PRIMARY KEY,
  repo text NOT NULL,
  author_developer_id text NOT NULL REFERENCES developers(id),
  author_session_id text NOT NULL REFERENCES agent_sessions(id),
  target_developer_id text REFERENCES developers(id),
  work_context_id text REFERENCES work_contexts(id),
  body text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT questions_body_length_check CHECK (char_length(body) <= 400),
  CONSTRAINT questions_addressee_check
    CHECK (target_developer_id IS NOT NULL OR work_context_id IS NOT NULL)
);

-- The inbox read ("open questions for me in THIS repo, newest first") and the
-- two backlog counters beside it are the same range; without this index all
-- three scan every question on the hub on every SessionStart briefing.
-- repo is the SECOND column, not a filter after the fact: one person can be
-- the addressee of many questions across many repos, and a repo predicate
-- applied after the index cond makes the scan fetch rows it then throws away.
CREATE INDEX IF NOT EXISTS questions_target_repo_status_created_idx
  ON questions (target_developer_id, repo, status, created_at DESC);

-- The second addressee axis: questions asked ABOUT one work context. A plain
-- foreign key, which Postgres does not index on its own.
CREATE INDEX IF NOT EXISTS questions_work_context_idx
  ON questions (work_context_id);

-- The asker's own side: outbox counters, the per-author open budget and the
-- per-day rate probe all read this one range.
CREATE INDEX IF NOT EXISTS questions_author_created_idx
  ON questions (author_developer_id, created_at DESC);

-- The team-wide axis (VISION.md §2): "every open question of THIS repo,
-- oldest first", which the conference report reads and which no index above
-- can serve — both of those lead with a person. Without it a conference on a
-- hub holding a thousand questions scans all of them. Mirrored in db/schema.ts.
CREATE INDEX IF NOT EXISTS questions_repo_status_created_idx
  ON questions (repo, status, created_at);

-- The `answers` edge: one claim answering one question. Its own table rather
-- than a claim_edges kind, because claim_edges.to_claim_id is a foreign key
-- into claims and an answers edge would have to point it at a question id.
CREATE TABLE IF NOT EXISTS question_answers (
  question_id text NOT NULL REFERENCES questions(id),
  claim_id text NOT NULL REFERENCES claims(id),
  answerer_developer_id text NOT NULL REFERENCES developers(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (question_id, claim_id)
);

-- "Which question does this claim answer" — asked per claim on the asker's
-- delivery path; the primary key leads on question_id and cannot serve it.
CREATE INDEX IF NOT EXISTS question_answers_claim_idx
  ON question_answers (claim_id);

-- "Delivered exactly once" for an answer is a cross-SESSION promise: the
-- asker's per-session seen-set dies with the session, so the durable store is
-- hint_deliveries, probed as "has any session of this developer already been
-- handed this claim id". ref_id had no index at all, which made that probe a
-- scan of every delivery row on the UserPromptSubmit hot path.
CREATE INDEX IF NOT EXISTS hint_deliveries_ref_session_idx
  ON hint_deliveries (ref_id, session_id);

-- `work_context_id` is a foreign key, which Postgres does NOT index on its
-- own, and three hot readers ask "the claims of THESE contexts, newest
-- first": the solved probe, the solved root-cause body the briefing renders,
-- and normalized-doc's per-ingest refresh. Mirrored in db/schema.ts.
CREATE INDEX IF NOT EXISTS claims_work_context_created_idx
  ON claims (work_context_id, created_at DESC);

-- The precision counter (services/solved-counts.ts) reaches deliveries
-- through session_id — a foreign key, and therefore unindexed by default.
-- Mirrored in db/schema.ts.
CREATE INDEX IF NOT EXISTS hint_deliveries_session_delivered_idx
  ON hint_deliveries (session_id, delivered_at DESC);
