import { z } from "zod";

import { hubRequest } from "./client.ts";
import type { HubContext, HubResult } from "./client.ts";

/**
 * Re-exported, because they are part of THIS module's signature.
 *
 * Every endpoint below returns `HubResult<T>` and takes a `HubContext`, so a
 * caller of `getDiagnosis` cannot name what it got back without them. Leaving
 * them unexported made `import type { HubResult } from "./hub.ts"` a TS2459 in
 * two files — and the third error was the CASCADE, not a separate defect: with
 * `HubResult` unresolved, `tree.data` degraded to `any`, and extend_diagnosis's
 * target-claim check went unchecked at compile time (TS7006 on the callback
 * parameter). One missing export, three errors.
 *
 * Sending callers to ./client.ts instead would be the other fix and a worse one:
 * client.ts is the transport, hub.ts is the API, and a tool that imports one
 * type from each has two modules to follow when either moves.
 */
export type { HubContext, HubResult } from "./client.ts";

/**
 * A work context's intent as the hub serves it (trial finding #16): the
 * sentence and its provenance, which the renderers turn into a "(derived)"
 * label by positive equality on "declared" — confidence is never printed for
 * an intent. Tolerant PER FIELD at every row that carries one: a malformed
 * intent drops the INTENT (`catch(undefined)`), never the row — the same
 * posture as `baseCommit`, and the opposite of the hub's own ingest schema,
 * which is strict because nobody but this connector writes the field.
 */
export const IntentEntrySchema = z.looseObject({
  // No maximum on purpose, and every CONSUMER therefore owes one: dropping a
  // whole intent because a hub sent a long one would cost an ordinary row its
  // plan clause. The renderers cut at INTENT_MAX_CHARS (briefing/intent.ts)
  // and the ghost worker at MAX_INTENT_SUMMARY_CHARS before this sentence
  // reaches a model's stdin (connector-claude ghost/worker.ts).
  summary: z.string().min(1),
  provenance: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  capturedAt: z.string().optional(),
});

export type IntentEntry = z.infer<typeof IntentEntrySchema>;

/** Null from the hub means "none"; anything unparseable reads the same way. */
const tolerantIntent = IntentEntrySchema.nullable().optional().catch(undefined);

export const PresenceEntrySchema = z.looseObject({
  sessionId: z.string().min(1),
  developerId: z.string().min(1),
  developerName: z.string().min(1),
  branch: z.string().min(1),
  /** Optional: an older hub may not send it, and drift is then simply omitted. */
  baseCommit: z.string().min(1).optional(),
  status: z.string().min(1),
  lastHeartbeatAt: z.string().min(1),
  isSelf: z.boolean(),
  /** The session's work-context intent; older hubs send none. */
  intent: tolerantIntent,
});

export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

export const WorkContextEntrySchema = z.looseObject({
  id: z.string().min(1),
  developerId: z.string().min(1),
  /** Authoritative author label; presence is only the fallback (DESIGN.md §4). */
  developerName: z.string().min(1).optional(),
  title: z.string().min(1),
  status: z.string().min(1),
  intent: tolerantIntent,
  /** Optional: an older hub omits both, and landed detection simply skips. */
  baseCommit: z.string().min(1).optional(),
  landedAt: z.string().nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().nullable().optional(),
});

export type WorkContextEntry = z.infer<typeof WorkContextEntrySchema>;

/**
 * One malformed row must not cost the whole briefing, so rows are validated
 * individually and unparseable ones are dropped.
 */
const tolerantList = <T>(
  field: string,
  itemSchema: z.ZodType<T>,
): z.ZodType<readonly T[]> =>
  z
    .looseObject({ [field]: z.array(z.unknown()) })
    .transform((value) =>
      (value[field] as unknown[])
        .map((item) => itemSchema.safeParse(item))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data),
    );

const SessionResponseSchema = z.looseObject({
  session: z.looseObject({
    id: z.string().min(1),
    developerId: z.string().min(1),
  }),
});

/**
 * Per-record outcome, which the hub has always returned and this client used to
 * discard.
 *
 * The counts alone are enough for a spool flush — it retries or abandons a batch
 * whole — but not for an MCP tool, whose entire contract is that a refusal
 * reaches the agent as something it can act on. `rejected: 1` cannot be turned
 * into "supersedes requires ownership of both claims"; `issues` can.
 *
 * Optional because it is READ, not required: an older hub that omits the field
 * leaves every count working exactly as before, and the tools fall back to
 * saying the record was rejected without a reason.
 */
const RecordResultSchema = z.looseObject({
  index: z.number().int().min(0),
  status: z.string().min(1),
  id: z.string().min(1).optional(),
  issues: z.array(z.string()).optional(),
});

export type RecordResult = z.infer<typeof RecordResultSchema>;

const IngestSummarySchema = z.looseObject({
  accepted: z.number().int().min(0),
  duplicates: z.number().int().min(0),
  ignored: z.number().int().min(0),
  rejected: z.number().int().min(0),
  results: z.array(RecordResultSchema).optional(),
});

export type IngestSummary = z.infer<typeof IngestSummarySchema>;

export interface RegisterSessionInput {
  readonly id: string;
  readonly agentKind: string;
  readonly repo: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly status: string;
}

const encodeRepo = (repo: string): string =>
  `?repo=${encodeURIComponent(repo)}`;

export const registerSession = (
  ctx: HubContext,
  input: RegisterSessionInput,
): Promise<HubResult<z.infer<typeof SessionResponseSchema>>> =>
  hubRequest(ctx, {
    method: "POST",
    path: "/api/sessions",
    schema: SessionResponseSchema,
    body: input,
  });

export const heartbeatSession = (
  ctx: HubContext,
  sessionId: string,
  status?: string,
): Promise<HubResult<unknown>> =>
  hubRequest(ctx, {
    method: "POST",
    path: `/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
    schema: z.unknown(),
    body: status === undefined ? {} : { status },
  });

export const endSession = (
  ctx: HubContext,
  sessionId: string,
): Promise<HubResult<unknown>> =>
  hubRequest(ctx, {
    method: "POST",
    path: `/api/sessions/${encodeURIComponent(sessionId)}/end`,
    schema: z.unknown(),
    body: { status: "done" },
  });

export const postRecords = (
  ctx: HubContext,
  records: readonly unknown[],
): Promise<HubResult<IngestSummary>> =>
  hubRequest(ctx, {
    method: "POST",
    path: "/api/records",
    schema: IngestSummarySchema,
    body: { records },
  });

export const getPresence = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<readonly PresenceEntry[]>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/presence${encodeRepo(repo)}`,
    schema: tolerantList("sessions", PresenceEntrySchema),
  });

