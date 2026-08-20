/**
 * Corpus harness engine: seeds the corpus into a REAL hub and drives every
 * probe through the REAL connector paths (DESIGN.md §4 golden-fixture bullet).
 *
 * Nothing about selection is reimplemented here. The hub is
 * @crosscheck/server over HTTP (real ingest route, real search, real hint
 * candidates and tripwire services); the probes run through the real hook
 * entry point (`runHook`), so the selector, the seen-set, the denylist, the
 * budgets and the renderers are the production code paths. This module only
 * seeds, classifies stdout, and counts.
 *
 * DETERMINISM. The hub's clock is frozen at CORPUS_NOW_ISO and every fixture
 * timestamp is fixed data, so decay, tier eligibility, presence and the
 * solved floor compute identically on every run and platform. The connector's
 * own wall clock only feeds display ages, which classification never reads.
 * No embedder is configured — the corpus pins the keyless default install's
 * lexical behavior (DESIGN.md §6).
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { createDb, createServer } from "@crosscheck/server";

import { MAX_HINTS_PER_SESSION } from "../../../src/constants.ts";
import { runHook } from "../../../../connector-claude/src/index.ts";
import type { Env } from "../../../src/index.ts";
import { writeSessionState } from "../../../src/state/session-state.ts";
import type { SessionState } from "../../../src/state/session-state.ts";
import { makeHome, makeRepo } from "../../helpers.ts";
import {
  CORPUS_NOW_ISO,
  CORPUS_REPO_ID,
  CORPUS_REPO_REMOTE,
  loadCorpus,
} from "./format.ts";
import type {
  Corpus,
  CorpusClaim,
  CorpusProbe,
  CorpusScenario,
  ProbeOutcome,
} from "./format.ts";

const ADMIN_TOKEN = "corpus-admin-token";

/**
 * Wide per-request hub timeout so a cold PGlite query can never trip the
 * hook's fail-open budget into a false silence — the same widening the
 * two-developer e2e applies, for the same reason.
 */
const HUB_TIMEOUT_MS = "4000";

/** How the rendered surfaces begin — the classification markers. */
const CLAIM_MARKER = "crosscheck hint:";
const POINTER_MARKER = "crosscheck pointer:";

export interface ProbeResult {
  readonly scenarioId: string;
  readonly probe: CorpusProbe;
  readonly observed: ProbeOutcome;
  /** True when observed class AND the expected claim/context refs match. */
  readonly ok: boolean;
  /** Why not ok — empty when ok. */
  readonly issues: readonly string[];
  /** The rendered text (hint, pointer, or ask reason) for the diff. */
  readonly rendered: string;
}

export interface CorpusMetrics {
  /** Correct substance / all substance delivered. */
  readonly substancePrecision: number;
  /** Correct substance / probes labeled substance. */
  readonly substanceRecall: number;
  /** Probes labeled silence that stayed silent / probes labeled silence. */
  readonly silenceCorrectness: number;
  /** Probes labeled pointer that did NOT arrive as substance / labeled pointer. */
  readonly pointerDiscipline: number;
  /** Probes labeled pointer that arrived as a pointer / labeled pointer. */
  readonly pointerRecall: number;
}

export interface CorpusRun {
  readonly corpus: Corpus;
  readonly results: readonly ProbeResult[];
  readonly metrics: CorpusMetrics;
}

interface SeededDeveloper {
  readonly id: string;
  readonly apiKey: string;
}

interface Hub {
  readonly url: string;
  readonly stop: () => void;
}

const jsonInit = (method: string, token: string, body: unknown): RequestInit => ({
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

/** Every seed call must land — a silently failed seed poisons every metric. */
const expectOk = async (
  response: Response,
  what: string,
): Promise<Record<string, unknown>> => {
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200) {
    throw new Error(
      `corpus seed: ${what} failed (${String(response.status)}): ${JSON.stringify(body)}`,
    );
  }
  return body;
};

const startHub = async (): Promise<Hub> => {
  const db = await createDb();
  const app = createServer({
    db,
    now: () => new Date(CORPUS_NOW_ISO),
    adminToken: ADMIN_TOKEN,
    embedder: null,
  });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    stop: () => {
      server.stop(true);
    },
  };
};

