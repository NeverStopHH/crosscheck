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