export const getWorkContexts = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<readonly WorkContextEntry[]>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/work-contexts${encodeRepo(repo)}`,
    schema: tolerantList("workContexts", WorkContextEntrySchema),
  });

/**
 * One absence finding. Names only — the hub keeps commit
 * author emails to itself as its matching key. `kind` is an open string on
 * the wire: a kind this client does not know renders nothing rather than
 * failing the row (briefing/render.ts skips it).
 */
export const AbsenceEntrySchema = z.looseObject({
  kind: z.string().min(1),
  name: z.string().min(1),
  latestCommitAt: z.string().min(1),
  lastSessionAt: z.string().nullable().optional(),
  evidenceCollectedAt: z.string().min(1),
});

export type AbsenceEntry = z.infer<typeof AbsenceEntrySchema>;

export const getAbsences = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<readonly AbsenceEntry[]>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/absences${encodeRepo(repo)}`,
    schema: tolerantList("absences", AbsenceEntrySchema),
  });

/**
 * One "solved before" match (VISION.md §1): a solved tree sharing a strong
 * target with current work on this repo — or, through the content-identity
 * kind, on ANY repo of this hub, which is why the row names its own. A
 * pointer plus, for the strongest match only, the one sentence the tree
 * settled on: title, author, repo, ages, the id to pull, and `rootCause`
 * (DESIGN.md §4 — evidence makes a claim trustworthy, content identity makes
 * it relevant, and asserting it unasked needs both).
 */
export const SolvedMatchEntrySchema = z.looseObject({
  workContextId: z.string().min(1),
  title: z.string().min(1),
  developerName: z.string().min(1).optional(),
  /**
   * The repo the SOLVED tree lives in — sent on every row, this repo's rows
   * included. OPTIONAL because a hub too old to serve it only ever matched
   * inside the asking repo, which is exactly what "absent" then means; a
   * newer hub's cross-repo row always carries it, and a row that claims a
   * repo the renderer cannot print is dropped rather than shown as local.
   */
  repo: z.string().min(1).optional(),
  solvedAt: z.string().min(1),
  landedAt: z.string().nullable().optional(),
  /** Open string: an unknown kind renders nothing (briefing/render.ts). */
  matchedTargetKind: z.string().min(1),
  /**
   * What the tree says the cause WAS. The hub sends it only for a
   * fingerprint match; the renderer requires the same kind again before it
   * prints anything, so a hub that sent a body beside a weaker match — a
   * newer one with different rules, or a hostile one — buys no substance
   * (briefing/render.ts `solvedRootCauseLine`).
   */
  rootCause: z.string().min(1).nullable().optional(),
  /**
   * The confidence of the claim `rootCause` quotes. OPTIONAL on the wire and
   * REQUIRED at render: a body without its labels is substance this renderer
   * will not vouch for, so the cause line is dropped and the pointer stays
   * (briefing/render.ts `solvedRootCauseLine`). Optional because the field
   * is younger than the type and a hub is allowed to be older; required at
   * render because DESIGN.md §4's rule is about what reaches the reader.
   */
  rootCauseConfidence: z.number().min(0).max(1).nullable().optional(),
});

export type SolvedMatchEntry = z.infer<typeof SolvedMatchEntrySchema>;

/** One more parallel GET inside the SessionStart fetch block (fail open). */
export const getSolvedMatches = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<readonly SolvedMatchEntry[]>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/solved-matches${encodeRepo(repo)}`,
    schema: tolerantList("matches", SolvedMatchEntrySchema),
  });

/**
 * The precision counters for solved pointers (VISION.md §1): how many this
 * reader was shown on this repo inside the hub's window, and how many they
 * then pulled. A hub too old to know the parameter answers the ordinary
 * listing, whose `counts` block is absent — read as zeros, which the
 * surfaces print as "not measured" rather than as a bad score.
 */
export const SolvedMatchCountsSchema = z.looseObject({
  shown: z.number().int().min(0).default(0),
  pulled: z.number().int().min(0).default(0),
  windowDays: z.number().int().min(1).default(30),
});

export type SolvedMatchCounts = z.infer<typeof SolvedMatchCountsSchema>;

const EMPTY_SOLVED_COUNTS: SolvedMatchCounts = {
  shown: 0,
  pulled: 0,
  windowDays: 30,
};

const SolvedCountsResponseSchema = z
  .looseObject({ counts: z.unknown().optional() })
  .transform((value): SolvedMatchCounts => {
    const counts = SolvedMatchCountsSchema.safeParse(value.counts);
    // A counts block this client cannot read is treated as no counts at all:
    // a number the reader cannot trust is worse than no number.
    return counts.success ? counts.data : EMPTY_SOLVED_COUNTS;
  });

export const getSolvedMatchCounts = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<SolvedMatchCounts>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/solved-matches${encodeRepo(repo)}&counts=1`,
    schema: SolvedCountsResponseSchema,
  });

/**
 * The failure-time probe: solved trees carrying THIS exact fingerprint,
 * asked once, the moment a tool fails. Same route and same row shape as the
 * listing above — which is exactly why an OLDER HUB IS A CORRECTNESS
 * PROBLEM here and not only a wasted round trip: a hub that predates the
 * parameter ignores it and answers the ordinary shared-target listing, so
 * this call returns file- and intent-matched rows under a caller whose
 * header asserts content identity.
 *
 * The seen-set does NOT save that case, and an earlier version of this
 * comment claimed it did. It holds this session's delivered refs plus the
 * handful of pointers the briefing showed — empty on a fresh session — so
 * on the common path it drops nothing. What makes an old hub safe is the
 * caller REQUIRING `matchedTargetKind` to be the kind its sentence names,
 * in `selectAndRenderSolvedHint` and again in `renderSolvedHint`; against
 * such a hub the probe then costs one wasted round trip and stays silent.
 */