const createDevelopers = async (
  hub: Hub,
  corpus: Corpus,
): Promise<ReadonlyMap<string, SeededDeveloper>> => {
  const developers = new Map<string, SeededDeveloper>();
  for (const developer of corpus.developers) {
    const body = await expectOk(
      await fetch(
        `${hub.url}/api/developers`,
        jsonInit("POST", ADMIN_TOKEN, {
          name: developer.name,
          email: developer.email,
        }),
      ),
      `developer ${developer.name}`,
    );
    const data = body["data"] as { developer: { id: string }; apiKey: string };
    developers.set(developer.name, {
      id: data.developer.id,
      apiKey: data.apiKey,
    });
  }
  return developers;
};

const keyOf = (
  developers: ReadonlyMap<string, SeededDeveloper>,
  name: string,
): SeededDeveloper => {
  const found = developers.get(name);
  if (found === undefined) {
    throw new Error(`corpus: developer "${name}" is not in developers.json`);
  }
  return found;
};

const applyPrivacy = async (
  hub: Hub,
  corpus: Corpus,
  developers: ReadonlyMap<string, SeededDeveloper>,
): Promise<void> => {
  for (const developer of corpus.developers) {
    if (!developer.presenceOptOut) {
      continue;
    }
    await expectOk(
      await fetch(
        `${hub.url}/api/settings/presence`,
        jsonInit("PUT", keyOf(developers, developer.name).apiKey, {
          optOut: true,
        }),
      ),
      `presence opt-out for ${developer.name}`,
    );
  }
  for (const mute of corpus.mutes) {
    await expectOk(
      await fetch(
        `${hub.url}/api/settings/mutes`,
        jsonInit("POST", keyOf(developers, mute.reader).apiKey, {
          developer: mute.muted,
        }),
      ),
      `mute ${mute.muted} for ${mute.reader}`,
    );
  }
};

/** session id → owning developer name, across all scenarios. */
const sessionOwners = (corpus: Corpus): ReadonlyMap<string, string> =>
  new Map(
    corpus.scenarios.flatMap((scenario) =>
      scenario.sessions.map(
        (session) => [session.id, session.developer] as const,
      ),
    ),
  );

const registerSessions = async (
  hub: Hub,
  corpus: Corpus,
  developers: ReadonlyMap<string, SeededDeveloper>,
): Promise<void> => {
  for (const scenario of corpus.scenarios) {
    for (const session of scenario.sessions) {
      await expectOk(
        await fetch(
          `${hub.url}/api/sessions`,
          jsonInit("POST", keyOf(developers, session.developer).apiKey, {
            id: session.id,
            agentKind: "claude-code",
            repo: CORPUS_REPO_ID,
            branch: session.branch,
            baseCommit: session.baseCommit,
            status: session.status,
          }),
        ),
        `session ${session.id}`,
      );
    }
  }
};

/** One record through the REAL ingest route, posted by its author. */
const ingestRecord = async (
  hub: Hub,
  author: SeededDeveloper,
  producerSessionId: string,
  kind: string,
  body: Record<string, unknown>,
  what: string,
): Promise<void> => {
  const envelope = {
    cx: "0.1",
    id: `env_${what.replace(/[^\p{L}\p{N}]+/gu, "_")}`,
    ts: (body["createdAt"] as string | undefined) ?? CORPUS_NOW_ISO,
    producer: {
      developerId: author.id,
      agentKind: "claude-code",
      sessionId: producerSessionId,
    },
    kind,
    body,
  };
  const response = await expectOk(
    await fetch(
      `${hub.url}/api/records`,
      jsonInit("POST", author.apiKey, { records: [envelope] }),
    ),
    what,
  );
  const data = response["data"] as {
    results: { status: string; issues?: string[] }[];
  };
  const result = data.results[0];
  if (result === undefined || result.status !== "accepted") {
    throw new Error(
      `corpus seed: ${what} was not accepted: ${JSON.stringify(result)}`,
    );
  }
};

/** One scenario's seeding environment, shared by the per-record-type loops. */
interface ScenarioSeed {
  readonly hub: Hub;
  readonly scenario: CorpusScenario;
  readonly authorOf: (sessionId: string) => SeededDeveloper;
  readonly sessionOfContext: (workContextId: string) => string;
}

