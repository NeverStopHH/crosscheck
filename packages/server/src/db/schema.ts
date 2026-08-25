import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import {
  ARTIFACT_SENSITIVITIES,
  CAPTURE_MODES,
  CLAIM_KINDS,
  CLAIM_STATUSES,
  EDGE_KINDS,
  MAX_CLAIM_BODY_LENGTH,
  PROVENANCES,
  SESSION_STATUSES,
  TARGET_KINDS,
} from "@crosscheck/schema";

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Vectors from different models are not comparable, so every embedding carries
 * one dimensionality: OpenAI text-embedding-3-small truncated to 768 and
 * Ollama nomic-embed-text's native 768 (DESIGN.md §6). Kept in sync with the
 * vector(768) columns in bootstrap.sql.
 */
export const EMBEDDING_DIMENSIONS = 768;

/** drizzle has no first-class tsvector; the column is GENERATED, never written. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const developers = pgTable("developers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  /**
   * Presence opt-out (DESIGN.md §2.1, §10 risk 3): while true, this
   * developer's LIVE presence is hidden from every OTHER developer's reads —
   * services/visibility.ts names the exact surfaces. A column rather than a
   * settings table: it is one boolean per developer, and the developer row is
   * already read on every authenticated request.
   */
  presenceOptOut: boolean("presence_opt_out").notNull().default(false),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/**
 * Every email a developer is known by — the primary they registered with plus
 * admin-linked aliases (trial finding #7: git author emails rarely match the
 * hub email, so absence matching on the primary alone misfiles known members
 * as "unconnected"). A TABLE, not an array column, for three reasons that are
 * all the same invariant: the PRIMARY KEY on `email` is what makes "an email
 * belongs to AT MOST one developer" a database fact rather than a service
 * promise (alias-vs-alias); the absence check joins commit evidence on this
 * column and a join wants a keyed table, not an unnest; and the per-developer
 * list stays bounded by MAX_EMAILS_PER_DEVELOPER at write time
 * (services/developers.ts). `developers.email` REMAINS the primary's home —
 * auth and every existing surface read it — and the row here mirrors it with
 * `is_primary`, backfilled by bootstrap.sql for pre-alias databases.
 * Alias-vs-PRIMARY duplicates are guarded by the same PK because primaries
 * live in this table too. Emails are stored lowercased (normalizeEmail).
 */
export const developerEmails = pgTable(
  "developer_emails",
  {
    email: text("email").primaryKey(),
    developerId: text("developer_id")
      .notNull()
      .references(() => developers.id),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    // Serves "all emails of one developer" (settings, admin list); the PK
    // leads on email and cannot.
    index("developer_emails_developer_idx").on(table.developerId),
  ],
);

/**
 * Reader-side mutes (DESIGN.md §2.1): "I do not want hints/pointers about
 * developer X" — one row per (reader, muted) pair, filtering the READER's
 * unasked surfaces only (services/visibility.ts). Hub-side rather than in the
 * reader's local config so the mute follows the reader across machines.
 */
export const developerMutes = pgTable(
  "developer_mutes",
  {
    readerDeveloperId: text("reader_developer_id")
      .notNull()
      .references(() => developers.id),
    mutedDeveloperId: text("muted_developer_id")
      .notNull()
      .references(() => developers.id),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.readerDeveloperId, table.mutedDeveloperId] }),
  ],
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    developerId: text("developer_id")
      .notNull()
      .references(() => developers.id),
    agentKind: text("agent_kind").notNull(),
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    baseCommit: text("base_commit").notNull(),
    status: text("status", { enum: SESSION_STATUSES }).notNull(),
    startedAt: timestamptz("started_at").notNull(),
    lastHeartbeatAt: timestamptz("last_heartbeat_at").notNull(),
    endedAt: timestamptz("ended_at"),
    /**
     * Set beside `ended_at` when the HUB closed this session on a guess
     * (services/sessions.ts reapStaleSessions), null for every end the
     * connector asked for. The two are different claims: a SessionEnd is a
     * fact reported by the session, a reap is an inference from silence — and
     * an inference has to be revocable, because the only evidence that can
     * disprove it (a record from the session) arrives after the write.
     */
    reapedAt: timestamptz("reaped_at"),
  },
  (table) => [
    index("agent_sessions_repo_idx").on(table.repo),
    index("agent_sessions_heartbeat_idx").on(table.lastHeartbeatAt),
  ],
);

export const workContexts = pgTable("work_contexts", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => agentSessions.id),
  title: text("title").notNull(),
  description: text("description"),
  intent: jsonb("intent").$type<Record<string, unknown>>(),
  status: text("status", { enum: SESSION_STATUSES }).notNull(),
  normalizedDoc: text("normalized_doc"),
  tsv: tsvector("tsv").generatedAlwaysAs(
    sql`to_tsvector('english', coalesce(normalized_doc, ''))`,
  ),
  /** Null until an embedder is configured and has embedded the current doc. */
  embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
  embeddingModel: text("embedding_model"),
  /**
   * When the hub first learned the owning session's base commit is an
   * ancestor of the default branch (DESIGN.md §5 merged-branch detection) —
   * null while unobserved. A COLUMN, not a status transition, and monotonic:
   * git ancestry never un-happens, and the status enum keeps recording what
   * the session was doing (services/landed.ts states the full reasoning).
   */
  landedAt: timestamptz("landed_at"),
  createdAt: timestamptz("created_at").notNull(),
  updatedAt: timestamptz("updated_at"),
});