export const getSolvedMatchesForFingerprint = (
  ctx: HubContext,
  repo: string,
  fingerprint: string,
): Promise<HubResult<readonly SolvedMatchEntry[]>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/solved-matches${encodeRepo(repo)}&fingerprint=${encodeURIComponent(fingerprint)}`,
    schema: tolerantList("matches", SolvedMatchEntrySchema),
  });

/**
 * One of the developer's OWN unreviewed Tier-1 drafts (DESIGN.md §3 Tier 1
 * promotion loop). The hub only ever serves the CALLER's drafts here, so a
 * body is self-directed text — still sanitized at render like everything
 * machine-derived. `captureMode`/`dedupCount` optional: an older shape stays
 * parseable and the renderer does not use them.
 */
/**
 * One value the reader's own session and a teammate's both carry (VISION.md
 * §3). `kind` is an OPEN string: a hub that learns a new target kind must not
 * cost this connector the whole row, and the renderer maps kinds it knows and
 * prints nothing for the rest.
 */
export const GhostSharedTargetSchema = z.looseObject({
  kind: z.string().min(1),
  value: z.string().min(1),
});

export type GhostSharedTarget = z.infer<typeof GhostSharedTargetSchema>;

/**
 * One teammate whose LIVE plan overlaps the reader's own — a POINTER, like
 * every other proactive teammate surface: who, since when, what is shared,
 * what they say they are doing, and the id that reads their tree. No claim
 * body is on this wire at all (DESIGN.md §4).
 *
 * THE SAMPLE IS FINGERPRINT-FIRST, and the renderer depends on it: the hub
 * sorts `sharedTargets` by kind ascending before bounding it, and
 * "error_fingerprint" sorts first, so a shared FAILURE is always inside the
 * sample when one exists (packages/server/src/services/ghost-overlap.ts). The
 * renderer therefore reads "did we hit the same failure" off the sample
 * rather than needing a second count on the wire. A hub that stopped sorting
 * would cost the line its strongest clause, which is what the render test
 * pins.
 */
export const GhostCheckEntrySchema = z.looseObject({
  workContextId: z.string().min(1),
  title: z.string().min(1),
  developerId: z.string().min(1),
  developerName: z.string().min(1).optional(),
  intent: tolerantIntent,
  lastActiveAt: z.string().min(1),
  sharedTargets: z.array(GhostSharedTargetSchema).catch([]),
  sharedTargetCount: z.number().int().min(0).catch(0),
  /**
   * Distinct words of the READER'S OWN intent this context matched. Any
   * positive value is already above the hub's floor — the hub never reports a
   * count below it — so the renderer needs no copy of that constant.
   */
  intentTokenHits: z.number().int().min(0).catch(0),
});

export type GhostCheckEntry = z.infer<typeof GhostCheckEntrySchema>;

/**
 * One more parallel GET inside the SessionStart fetch block, and the call
 * `set_intent` repeats the moment a plan is declared. Fail open: a hub too
 * old to serve it renders no section.
 */
export const getGhostChecks = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<readonly GhostCheckEntry[]>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/ghost-checks${encodeRepo(repo)}`,
    schema: tolerantList("ghostChecks", GhostCheckEntrySchema),
  });

export const DraftEntrySchema = z.looseObject({
  id: z.string().min(1),
  workContextId: z.string().min(1),
  kind: z.string().min(1),
  body: z.string(),
  status: z.string().min(1),
  confidence: z.number().min(0).max(1),
  captureMode: z.string().min(1).optional(),
  dedupCount: z.number().int().min(0).optional(),
  createdAt: z.string().min(1),
});

export type DraftEntry = z.infer<typeof DraftEntrySchema>;

/** One more parallel GET inside the SessionStart fetch block (fail open). */
export const getDrafts = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<readonly DraftEntry[]>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/drafts${encodeRepo(repo)}`,
    schema: tolerantList("drafts", DraftEntrySchema),
  });

/**
 * One claim of a diagnosis tree.
 *
 * `authorDeveloperName` is the field that makes a tree readable by somebody who
 * did not write it: `authorSessionId` is an opaque `cc_<uuid>`, and a reader
 * holding one has no second endpoint that turns it into a person. It is optional
 * only so an older hub does not make the whole row unparseable — the renderer
 * says "an unnamed teammate" rather than dropping the claim.
 */
export const DiagnosisClaimSchema = z.looseObject({
  id: z.string().min(1),
  workContextId: z.string().min(1),
  authorSessionId: z.string().min(1),
  authorDeveloperId: z.string().min(1).optional(),
  authorDeveloperName: z.string().min(1).optional(),
  kind: z.string().min(1),
  body: z.string(),
  status: z.string().min(1),
  confidence: z.number(),
  captureMode: z.string().min(1),
  provenance: z.string().min(1),
  dedupCount: z.number().int().min(0),
  evidenceRefs: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
});

export type DiagnosisClaim = z.infer<typeof DiagnosisClaimSchema>;

export const DiagnosisEdgeSchema = z.looseObject({
  id: z.string().min(1),
  fromClaimId: z.string().min(1),
  toClaimId: z.string().min(1),
  kind: z.string().min(1),
  authorSessionId: z.string().min(1),
  note: z.string().nullable().optional(),
  createdAt: z.string().min(1),
});

export type DiagnosisEdge = z.infer<typeof DiagnosisEdgeSchema>;

/** Foreign endpoint of a cross-context edge: id and kind, never a body. */
export const ExternalClaimRefSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  workContextId: z.string().min(1),
});

export type ExternalClaimRef = z.infer<typeof ExternalClaimRefSchema>;

export const DiagnosisWorkContextSchema = z.looseObject({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  intent: tolerantIntent,
  status: z.string().min(1),
  /** Optional: an older hub omits both — drift and the landed line simply skip. */
  baseCommit: z.string().min(1).optional(),
  landedAt: z.string().nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().nullable().optional(),
});

export type DiagnosisWorkContext = z.infer<typeof DiagnosisWorkContextSchema>;

/** One deterministic target of the tree — the staleness check reads files. */
export const DiagnosisTargetSchema = z.looseObject({
  kind: z.string().min(1),
  value: z.string().min(1),
});

export type DiagnosisTarget = z.infer<typeof DiagnosisTargetSchema>;

export interface Diagnosis {
  readonly workContext: DiagnosisWorkContext;
  readonly claims: readonly DiagnosisClaim[];
  readonly edges: readonly DiagnosisEdge[];
  readonly externalClaims: readonly ExternalClaimRef[];
  /**
   * The tree's targets (hub-bounded). Counted into droppedRows when rows do
   * not parse: a dropped FILE target silently narrows the staleness check,
   * and the diagnosis is the surface where degradation must be said.
   */
  readonly targets: readonly DiagnosisTarget[];
  /** The hub hit its own 500/1000 bound — the tree returned is partial. */
  readonly truncated: boolean;
  /**
   * Rows the hub sent that this client could not parse, and therefore dropped.
   *
   * Counted rather than swallowed. Tolerant per-row parsing is right here for
   * the same reason it is right for the briefing — one bad row must not cost the
   * whole tree — but a diagnosis is the thing the reader is reasoning FROM, so a
   * silently shorter tree is a worse failure than a noisy one. The renderer says
   * how many went missing (rule: a degraded state always has a surface).
   */
  readonly droppedRows: number;
}

/**
 * Parses the rows of one field, dropping what will not parse and counting it.
 * Mirrors `tolerantList` above; separate because the drop count is kept.
 */
const parseRows = <T>(
  raw: unknown,
  schema: z.ZodType<T>,
): { readonly rows: readonly T[]; readonly dropped: number } => {
  if (!Array.isArray(raw)) {
    return { rows: [], dropped: 0 };
  }
  const parsed = raw.map((item) => schema.safeParse(item));
  return {
    rows: parsed.filter((entry) => entry.success).map((entry) => entry.data),
    dropped: parsed.filter((entry) => !entry.success).length,
  };
};

const DiagnosisEnvelopeSchema = z
  .looseObject({
    workContext: DiagnosisWorkContextSchema,
    claims: z.array(z.unknown()).default([]),
    edges: z.array(z.unknown()).default([]),
    externalClaims: z.array(z.unknown()).default([]),
    targets: z.array(z.unknown()).default([]),
    truncated: z.boolean().default(false),
  })
  .transform((value): Diagnosis => {
    const claims = parseRows(value.claims, DiagnosisClaimSchema);
    const edges = parseRows(value.edges, DiagnosisEdgeSchema);
    const external = parseRows(value.externalClaims, ExternalClaimRefSchema);
    const targets = parseRows(value.targets, DiagnosisTargetSchema);
    return {
      workContext: value.workContext,
      claims: claims.rows,
      edges: edges.rows,
      externalClaims: external.rows,
      targets: targets.rows,
      truncated: value.truncated,
      droppedRows:
        claims.dropped + edges.dropped + external.dropped + targets.dropped,
    };
  });

export const getDiagnosis = (
  ctx: HubContext,
  workContextId: string,
): Promise<HubResult<Diagnosis>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/work-contexts/${encodeURIComponent(workContextId)}/diagnosis`,
    schema: DiagnosisEnvelopeSchema,
  });