const makeScenarioSeed = (
  hub: Hub,
  scenario: CorpusScenario,
  owners: ReadonlyMap<string, string>,
  developers: ReadonlyMap<string, SeededDeveloper>,
): ScenarioSeed => {
  const contextSession = new Map(
    scenario.workContexts.map((context) => [context.id, context.sessionId]),
  );
  return {
    hub,
    scenario,
    authorOf: (sessionId) => {
      const owner = owners.get(sessionId);
      if (owner === undefined) {
        throw new Error(
          `corpus: scenario ${scenario.id} references unknown session "${sessionId}"`,
        );
      }
      return keyOf(developers, owner);
    },
    sessionOfContext: (workContextId) => {
      const sessionId = contextSession.get(workContextId);
      if (sessionId === undefined) {
        throw new Error(
          `corpus: scenario ${scenario.id} references unknown context "${workContextId}"`,
        );
      }
      return sessionId;
    },
  };
};

const ingestContexts = async (seed: ScenarioSeed): Promise<void> => {
  for (const context of seed.scenario.workContexts) {
    await ingestRecord(
      seed.hub,
      seed.authorOf(context.sessionId),
      context.sessionId,
      "work_context",
      {
        id: context.id,
        sessionId: context.sessionId,
        title: context.title,
        ...(context.description === undefined
          ? {}
          : { description: context.description }),
        status: context.status,
        createdAt: context.createdAt,
        ...(context.updatedAt === undefined
          ? {}
          : { updatedAt: context.updatedAt }),
      },
      `${seed.scenario.id} context ${context.id}`,
    );
  }
};

const ingestTargets = async (seed: ScenarioSeed): Promise<void> => {
  for (const target of seed.scenario.targets) {
    const sessionId = seed.sessionOfContext(target.workContextId);
    await ingestRecord(
      seed.hub,
      seed.authorOf(sessionId),
      sessionId,
      "target",
      {
        workContextId: target.workContextId,
        kind: target.kind,
        value: target.value,
      },
      `${seed.scenario.id} target ${target.workContextId}/${target.value}`,
    );
  }
};

const ingestClaims = async (seed: ScenarioSeed): Promise<void> => {
  for (const claim of seed.scenario.claims) {
    await ingestRecord(
      seed.hub,
      seed.authorOf(claim.authorSessionId),
      claim.authorSessionId,
      "claim",
      {
        id: claim.id,
        workContextId: claim.workContextId,
        authorSessionId: claim.authorSessionId,
        kind: claim.kind,
        body: claim.body,
        status: claim.status,
        confidence: claim.confidence,
        captureMode: claim.captureMode,
        provenance: claim.provenance,
        evidenceRefs: claim.evidenceRefs,
        createdAt: claim.createdAt,
      },
      `${seed.scenario.id} claim ${claim.id}`,
    );
  }
};

const ingestEdges = async (seed: ScenarioSeed): Promise<void> => {
  for (const edge of seed.scenario.edges) {
    await ingestRecord(
      seed.hub,
      seed.authorOf(edge.authorSessionId),
      edge.authorSessionId,
      "claim_edge",
      {
        id: edge.id,
        fromClaimId: edge.fromClaimId,
        toClaimId: edge.toClaimId,
        kind: edge.kind,
        authorSessionId: edge.authorSessionId,
        ...(edge.note === undefined ? {} : { note: edge.note }),
        createdAt: edge.createdAt,
      },
      `${seed.scenario.id} edge ${edge.id}`,
    );
  }
};

/** Dependency order — the hub rejects forward references between the arrays. */
const ingestScenario = async (
  hub: Hub,
  scenario: CorpusScenario,
  owners: ReadonlyMap<string, string>,
  developers: ReadonlyMap<string, SeededDeveloper>,
): Promise<void> => {
  const seed = makeScenarioSeed(hub, scenario, owners, developers);
  await ingestContexts(seed);
  await ingestTargets(seed);
  await ingestClaims(seed);
  await ingestEdges(seed);
};

/** Sessions flagged `ended` end AFTER ingest — live hubs reject late writes. */
const endFlaggedSessions = async (
  hub: Hub,
  corpus: Corpus,
  developers: ReadonlyMap<string, SeededDeveloper>,
): Promise<void> => {
  for (const scenario of corpus.scenarios) {
    for (const session of scenario.sessions) {
      if (!session.ended) {
        continue;
      }
      await expectOk(
        await fetch(
          `${hub.url}/api/sessions/${session.id}/end`,
          jsonInit("POST", keyOf(developers, session.developer).apiKey, {}),
        ),
        `end session ${session.id}`,
      );
    }
  }
};

