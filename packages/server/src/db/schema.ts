import {
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  ARTIFACT_SENSITIVITIES,
  CAPTURE_MODES,
  CLAIM_KINDS,
  CLAIM_STATUSES,
  EDGE_KINDS,
  PROVENANCES,
  SESSION_STATUSES,
  TARGET_KINDS,
} from "@crosscheck/schema";

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const developers = pgTable("developers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

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
  intent: jsonb("intent").$type<Record<string, unknown>>(),
  status: text("status", { enum: SESSION_STATUSES }).notNull(),
  // tsv + embedding vector columns are added with the search block
  normalizedDoc: text("normalized_doc"),
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
  ],
);

export const claims = pgTable("claims", {
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
  // tsv + embedding vector columns are added with the search block
  createdAt: timestamptz("created_at").notNull(),
});

export const claimEdges = pgTable("claim_edges", {
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
});

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