/**
 * One hub search result. A superset of WorkContextEntry: the hub adds the
 * match tier and fused score. Both optional on the wire so an older hub's
 * plain rows still parse — the renderer never prints them anyway.
 */
export const SearchResultEntrySchema = z.looseObject({
  id: z.string().min(1),
  developerId: z.string().min(1),
  developerName: z.string().min(1).optional(),
  title: z.string().min(1),
  status: z.string().min(1),
  intent: tolerantIntent,
  createdAt: z.string().min(1),
  updatedAt: z.string().nullable().optional(),
  tier: z.string().min(1).optional(),
  score: z.number().optional(),
  /** Solved-tree marker (VISION.md §1); optional — older hubs send neither. */
  resultKind: z.string().min(1).optional(),
  solvedAt: z.string().nullable().optional(),
});

export type SearchResultEntry = z.infer<typeof SearchResultEntrySchema>;

/**
 * WHICH FILTERS THE HUB APPLIED (roadmap R1), reported rather than assumed.
 *
 * The renderer states the filters in the answer, so it must state what RAN:
 * the developer term was a name or an address the hub resolved, and `isSelf`
 * is a comparison only the hub can make, because it is the side that
 * authenticated the caller. Exactly the `vectorTierActive` discipline.
 */
export interface SearchFilters {
  readonly developer: {
    readonly name: string;
    /**
     * The hub sends it only when the display name is shared; null otherwise,
     * and null from any hub too old to send it at all.
     */
    readonly email: string | null;
    readonly isSelf: boolean;
  } | null;
  /** ISO instant the window starts at; null when no window was asked for. */
  readonly since: string | null;
}

export interface SearchOutcome {
  readonly results: readonly SearchResultEntry[];
  /** True only when the hub's vector tier ran for this search (DESIGN.md §6). */
  readonly vectorTierActive: boolean;
  /** Null from a hub that predates the filters — then nothing is claimed. */
  readonly filters: SearchFilters | null;
}