/** Placeholder refs that put a probe's session exactly at the cap. */
const capFillerRefs = (): readonly string[] =>
  Array.from(
    { length: MAX_HINTS_PER_SESSION },
    (_unused, index) => `clm_cap_filler_${String(index)}`,
  );

const probeSessionState = (
  probe: CorpusProbe,
  repoRoot: string,
  hubUrl: string,
  developerId: string,
): SessionState => ({
  hostSessionKey: `corpus-${probe.id}`,
  crosscheckSessionId: `cc_corpus-${probe.id}`,
  workContextId: `wc_cc_corpus-${probe.id}`,
  repoId: CORPUS_REPO_ID,
  repoRoot,
  hubUrl,
  developerId,
  startedAt: CORPUS_NOW_ISO,
  lastHeartbeatAt: null,
  seenTargets: [],
  deliveredHintRefs: [
    ...(probe.atSessionCap ? capFillerRefs() : probe.seenClaimIds),
  ],
  deliveredHintHashes: [],
  tripwireAskedFiles: [],
  briefingSolvedRefs: [],
  foreignRepoDrops: 0,
  briefingPending: false,
  stopTurnCount: 0,
  summarizerFireCount: 0,
  summarizerLastFireTurn: null,
  summarizerEstimatedTokens: 0,
});

interface Observation {
  readonly outcome: ProbeOutcome;
  readonly rendered: string;
}

interface HookOutput {
  readonly hookSpecificOutput?: {
    readonly additionalContext?: string;
    readonly permissionDecision?: string;
    readonly permissionDecisionReason?: string;
  };
}

/**
 * Maps hook stdout onto the three outcome classes. A tripwire "ask" is
 * pointer-class by construction: it names a teammate and a context id and
 * cannot carry a claim body (hints/render.ts renderTripwireReason).
 */
const classify = (stdout: string): Observation => {
  if (stdout.length === 0) {
    return { outcome: "silence", rendered: "" };
  }
  const parsed = JSON.parse(stdout) as HookOutput;
  const output = parsed.hookSpecificOutput ?? {};
  if (output.permissionDecision === "ask") {
    return {
      outcome: "pointer",
      rendered: output.permissionDecisionReason ?? "",
    };
  }
  const context = output.additionalContext ?? "";
  if (context.startsWith(CLAIM_MARKER)) {
    return { outcome: "substance", rendered: context };
  }
  if (context.startsWith(POINTER_MARKER)) {
    return { outcome: "pointer", rendered: context };
  }
  return { outcome: "silence", rendered: context };
};

const claimsById = (corpus: Corpus): ReadonlyMap<string, CorpusClaim> =>
  new Map(
    corpus.scenarios.flatMap((scenario) =>
      scenario.claims.map((claim) => [claim.id, claim] as const),
    ),
  );

/** The label checks beyond the outcome class — expected refs, framed body. */
const refIssues = (
  probe: CorpusProbe,
  observation: Observation,
  claims: ReadonlyMap<string, CorpusClaim>,
): readonly string[] => {
  if (observation.outcome !== probe.expect) {
    return [`expected ${probe.expect}, observed ${observation.outcome}`];
  }
  const issues: string[] = [];
  if (probe.expectClaimId !== undefined && probe.expect === "substance") {
    const claim = claims.get(probe.expectClaimId);
    if (claim === undefined) {
      issues.push(`probe names unknown claim ${probe.expectClaimId}`);
    } else if (!observation.rendered.includes(`«${claim.body}»`)) {
      issues.push(
        `expected the framed body of ${probe.expectClaimId}, got: ${observation.rendered}`,
      );
    }
  }
  if (
    probe.expectContextId !== undefined &&
    observation.outcome !== "silence" &&
    !observation.rendered.includes(probe.expectContextId)
  ) {
    issues.push(`expected delivery from ${probe.expectContextId}`);
  }
  return issues;
};

const promptPayload = (probe: CorpusProbe, repoRoot: string): string =>
  JSON.stringify({
    session_id: `corpus-${probe.id}`,
    cwd: repoRoot,
    hook_event_name: "UserPromptSubmit",
    prompt: probe.prompt ?? "",
  });