export const workContextTargets = pgTable(
  "work_context_targets",
  {
    workContextId: text("work_context_id")
      .notNull()
      .references(() => workContexts.id),
    kind: text("kind", { enum: TARGET_KINDS }).notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workContextId, table.kind, table.value] }),
    // The PK leads with work_context_id; the derived-contradictions join
    // matches on (kind, value) alone (services/contradictions.ts), which the
    // PK cannot serve.
    index("work_context_targets_kind_value_idx").on(table.kind, table.value),
  ],
);

export const claims = pgTable(
  "claims",
  {
    id: text("id").primaryKey(),
    workContextId: text("work_context_id")
      .notNull()
      .references(() => workContexts.id),
    authorSessionId: text("author_session_id")
      .notNull()
      .references(() => agentSessions.id),
    kind: text("kind", { enum: CLAIM_KINDS }).notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: CLAIM_STATUSES }).notNull(),
    confidence: doublePrecision("confidence").notNull(),
    captureMode: text("capture_mode", { enum: CAPTURE_MODES }).notNull(),
    provenance: text("provenance", { enum: PROVENANCES }).notNull(),
    dedupCount: integer("dedup_count").notNull().default(1),
    lastSeenAt: timestamptz("last_seen_at"),
    staleAt: timestamptz("stale_at"),
    // Persisted wire refs; materializing supports-edges from them is a
    // follow-up because referenced claims may arrive later in the same flush.
    evidenceRefs: jsonb("evidence_refs")
      .$type<readonly string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', body)`),
    /** Null until an embedder is configured; written once at ingest (append-only). */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    check(
      "claims_body_length_check",
      sql`char_length(${table.body}) <= ${sql.raw(String(MAX_CLAIM_BODY_LENGTH))}`,
    ),
    // ANN index for the ingest gate's nearest-neighbor probes — without it
    // every claim ingest seq-scans all embedded claims (similarity-gate.ts).
    index("claims_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export const claimEdges = pgTable(
  "claim_edges",
  {
    id: text("id").primaryKey(),
    fromClaimId: text("from_claim_id")
      .notNull()
      .references(() => claims.id),
    toClaimId: text("to_claim_id")
      .notNull()
      .references(() => claims.id),
    kind: text("kind", { enum: EDGE_KINDS }).notNull(),
    authorSessionId: text("author_session_id")
      .notNull()
      .references(() => agentSessions.id),
    note: text("note"),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("claim_edges_from_to_kind_idx").on(
      table.fromClaimId,
      table.toClaimId,
      table.kind,
    ),
    // Serves the hints path's "is this claim a supersedes target" probe —
    // the unique index leads on from_claim_id and cannot.
    index("claim_edges_to_kind_idx").on(table.toClaimId, table.kind),
  ],
);

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  claimId: text("claim_id")
    .notNull()
    .references(() => claims.id),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  sensitivity: text("sensitivity", { enum: ARTIFACT_SENSITIVITIES }).notNull(),
  approvedBy: text("approved_by").references(() => developers.id),
  createdAt: timestamptz("created_at").notNull(),
});

/** Outbox table — the bigserial id is the SSE replay cursor (DESIGN.md §2). */
export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/**
 * Similarity-detected contradiction candidates only (ingest gate, DESIGN.md
 * §3). Deterministic candidates — shared target + opposite status — are NOT
 * rows here: services/contradictions.ts derives them fresh per read, so they
 * have no ingest-order dependence and nothing to go stale.
 */
export const contradictionCandidates = pgTable(
  "contradiction_candidates",
  {
    id: text("id").primaryKey(),
    claimAId: text("claim_a_id")
      .notNull()
      .references(() => claims.id),
    claimBId: text("claim_b_id")
      .notNull()
      .references(() => claims.id),
    similarity: doublePrecision("similarity").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("contradiction_candidates_pair_idx").on(
      table.claimAId,
      table.claimBId,
    ),
  ],
);

/**
 * Latest commit-authorship evidence per (repo, commit author) — the absence
 * check's ground truth (absence detection). UPSERT-only, never append: one row
 * per author per repo, so the table is bounded by how many people commit, not
 * by how often connectors report. Ingest prunes rows whose newest commit fell
 * out of COMMIT_EVIDENCE_RETENTION_DAYS — and rows claiming a timestamp past
 * the hub's own clock plus skew, which the age test alone could never retire
 * and which ingest also clamps on write (services/commit-evidence.ts), so
 * retention cannot be outrun by a forged date. Together that is the whole
 * retention story.
 *
 * `author_email` is stored lowercased and is the matching key against
 * `developers.email`. It never leaves the hub: absence responses carry names
 * only (services/absences.ts).
 */
export const commitEvidence = pgTable(
  "commit_evidence",
  {
    repo: text("repo").notNull(),
    authorEmail: text("author_email").notNull(),
    authorName: text("author_name").notNull(),
    latestCommitAt: timestamptz("latest_commit_at").notNull(),
    commitCount: integer("commit_count").notNull(),
    windowDays: integer("window_days").notNull(),
    collectedAt: timestamptz("collected_at").notNull(),
    reportedBy: text("reported_by")
      .notNull()
      .references(() => developers.id),
  },
  (table) => [primaryKey({ columns: [table.repo, table.authorEmail] })],
);

export const hintDeliveries = pgTable("hint_deliveries", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => agentSessions.id),
  refKind: text("ref_kind", { enum: ["claim", "work_context"] }).notNull(),
  refId: text("ref_id").notNull(),
  deliveredAt: timestamptz("delivered_at").notNull(),
  pulledAt: timestamptz("pulled_at"),
});