const SearchFiltersSchema = z.looseObject({
  developer: z
    .looseObject({
      name: z.string().min(1),
      // Absent from a hub that predates it, and absent from a current hub
      // whenever the name identifies one person — both mean "the name is all
      // there is to say", which is what the renderer then prints.
      email: z.string().min(1).nullable().default(null),
      isSelf: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  since: z.string().min(1).nullable().default(null),
});

const SearchResponseSchema = z
  .looseObject({
    results: z.array(z.unknown()).default([]),
    vectorTierActive: z.boolean().default(false),
    // Tolerant like every other optional block: an older hub sends nothing,
    // and a malformed one is treated as nothing — a filter line the reader
    // cannot trust is worse than no filter line at all.
    filters: z.unknown().optional(),
  })
  .transform((value): SearchOutcome => {
    const filters = SearchFiltersSchema.safeParse(value.filters);
    return {
      // Tolerant rows, silent drop — a listing, like tolerantList above; the
      // diagnosis path counts its drops because a TREE must not silently
      // shrink, a search result list is advisory by nature.
      results: parseRows(value.results, SearchResultEntrySchema).rows,
      vectorTierActive: value.vectorTierActive,
      filters: filters.success ? filters.data : null,
    };
  });

export interface SearchRequest {
  readonly query: string;
  /** Relevance filter, never a boundary (DESIGN.md §2.1). */
  readonly repo: string;
  readonly limit: number;
  /** A teammate's name or any email they are known by; resolved hub-side. */
  readonly developer?: string | undefined;
  /** `14d`, `72h` or an ISO date; parsed and bounded hub-side. */
  readonly since?: string | undefined;
}

export const searchWorkContexts = (
  ctx: HubContext,
  request: SearchRequest,
): Promise<HubResult<SearchOutcome>> => {
  const params = new URLSearchParams({
    query: request.query,
    repo: request.repo,
    limit: String(request.limit),
  });
  // Sent only when asked for: an empty `developer=` would be a filter naming
  // nobody, and the hub is right to refuse one.
  if (request.developer !== undefined) {
    params.set("developer", request.developer);
  }
  if (request.since !== undefined) {
    params.set("since", request.since);
  }
  return hubRequest(ctx, {
    method: "GET",
    path: `/api/search?${params.toString()}`,
    schema: SearchResponseSchema,
  });
};

/**
 * One claim as the hints endpoint sends it: enough for the selector's
 * anchoring rules and the renderer's trust labels, never the whole tree.
 * `evidenceRefCount` (not the refs) because the selector only asks "any?".
 */
export const HintClaimCandidateSchema = z.looseObject({
  id: z.string().min(1),
  workContextId: z.string().min(1),
  kind: z.string().min(1),
  status: z.string().min(1),
  // Bounded like the canonical ClaimSchema (@crosscheck/schema): rendered as
  // a trust label, so `confidence 1e+30` from a hostile hub is a forged
  // credential, not a number — the row is dropped, silence follows.
  confidence: z.number().min(0).max(1),
  provenance: z.string().min(1),
  captureMode: z.string().min(1).optional(),
  evidenceRefCount: z.number().int().min(0).default(0),
  authorDeveloperId: z.string().min(1),
  authorDeveloperName: z.string().min(1).optional(),
  body: z.string(),
  createdAt: z.string().min(1),
});

export type HintClaimCandidate = z.infer<typeof HintClaimCandidateSchema>;

const HintContextSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  /**
   * The context's intent (trial finding #16) — the pointer hint shows it, and
   * the selector lets an intent-only context (no claims) become a pointer.
   */
  intent: tolerantIntent,
  /** Optional: an older hub sends no tier, and no tier means no precision. */
  tier: z.string().min(1).optional(),
  developerId: z.string().min(1),
  developerName: z.string().min(1).optional(),
  /** For the drift label; "" from the hub means unknown. */
  baseCommit: z.string().optional(),
  /**
   * Solved-tree presentation (VISION.md §1). Optional: an older hub sends
   * neither, and no label renders — the hint is merely undecorated.
   */
  resultKind: z.string().min(1).optional(),
  solvedAt: z.string().nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().nullable().optional(),
});

export const HintContextCandidateSchema = z
  .looseObject({
    workContext: HintContextSchema,
    claims: z.array(z.unknown()).default([]),
  })
  .transform((value) => ({
    workContext: value.workContext,
    // Tolerant rows, silent drop — candidates are advisory, like search rows.
    claims: parseRows(value.claims, HintClaimCandidateSchema).rows,
  }));

export type HintContextCandidate = z.infer<typeof HintContextCandidateSchema>;

export interface HintCandidatesRequest {
  readonly query: string;
  /** Relevance filter, never a boundary (DESIGN.md §2.1). */
  readonly repo: string;
}

/** The UserPromptSubmit fast path's ONE bounded hub call (DESIGN.md §4). */
/**
 * One ANSWER to a question the READER asked (roadmap R2) — the only wire
 * shape in this file that carries a claim body on the PROACTIVE path.
 *
 * That is the §4 solicited exception, and it is legible here: the hub only
 * ever puts a row in this list when the caller is the question's AUTHOR, so
 * the substance was asked for. Everything else about it is unchanged —
 * author, provenance, age and status all travel, because a solicited answer
 * still gets the trust labels every injected claim gets.
 */
export const AnsweredQuestionSchema = z.looseObject({
  questionId: z.string().min(1),
  questionBody: z.string().min(1),
  claimId: z.string().min(1),
  /** The tree the claim sits in — the argument get_diagnosis takes. Optional
   * so an older hub that omits it simply loses the clause that names it. */
  workContextId: z.string().min(1).optional(),
  claimBody: z.string(),
  claimKind: z.string().min(1),
  claimStatus: z.string().min(1),
  // Bounded like every rendered confidence: a forged `1e+30` is a credential,
  // not a number, and the row is dropped rather than rendered.
  confidence: z.number().min(0).max(1),
  provenance: z.string().min(1),
  answererDeveloperName: z.string().min(1),
  answeredAt: z.string().min(1),
});

export type AnsweredQuestion = z.infer<typeof AnsweredQuestionSchema>;

/** What the ONE bounded prompt-time call brings back (DESIGN.md §4). */
export interface HintCandidatesResult {
  readonly candidates: readonly HintContextCandidate[];
  /**
   * Answers to the caller's OWN questions that no session of theirs has been
   * handed yet. Empty from any hub too old to send the field — the hint path
   * then behaves exactly as it did before R2.
   */
  readonly answers: readonly AnsweredQuestion[];
}

const HintCandidatesResponseSchema = z
  .looseObject({
    candidates: z.array(z.unknown()).default([]),
    answers: z.array(z.unknown()).default([]),
  })
  .transform(
    (value): HintCandidatesResult => ({
      // Tolerant rows, silent drop — a candidate list is advisory by nature.
      candidates: parseRows(value.candidates, HintContextCandidateSchema).rows,
      answers: parseRows(value.answers, AnsweredQuestionSchema).rows,
    }),
  );

export const getHintCandidates = (
  ctx: HubContext,
  request: HintCandidatesRequest,
): Promise<HubResult<HintCandidatesResult>> => {
  const params = new URLSearchParams({
    query: request.query,
    repo: request.repo,
  });
  return hubRequest(ctx, {
    method: "GET",
    path: `/api/hints/candidates?${params.toString()}`,
    schema: HintCandidatesResponseSchema,
  });
};

/**
 * One question addressed TO the reader — the briefing's "Questions for you"
 * block and `list_open_questions`.
 *
 * A POINTER-SHAPED ROW with one deliberate exception: it carries the question
 * BODY. A question is not a finding — it asserts nothing, it has no evidence
 * and it cannot be cited — and a pointer saying "Ken asked you something"
 * without the question would be unanswerable, which is the whole failure mode
 * the channel exists to avoid. It is still untrusted PROSE and is framed at
 * every surface that shows it.
 */