const fileTouchPayload = (probe: CorpusProbe, repoRoot: string): string =>
  JSON.stringify({
    session_id: `corpus-${probe.id}`,
    cwd: repoRoot,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: join(repoRoot, probe.file ?? "") },
  });

const runProbe = async (
  probe: CorpusProbe,
  scenarioId: string,
  repoRoot: string,
  hub: Hub,
  developers: ReadonlyMap<string, SeededDeveloper>,
  claims: ReadonlyMap<string, CorpusClaim>,
): Promise<ProbeResult> => {
  const reader = keyOf(developers, probe.reader);
  const home = await makeHome(`corpus-${probe.id}`);
  try {
    await writeSessionState(
      home,
      probeSessionState(probe, repoRoot, hub.url, reader.id),
    );
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: reader.apiKey,
      CROSSCHECK_TIMEOUT_MS: HUB_TIMEOUT_MS,
    };
    const stdout =
      probe.kind === "prompt"
        ? await runHook("user-prompt-submit", promptPayload(probe, repoRoot), env)
        : await runHook("pre-tool-use", fileTouchPayload(probe, repoRoot), env);
    const observation = classify(stdout);
    const issues = refIssues(probe, observation, claims);
    return {
      scenarioId,
      probe,
      observed: observation.outcome,
      ok: issues.length === 0,
      issues,
      rendered: observation.rendered,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : numerator / denominator;

const computeMetrics = (results: readonly ProbeResult[]): CorpusMetrics => {
  const labeled = (expect: ProbeOutcome): readonly ProbeResult[] =>
    results.filter((result) => result.probe.expect === expect);
  const deliveredSubstance = results.filter(
    (result) => result.observed === "substance",
  );
  const correctSubstance = deliveredSubstance.filter((result) => result.ok);
  const pointerProbes = labeled("pointer");
  const silenceProbes = labeled("silence");
  return {
    substancePrecision: ratio(
      correctSubstance.length,
      deliveredSubstance.length,
    ),
    substanceRecall: ratio(
      labeled("substance").filter((result) => result.ok).length,
      labeled("substance").length,
    ),
    silenceCorrectness: ratio(
      silenceProbes.filter((result) => result.observed === "silence").length,
      silenceProbes.length,
    ),
    pointerDiscipline: ratio(
      pointerProbes.filter((result) => result.observed !== "substance").length,
      pointerProbes.length,
    ),
    pointerRecall: ratio(
      pointerProbes.filter((result) => result.ok).length,
      pointerProbes.length,
    ),
  };
};

/** One-line diff per failed probe — the harness's per-probe failure surface. */
export const formatFailures = (results: readonly ProbeResult[]): string =>
  results
    .filter((result) => !result.ok)
    .map(
      (result) =>
        `${result.scenarioId}/${result.probe.id}: ${result.issues.join("; ")}` +
        (result.rendered.length > 0
          ? `\n  rendered: ${result.rendered.split("\n").join(" | ")}`
          : ""),
    )
    .join("\n");

/**
 * Seeds one fresh hub with the whole corpus and drives every probe, in
 * corpus order. Everything torn down before returning.
 */
export const runCorpus = async (): Promise<CorpusRun> => {
  const corpus = await loadCorpus();
  const hub = await startHub();
  const repoRoot = await makeRepo("corpus", { remote: CORPUS_REPO_REMOTE });
  try {
    const developers = await createDevelopers(hub, corpus);
    await applyPrivacy(hub, corpus, developers);
    await registerSessions(hub, corpus, developers);
    const owners = sessionOwners(corpus);
    for (const scenario of corpus.scenarios) {
      await ingestScenario(hub, scenario, owners, developers);
    }
    await endFlaggedSessions(hub, corpus, developers);

    const claims = claimsById(corpus);
    const results: ProbeResult[] = [];
    for (const scenario of corpus.scenarios) {
      for (const probe of scenario.probes) {
        results.push(
          await runProbe(probe, scenario.id, repoRoot, hub, developers, claims),
        );
      }
    }
    return { corpus, results, metrics: computeMetrics(results) };
  } finally {
    hub.stop();
    await rm(repoRoot, { recursive: true, force: true });
  }
};
