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
});

export type PresenceEntry = z.infer<typeof PresenceEntrySchema>;

export const WorkContextEntrySchema = z.looseObject({
  id: z.string().min(1),
  developerId: z.string().min(1),
  /** Authoritative author label; presence is only the fallback (DESIGN.md §4). */
  developerName: z.string().min(1).optional(),
  title: z.string().min(1),
  status: z.string().min(1),
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
  status: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().nullable().optional(),
});

export type DiagnosisWorkContext = z.infer<typeof DiagnosisWorkContextSchema>;

export interface Diagnosis {
  readonly workContext: DiagnosisWorkContext;
  readonly claims: readonly DiagnosisClaim[];
  readonly edges: readonly DiagnosisEdge[];
  readonly externalClaims: readonly ExternalClaimRef[];
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
    truncated: z.boolean().default(false),
  })
  .transform((value): Diagnosis => {
    const claims = parseRows(value.claims, DiagnosisClaimSchema);
    const edges = parseRows(value.edges, DiagnosisEdgeSchema);
    const external = parseRows(value.externalClaims, ExternalClaimRefSchema);
    return {
      workContext: value.workContext,
      claims: claims.rows,
      edges: edges.rows,
      externalClaims: external.rows,
      truncated: value.truncated,
      droppedRows: claims.dropped + edges.dropped + external.dropped,
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
  createdAt: z.string().min(1),
  updatedAt: z.string().nullable().optional(),
  tier: z.string().min(1).optional(),
  score: z.number().optional(),
});

export type SearchResultEntry = z.infer<typeof SearchResultEntrySchema>;

export interface SearchOutcome {
  readonly results: readonly SearchResultEntry[];
  /** True only when the hub's vector tier ran for this search (DESIGN.md §6). */
  readonly vectorTierActive: boolean;
}

const SearchResponseSchema = z
  .looseObject({
    results: z.array(z.unknown()).default([]),
    vectorTierActive: z.boolean().default(false),
  })
  .transform(
    (value): SearchOutcome => ({
      // Tolerant rows, silent drop — a listing, like tolerantList above; the
      // diagnosis path counts its drops because a TREE must not silently
      // shrink, a search result list is advisory by nature.
      results: parseRows(value.results, SearchResultEntrySchema).rows,
      vectorTierActive: value.vectorTierActive,
    }),
  );

export interface SearchRequest {
  readonly query: string;
  /** Relevance filter, never a boundary (DESIGN.md §2.1). */
  readonly repo: string;
  readonly limit: number;
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
  /** Optional: an older hub sends no tier, and no tier means no precision. */
  tier: z.string().min(1).optional(),
  developerId: z.string().min(1),
  developerName: z.string().min(1).optional(),
  /** For the drift label; "" from the hub means unknown. */
  baseCommit: z.string().optional(),
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
export const getHintCandidates = (
  ctx: HubContext,
  request: HintCandidatesRequest,
): Promise<HubResult<readonly HintContextCandidate[]>> => {
  const params = new URLSearchParams({
    query: request.query,
    repo: request.repo,
  });
  return hubRequest(ctx, {
    method: "GET",
    path: `/api/hints/candidates?${params.toString()}`,
    schema: tolerantList("candidates", HintContextCandidateSchema),
  });
};

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
      similarity: z.number().nullable().optional(),
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

export const TripwireSessionSchema = z.looseObject({
  sessionId: z.string().min(1),
  developerId: z.string().min(1),
  developerName: z.string().min(1),
  branch: z.string().min(1),
  status: z.string().min(1),
  lastHeartbeatAt: z.string().min(1),
  workContextId: z.string().min(1),
  workContextTitle: z.string().min(1),
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