export const InboxQuestionSchema = z.looseObject({
  id: z.string().min(1),
  authorDeveloperId: z.string().min(1),
  authorDeveloperName: z.string().min(1),
  body: z.string().min(1),
  workContextId: z.string().nullable().optional(),
  workContextTitle: z.string().nullable().optional(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type InboxQuestion = z.infer<typeof InboxQuestionSchema>;

/** The counters `crosscheck status` prints and `doctor` warns on. */
export const QuestionCountsSchema = z.looseObject({
  openToMe: z.number().int().min(0).default(0),
  oldestToMeAt: z.string().nullable().default(null),
  /**
   * Who asked that oldest one — BARE untrusted text, framed like every other
   * teammate name at the surfaces that print it. Null from any hub too old to
   * send it, which is why the doctor keeps its nameless wording as a fallback.
   */
  oldestToMeFrom: z.string().nullable().default(null),
  asked: z.number().int().min(0).default(0),
  askedAnswered: z.number().int().min(0).default(0),
  askedExpired: z.number().int().min(0).default(0),
});

export type QuestionCounts = z.infer<typeof QuestionCountsSchema>;

export interface QuestionsView {
  readonly inbox: readonly InboxQuestion[];
  readonly answers: readonly AnsweredQuestion[];
  readonly counts: QuestionCounts;
}

const EMPTY_COUNTS: QuestionCounts = {
  openToMe: 0,
  oldestToMeAt: null,
  oldestToMeFrom: null,
  asked: 0,
  askedAnswered: 0,
  askedExpired: 0,
};

const QuestionsResponseSchema = z
  .looseObject({
    inbox: z.array(z.unknown()).default([]),
    answers: z.array(z.unknown()).default([]),
    counts: z.unknown().optional(),
  })
  .transform((value): QuestionsView => {
    const counts = QuestionCountsSchema.safeParse(value.counts);
    return {
      inbox: parseRows(value.inbox, InboxQuestionSchema).rows,
      answers: parseRows(value.answers, AnsweredQuestionSchema).rows,
      // A counts block this client cannot read is treated as no counts at
      // all: a number the reader cannot trust is worse than no number.
      counts: counts.success ? counts.data : EMPTY_COUNTS,
    };
  });

/**
 * The reader's own question state. `answerable` asks for the PULL shape —
 * the same inbox WITHOUT the reader's mute filter, which is what
 * `list_open_questions` wants: a mute covers unasked surfaces, and a pull is
 * not one (DESIGN.md §2.1). The briefing asks without it. An older hub
 * ignores the parameter and answers the muted shape, which is the safe
 * direction to be wrong in: it shows less, never more.
 */
export const getQuestions = (
  ctx: HubContext,
  repo: string,
  options: { readonly answerable?: boolean } = {},
): Promise<HubResult<QuestionsView>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/questions${encodeRepo(repo)}${options.answerable === true ? "&answerable=1" : ""}`,
    schema: QuestionsResponseSchema,
  });

export interface AskQuestionRequest {
  readonly id: string;
  readonly repo: string;
  readonly sessionId: string;
  readonly body: string;
  /** A teammate's name or any address they are known by; resolved hub-side. */
  readonly developer?: string | undefined;
  readonly workContextId?: string | undefined;
}

const AskQuestionResponseSchema = z.looseObject({
  question: z.looseObject({ id: z.string().min(1) }).optional(),
  questionId: z.string().min(1).optional(),
  /** Who the hub resolved the question to — BARE untrusted at the surface. */
  targetDeveloperName: z.string().min(1).optional(),
  duplicate: z.boolean().default(false),
});

export type AskQuestionResponse = z.infer<typeof AskQuestionResponseSchema>;

export const askQuestion = (
  ctx: HubContext,
  request: AskQuestionRequest,
): Promise<HubResult<AskQuestionResponse>> =>
  hubRequest(ctx, {
    method: "POST",
    path: "/api/questions",
    schema: AskQuestionResponseSchema,
    body: {
      id: request.id,
      repo: request.repo,
      sessionId: request.sessionId,
      body: request.body,
      ...(request.developer === undefined
        ? {}
        : { developer: request.developer }),
      ...(request.workContextId === undefined
        ? {}
        : { workContextId: request.workContextId }),
    },
  });

const AnswerQuestionResponseSchema = z.looseObject({
  questionId: z.string().min(1).optional(),
  claimId: z.string().min(1).optional(),
  duplicate: z.boolean().default(false),
});

export type AnswerQuestionResponse = z.infer<
  typeof AnswerQuestionResponseSchema
>;

export const answerQuestion = (
  ctx: HubContext,
  questionId: string,
  claim: unknown,
): Promise<HubResult<AnswerQuestionResponse>> =>
  hubRequest(ctx, {
    method: "POST",
    path: `/api/questions/${encodeURIComponent(questionId)}/answers`,
    schema: AnswerQuestionResponseSchema,
    body: { claim },
  });

/**
 * One side of a listed contradiction — just enough for a one-line pointer:
 * who holds it, what kind of theory, in what status. Bodies are deliberately
 * absent from the pointer path; the case file is a pull (get_referee_brief).
 */
export const ContradictionSideSchema = z.looseObject({
  id: z.string().min(1),
  workContextId: z.string().min(1),
  kind: z.string().min(1),
  status: z.string().min(1),
  authorDeveloperName: z.string().min(1).optional(),
});

export type ContradictionSide = z.infer<typeof ContradictionSideSchema>;

/**
 * `id` is REQUIRED even though an older hub omits it: a pointer whose whole
 * job is to name `get_referee_brief cx_…` is useless without the id, so a row
 * with none is dropped by the tolerant list rather than rendered crippled.
 */
export const ContradictionEntrySchema = z.looseObject({
  id: z.string().min(1),
  claimA: ContradictionSideSchema,
  claimB: ContradictionSideSchema,
  reason: z.string().min(1),
  similarity: z.number().nullable().optional(),
});

export type ContradictionEntry = z.infer<typeof ContradictionEntrySchema>;

/** One more parallel GET inside the SessionStart fetch block (fail open). */
export const getContradictions = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<readonly ContradictionEntry[]>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/contradictions${encodeRepo(repo)}`,
    schema: tolerantList("candidates", ContradictionEntrySchema),
  });

/**
 * One claim of a referee brief. Confidence is bounded like the hint
 * candidates' (a forged `confidence 1e+30` is a credential, not a number) and
 * the row is dropped when it does not hold — counted, not swallowed, because
 * a case file is the thing a human decides FROM.
 */
export const RefereeClaimSchema = z.looseObject({
  id: z.string().min(1),
  workContextId: z.string().min(1),
  kind: z.string().min(1),
  status: z.string().min(1),
  confidence: z.number().min(0).max(1),
  body: z.string(),
  // Required like DiagnosisClaimSchema's: provenance is a trust label
  // (DESIGN.md §4), and a hub that will not state it does not get the row
  // rendered — a derived draft must never pass for a vouched claim.
  provenance: z.string().min(1),
  authorDeveloperName: z.string().min(1).optional(),
  createdAt: z.string().min(1),
});

export type RefereeClaim = z.infer<typeof RefereeClaimSchema>;

const SharedTargetSchema = z.looseObject({
  kind: z.string().min(1),
  value: z.string().min(1),
});

export type SharedTarget = z.infer<typeof SharedTargetSchema>;

export interface RefereePosition {
  readonly claim: RefereeClaim;
  readonly workContextTitle: string;
  readonly evidence: readonly RefereeClaim[];
  readonly evidenceTruncated: boolean;
  readonly ruledOut: readonly RefereeClaim[];
  readonly ruledOutTruncated: boolean;
  readonly supersededByClaimId: string | null;
  /** Rows of THIS position the client could not parse and dropped. */
  readonly droppedRows: number;
}

const RefereePositionSchema = z
  .looseObject({
    claim: RefereeClaimSchema,
    workContextTitle: z.string().default(""),
    evidence: z.array(z.unknown()).default([]),
    evidenceTruncated: z.boolean().default(false),
    ruledOut: z.array(z.unknown()).default([]),
    ruledOutTruncated: z.boolean().default(false),
    supersededByClaimId: z.string().nullable().optional(),
  })
  .transform((value): RefereePosition => {
    const evidence = parseRows(value.evidence, RefereeClaimSchema);
    const ruledOut = parseRows(value.ruledOut, RefereeClaimSchema);
    return {
      claim: value.claim,
      workContextTitle: value.workContextTitle,
      evidence: evidence.rows,
      evidenceTruncated: value.evidenceTruncated,
      ruledOut: ruledOut.rows,
      ruledOutTruncated: value.ruledOutTruncated,
      supersededByClaimId: value.supersededByClaimId ?? null,
      droppedRows: evidence.dropped + ruledOut.dropped,
    };
  });

export interface RefereeBrief {
  readonly id: string;
  readonly reason: string;
  readonly similarity: number | null;
  readonly positionA: RefereePosition;
  readonly positionB: RefereePosition;
  readonly sharedTargets: readonly SharedTarget[];
  readonly sharedTargetsTruncated: boolean;
  /** Rows the hub sent that this client dropped — the renderer says so. */
  readonly droppedRows: number;
}

const RefereeBriefEnvelopeSchema = z
  .looseObject({
    brief: z.looseObject({
      id: z.string().min(1),
      reason: z.string().min(1),
      // Bounded like every confidence: cosine similarity lives in [0, 1],
      // the renderer prints it as a fact, and a hub-forged 1e+30 stated in
      // crosscheck's own voice would misstate the detector. Fails the whole
      // call (like a forged position confidence) — the case file is the
      // thing a human decides from.
      similarity: z.number().min(0).max(1).nullable().optional(),
      positionA: RefereePositionSchema,
      positionB: RefereePositionSchema,
      sharedTargets: z.array(z.unknown()).default([]),
      sharedTargetsTruncated: z.boolean().default(false),
    }),
  })
  .transform((value): RefereeBrief => {
    const shared = parseRows(value.brief.sharedTargets, SharedTargetSchema);
    return {
      id: value.brief.id,
      reason: value.brief.reason,
      similarity: value.brief.similarity ?? null,
      positionA: value.brief.positionA,
      positionB: value.brief.positionB,
      sharedTargets: shared.rows,
      sharedTargetsTruncated: value.brief.sharedTargetsTruncated,
      droppedRows:
        value.brief.positionA.droppedRows +
        value.brief.positionB.droppedRows +
        shared.dropped,
    };
  });

export const getRefereeBrief = (
  ctx: HubContext,
  contradictionId: string,
): Promise<HubResult<RefereeBrief>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/contradictions/${encodeURIComponent(contradictionId)}/brief`,
    schema: RefereeBriefEnvelopeSchema,
  });

/** One muted developer as the settings endpoint names them. */
export const MutedDeveloperSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
});

export type MutedDeveloper = z.infer<typeof MutedDeveloperSchema>;

/**
 * One linked email of the CALLER's own account (trial finding #7). Tolerant
 * row like the mutes: a malformed entry costs itself, never the settings
 * read.
 */
export const OwnEmailSchema = z.looseObject({
  email: z.string().min(1),
  isPrimary: z.boolean().default(false),
});

export type OwnEmail = z.infer<typeof OwnEmailSchema>;

/**
 * The developer's OWN privacy settings (DESIGN.md §2.1): presence opt-out +
 * mute list, plus the account's linked emails (primary + aliases — trial
 * finding #7; an older hub sends no field and the list is simply empty).
 * Mutes and emails are tolerant rows — one malformed entry must not cost the
 * whole settings read that status/doctor depend on.
 */
export const PrivacySettingsSchema = z
  .looseObject({
    presenceOptOut: z.boolean(),
    mutes: z.array(z.unknown()).default([]),
    emails: z.array(z.unknown()).default([]),
  })
  .transform((value) => ({
    presenceOptOut: value.presenceOptOut,
    mutes: value.mutes
      .map((item) => MutedDeveloperSchema.safeParse(item))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data),
    emails: value.emails
      .map((item) => OwnEmailSchema.safeParse(item))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data),
  }));

export interface PrivacySettings {
  readonly presenceOptOut: boolean;
  readonly mutes: readonly MutedDeveloper[];
  readonly emails: readonly OwnEmail[];
}

export const getPrivacySettings = (
  ctx: HubContext,
): Promise<HubResult<PrivacySettings>> =>
  hubRequest(ctx, {
    method: "GET",
    path: "/api/settings",
    schema: PrivacySettingsSchema,
  });

export const putPresenceOptOut = (
  ctx: HubContext,
  optOut: boolean,
): Promise<HubResult<unknown>> =>
  hubRequest(ctx, {
    method: "PUT",
    path: "/api/settings/presence",
    schema: z.unknown(),
    body: { optOut },
  });

const MuteResponseSchema = z.looseObject({
  muted: MutedDeveloperSchema,
  alreadyMuted: z.boolean().default(false),
});

export type MuteResponse = z.infer<typeof MuteResponseSchema>;

export const postMute = (
  ctx: HubContext,
  developerRef: string,
): Promise<HubResult<MuteResponse>> =>
  hubRequest(ctx, {
    method: "POST",
    path: "/api/settings/mutes",
    schema: MuteResponseSchema,
    body: { developer: developerRef },
  });

const UnmuteResponseSchema = z.looseObject({
  unmuted: MutedDeveloperSchema,
  wasMuted: z.boolean().default(true),
});

export type UnmuteResponse = z.infer<typeof UnmuteResponseSchema>;

export const deleteMute = (
  ctx: HubContext,
  developerRef: string,
): Promise<HubResult<UnmuteResponse>> =>
  hubRequest(ctx, {
    method: "DELETE",
    path: `/api/settings/mutes/${encodeURIComponent(developerRef)}`,
    schema: UnmuteResponseSchema,
  });

export const TripwireSessionSchema = z.looseObject({
  sessionId: z.string().min(1),
  developerId: z.string().min(1),
  developerName: z.string().min(1),
  branch: z.string().min(1),
  status: z.string().min(1),
  lastHeartbeatAt: z.string().min(1),
  workContextId: z.string().min(1),
  workContextTitle: z.string().min(1),
  /** The overlapping session's intent; the ask reason shows it. */
  workContextIntent: tolerantIntent,
});

export type TripwireSession = z.infer<typeof TripwireSessionSchema>;

/** The PreToolUse tripwire's ONE bounded hub call (DESIGN.md §4). */
export const getTripwireSessions = (
  ctx: HubContext,
  repo: string,
  value: string,
): Promise<HubResult<readonly TripwireSession[]>> => {
  const params = new URLSearchParams({ repo, value });
  return hubRequest(ctx, {
    method: "GET",
    path: `/api/hints/tripwire?${params.toString()}`,
    schema: tolerantList("sessions", TripwireSessionSchema),
  });
};

/**
 * One declared claim as a conference reads it (VISION.md §2) — the trust
 * labels an injected claim always carries, because the report prints them
 * beside every body it quotes.
 *
 * `provenance` is REQUIRED, like the referee brief's and for the same reason:
 * it is a trust label, and a hub that will not state it does not get the claim
 * rendered as substance.
 */
export const ConferenceClaimSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  status: z.string().min(1),
  confidence: z.number().min(0).max(1),
  provenance: z.string().min(1),
  body: z.string(),
  authorDeveloperName: z.string().min(1).optional(),
  createdAt: z.string().min(1),
});

export type ConferenceClaim = z.infer<typeof ConferenceClaimSchema>;

export const ConferenceContextSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  developerId: z.string().min(1),
  developerName: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  intent: tolerantIntent,
  lastActiveAt: z.string().min(1),
  claims: z.array(ConferenceClaimSchema).catch([]),
});

export type ConferenceContext = z.infer<typeof ConferenceContextSchema>;

export const ConferenceOverlapSchema = z.looseObject({
  workContextIdA: z.string().min(1),
  workContextIdB: z.string().min(1),
  sharedTargets: z.array(GhostSharedTargetSchema).catch([]),
  sharedTargetCount: z.number().int().min(0).catch(0),
});

export type ConferenceOverlap = z.infer<typeof ConferenceOverlapSchema>;

/**
 * An open question, as the conference sees it: WHO asked, WHO is waiting and
 * since when. There is no `body` field on this schema and the hub sends none —
 * a question is addressed to one person, and a report about the team is not
 * that person (packages/server/src/services/conference.ts states the rule).
 */
export const ConferenceQuestionSchema = z.looseObject({
  id: z.string().min(1),
  authorDeveloperName: z.string().min(1),
  targetDeveloperName: z.string().nullable().optional(),
  workContextId: z.string().nullable().optional(),
  workContextTitle: z.string().nullable().optional(),
  createdAt: z.string().min(1),
  /** True only when this reader may answer — the report prints the call off it. */
  isForReader: z.boolean().catch(false),
});

export type ConferenceQuestion = z.infer<typeof ConferenceQuestionSchema>;

export interface ConferenceCorpus {
  readonly contexts: readonly ConferenceContext[];
  readonly overlaps: readonly ConferenceOverlap[];
  readonly questions: readonly ConferenceQuestion[];
  readonly contradictions: readonly ContradictionEntry[];
  readonly contextsInWindow: number;
  readonly contextsInWindowCapped: boolean;
  readonly windowDays: number;
}

/**
 * Tolerant per LIST, never per document: a hub that garbles one context must
 * cost the report that context, not the whole run — the posture every other
 * listing here takes. The counters fall back to what the rows themselves say,
 * so a report can never claim to have read less than it prints.
 */
const ConferenceResponseSchema = z
  .looseObject({
    conference: z.looseObject({
      contexts: z.array(z.unknown()).default([]),
      overlaps: z.array(z.unknown()).default([]),
      questions: z.array(z.unknown()).default([]),
      contradictions: z.array(z.unknown()).default([]),
      contextsInWindow: z.number().int().min(0).catch(0),
      contextsInWindowCapped: z.boolean().catch(false),
      windowDays: z.number().int().min(1).catch(0),
    }),
  })
  .transform((value): ConferenceCorpus => {
    const contexts = parseRows(value.conference.contexts, ConferenceContextSchema).rows;
    return {
      contexts,
      overlaps: parseRows(value.conference.overlaps, ConferenceOverlapSchema).rows,
      questions: parseRows(value.conference.questions, ConferenceQuestionSchema).rows,
      contradictions: parseRows(value.conference.contradictions, ContradictionEntrySchema)
        .rows,
      contextsInWindow: Math.max(
        value.conference.contextsInWindow,
        contexts.length,
      ),
      contextsInWindowCapped: value.conference.contextsInWindowCapped,
      windowDays: value.conference.windowDays,
    };
  });

/**
 * The conference's ONE hub call (VISION.md §2) — never from a hook, only from
 * `crosscheck conference`. Fail open like every other reader here: a hub too
 * old for the route, or an unreachable one, is a run that says so and spends
 * nothing.
 */
export const getConference = (
  ctx: HubContext,
  repo: string,
): Promise<HubResult<ConferenceCorpus>> =>
  hubRequest(ctx, {
    method: "GET",
    path: `/api/conference${encodeRepo(repo)}`,
    schema: ConferenceResponseSchema,
  });
