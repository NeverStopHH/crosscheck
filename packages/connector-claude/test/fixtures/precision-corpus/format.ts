/**
 * Golden-fixture corpus format + loader (DESIGN.md §4 telemetry bullet: "a
 * pre-launch golden-fixture corpus, because a 2-dev team will not generate
 * tuning volume for months").
 *
 * The corpus is DATA — JSON files under ./scenarios plus ./developers.json —
 * so a new team situation can be added by hand without touching harness code.
 * This module is only the schema those files are validated against and the
 * loader that reads them in a deterministic order. What each field means, and
 * the honesty rules for labeling probes, live in ./README.md.
 *
 * Every timestamp in the data is FIXED (fixture time, never wall clock): the
 * harness freezes the hub's clock at CORPUS_NOW_ISO, so ages, decay and
 * presence are the same on every run and every platform.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** The frozen "now" the hub's clock reports while the corpus runs. */
export const CORPUS_NOW_ISO = "2026-08-01T12:00:00.000Z";

/** Every corpus session reports on one repo — hints are repo-scoped. */
export const CORPUS_REPO_ID = "github.com/corpus/api";
export const CORPUS_REPO_REMOTE = "git@github.com:corpus/api.git";

const CORPUS_DIR = import.meta.dir;
const SCENARIOS_DIR = join(CORPUS_DIR, "scenarios");
const DEVELOPERS_FILE = join(CORPUS_DIR, "developers.json");

const nonEmpty = z.string().min(1);
const isoTime = z.iso.datetime();

const DeveloperSchema = z.strictObject({
  name: nonEmpty,
  email: z.email(),
  presenceOptOut: z.boolean().default(false),
});

const MuteSchema = z.strictObject({
  reader: nonEmpty,
  muted: nonEmpty,
});

const CastSchema = z.strictObject({
  developers: z.array(DeveloperSchema).min(1),
  mutes: z.array(MuteSchema).default([]),
});

const SessionSchema = z.strictObject({
  id: nonEmpty,
  developer: nonEmpty,
  branch: nonEmpty,
  baseCommit: nonEmpty,
  status: nonEmpty,
  /** Ended AFTER its records are ingested — late writes are rejected live. */
  ended: z.boolean().default(false),
});

const WorkContextSchema = z.strictObject({
  id: nonEmpty,
  sessionId: nonEmpty,
  title: nonEmpty,
  description: z.string().optional(),
  status: nonEmpty,
  createdAt: isoTime,
  updatedAt: isoTime.optional(),
});

const TargetSchema = z.strictObject({
  workContextId: nonEmpty,
  kind: z.enum(["file", "symbol", "component", "error_fingerprint"]),
  value: nonEmpty,
});

const ClaimSchema = z.strictObject({
  id: nonEmpty,
  workContextId: nonEmpty,
  authorSessionId: nonEmpty,
  kind: nonEmpty,
  body: nonEmpty,
  status: nonEmpty,
  confidence: z.number().min(0).max(1),
  captureMode: nonEmpty,
  provenance: nonEmpty,
  evidenceRefs: z.array(nonEmpty).default([]),
  createdAt: isoTime,
});

const EdgeSchema = z.strictObject({
  id: nonEmpty,
  fromClaimId: nonEmpty,
  toClaimId: nonEmpty,
  kind: nonEmpty,
  authorSessionId: nonEmpty,
  note: z.string().optional(),
  createdAt: isoTime,
});

/** The three outcome classes a probe can be labeled with (README.md). */
export const PROBE_OUTCOMES = ["substance", "pointer", "silence"] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

const ProbeSchema = z
  .strictObject({
    id: nonEmpty,
    kind: z.enum(["prompt", "file-touch"]),
    /** Developer name the probe runs as — their key, their exclusions. */
    reader: nonEmpty,
    prompt: z.string().optional(),
    file: z.string().optional(),
    expect: z.enum(PROBE_OUTCOMES),
    /** substance only: the one claim whose body must arrive framed. */
    expectClaimId: nonEmpty.optional(),
    /** substance/pointer: the work context the delivery must come from. */
    expectContextId: nonEmpty.optional(),
    /** Session already at MAX_HINTS_PER_SESSION before the probe fires. */
    atSessionCap: z.boolean().default(false),
    /** Refs already delivered this session (seen-set), by fixture claim id. */
    seenClaimIds: z.array(nonEmpty).default([]),
    /** REQUIRED: why this label is right under TODAY's thresholds. */
    rationale: nonEmpty,
  })
  .check((ctx) => {
    const probe = ctx.value;
    if (probe.kind === "prompt" && probe.prompt === undefined) {
      ctx.issues.push({
        code: "custom",
        message: "a prompt probe needs a prompt",
        input: probe.id,
        path: ["prompt"],
      });
    }
    if (probe.kind === "file-touch" && probe.file === undefined) {
      ctx.issues.push({
        code: "custom",
        message: "a file-touch probe needs a repo-relative file",
        input: probe.id,
        path: ["file"],
      });
    }
  });

const ScenarioSchema = z.strictObject({
  id: nonEmpty,
  summary: nonEmpty,
  sessions: z.array(SessionSchema).default([]),
  workContexts: z.array(WorkContextSchema).default([]),
  targets: z.array(TargetSchema).default([]),
  claims: z.array(ClaimSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
  probes: z.array(ProbeSchema).min(1),
});

export type CorpusDeveloper = z.infer<typeof DeveloperSchema>;
export type CorpusMute = z.infer<typeof MuteSchema>;
export type CorpusSession = z.infer<typeof SessionSchema>;
export type CorpusWorkContext = z.infer<typeof WorkContextSchema>;
export type CorpusTarget = z.infer<typeof TargetSchema>;
export type CorpusClaim = z.infer<typeof ClaimSchema>;
export type CorpusEdge = z.infer<typeof EdgeSchema>;
export type CorpusProbe = z.infer<typeof ProbeSchema>;
export type CorpusScenario = z.infer<typeof ScenarioSchema>;

export interface Corpus {
  readonly developers: readonly CorpusDeveloper[];
  readonly mutes: readonly CorpusMute[];
  readonly scenarios: readonly CorpusScenario[];
}

const parseJson = async (path: string): Promise<unknown> => {
  const text = await Bun.file(path).text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${path}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const loadScenario = async (path: string): Promise<CorpusScenario> => {
  const parsed = ScenarioSchema.safeParse(await parseJson(path));
  if (!parsed.success) {
    throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

/**
 * Reads the whole corpus, validated, scenarios in filename order — the one
 * deterministic order that survives files being added by hand.
 */
export const loadCorpus = async (): Promise<Corpus> => {
  const cast = CastSchema.safeParse(await parseJson(DEVELOPERS_FILE));
  if (!cast.success) {
    throw new Error(`${DEVELOPERS_FILE}: ${z.prettifyError(cast.error)}`);
  }
  const files = (await readdir(SCENARIOS_DIR))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const scenarios = [];
  for (const name of files) {
    scenarios.push(await loadScenario(join(SCENARIOS_DIR, name)));
  }
  return {
    developers: cast.data.developers,
    mutes: cast.data.mutes,
    scenarios,
  };
};
