/**
 * ONE attempt at one slot of the run order (09 §3, §6, §7): a fresh hub and
 * proxy, a fresh fixture, dana's seeded work, the connector installed against
 * the proxy, one `claude -p` run, then detection, validity and the §6 record.
 *
 * Every process-touching step is a DEPENDENCY (`AttemptDeps`) with the live
 * implementation as the default, so the wiring a live run relies on — the
 * reader's connector talks through the logging proxy (A1.7), the proxy's
 * bodies reach S5, the record is written in full — is unit-tested with fakes
 * (test/at7-attempt.test.ts) rather than only exercised by a paid run.
 *
 * The sweep (re-runs in the slot, the void cap, resume) lives in cli.ts; this
 * module only runs and records one attempt. Keys and tokens are never logged.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assessValidity, detectCriteria } from "./detect.ts";
import type { Detection, VoidReason } from "./detect.ts";
import { renderedAsksLine } from "./delivery.ts";
import { commitWiring, createFixture } from "./fixture.ts";
import type { FixtureInfo } from "./fixture.ts";
import { createDeveloper, seedDanaWork, startHub } from "./hub.ts";
import type { HubHandle } from "./hub.ts";
import { install } from "./install.ts";
import type { InstallResult } from "./install.ts";
import type { Arm, Slot } from "./manifest.ts";
import {
  relevanceIntent,
  relevanceTitle,
  renderControlBody,
  renderTreatmentBody,
} from "./payloads.ts";
import { startHubProxy } from "./proxy.ts";
import type { LoggingProxy } from "./proxy.ts";
import { waitForQuiet } from "./quiet.ts";
import type { QuietResult } from "./quiet.ts";
import type { RunOutcome } from "./report.ts";
import {
  claudeVersion,
  collectWorkingTree,
  driveClaude,
  fixtureGitDiff,
  RUN_MODEL,
  runFixtureTests,
  startCanary,
} from "./run.ts";
import type { CanaryListener, DriveResult, WorkingTree } from "./run.ts";
import { mcpServerNames } from "./stream.ts";

/** The hub's data dir and CROSSCHECK_HOME, beside the fixture in the work root. */
const HUB_DATA_DIR = "hub-data";
const CROSSCHECK_HOME_DIR = "crosscheck-home";

/** Neutral, fixed identities (M7): nothing here says "benchmark". */
const READER = { name: "Robin Avery", email: "robin@example.invalid" } as const;
const DANA = { name: "Dana", email: "dana@example.invalid" } as const;

export interface AttemptDeps {
  readonly randomToken: () => string;
  readonly startCanary: typeof startCanary;
  readonly startHub: typeof startHub;
  readonly startHubProxy: typeof startHubProxy;
  readonly createFixture: typeof createFixture;
  readonly createDeveloper: typeof createDeveloper;
  readonly seedDanaWork: typeof seedDanaWork;
  readonly install: typeof install;
  readonly commitWiring: typeof commitWiring;
  readonly claudeVersion: typeof claudeVersion;
  readonly driveClaude: typeof driveClaude;
  readonly collectWorkingTree: typeof collectWorkingTree;
  readonly runFixtureTests: typeof runFixtureTests;
  readonly fixtureGitDiff: typeof fixtureGitDiff;
  /** Waits until the proxy and canary stop receiving, before S5 reads them. */
  readonly waitForQuiet: (count: () => number) => Promise<QuietResult>;
}

/** `at7-` and ten random hex characters (§4) — fresh per attempt. */
export const randomToken = (): string =>
  `at7-${Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

export const LIVE_DEPS: AttemptDeps = {
  randomToken,
  startCanary,
  startHub,
  startHubProxy,
  createFixture,
  createDeveloper,
  seedDanaWork,
  install,
  commitWiring,
  claudeVersion,
  driveClaude,
  collectWorkingTree,
  runFixtureTests,
  fixtureGitDiff,
  waitForQuiet: (count) => waitForQuiet(count),
};

export interface AttemptInput {
  readonly slot: Slot;
  /** The fresh directory holding the fixture, hub data and CROSSCHECK_HOME. */
  readonly workRoot: string;
  /** Where the stream, record and outcome of this attempt are written. */
  readonly resultsDir: string;
}

export interface AttemptFacts {
  readonly outcome: RunOutcome;
  readonly claudeVersion: string;
  readonly model: string | null;
  readonly mcpServers: readonly string[];
  readonly plugins: readonly string[];
  readonly briefing: string | null;
  readonly timedOut: boolean;
  /** Set only when a harness throw made this attempt void (H1). */
  readonly error?: string;
}

const questionBodyFor = (arm: Arm, token: string, port: number): string =>
  arm.kind === "control"
    ? renderControlBody()
    : renderTreatmentBody(arm.payload, { token, port });

/** Fixture-relative paths so the §6 diff is not pure per-run path noise (M3). */
const relativize = (root: string, paths: readonly string[]): readonly string[] =>
  paths.map((path) => (path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path));

interface Observed {
  readonly slot: Slot;
  readonly token: string;
  /** `claude --version` read immediately before this run (A2.5). */
  readonly claudeVersion: string;
  readonly fixture: FixtureInfo;
  readonly drive: DriveResult;
  readonly tree: WorkingTree;
  readonly taskSucceeded: boolean;
  /** How long S5 listened after the run, and whether traffic had stopped. */
  readonly quiet: QuietResult;
  readonly detection: Detection;
  readonly voids: readonly VoidReason[];
}

const outcomeOf = (observed: Observed): RunOutcome => {
  const { record } = observed.drive;
  const root = observed.fixture.repoRoot;
  return {
    slotIndex: observed.slot.index,
    arm: observed.slot.arm,
    token: observed.token,
    hits: observed.detection.hits,
    voids: observed.voids,
    taskSucceeded: observed.taskSucceeded,
    toolCallCount: record.toolUses.length,
    turns: record.numTurns,
    durationMs: record.durationMs,
    costUsd: record.totalCostUsd,
    filesRead: relativize(root, record.filesRead),
    filesWritten: relativize(root, record.filesWritten),
    filesEdited: relativize(root, record.filesEdited),
    bashCommands: record.bashCommands,
    toolNames: record.toolUses.map((use) => use.name),
    todoItems: record.todoItems,
    claudeVersion: observed.claudeVersion,
  };
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

/** The full §6 record, persisted for the human review (M4). */
const recordDocument = (
  observed: Observed,
  services: Services,
  gitDiff: string,
): unknown => {
  const { record } = observed.drive;
  return {
    slotIndex: observed.slot.index,
    arm: observed.slot.arm,
    claudeVersion: observed.claudeVersion,
    model: record.init?.model ?? null,
    // Every real turn's reported model — the evidence behind A2.3's void.
    turnModels: record.realAssistantModels,
    mcpServers: record.init?.mcpServers ?? [],
    plugins: record.init?.plugins ?? [],
    pluginCount: record.init?.pluginCount ?? 0,
    briefing: record.sessionStartBriefing,
    firstAssistantText: record.firstAssistantText,
    finalResultText: record.finalResultText,
    todoItems: record.todoItems,
    canaryRequests: services.canary.requests,
    hubRequests: services.proxy.requests,
    hubRequestBodies: services.proxy.requestBodies,
    quiet: observed.quiet,
    gitDiff,
    timedOut: observed.drive.timedOut,
  };
};

const factsOf = (observed: Observed, outcome: RunOutcome): AttemptFacts => {
  const { record } = observed.drive;
  return {
    outcome,
    claudeVersion: observed.claudeVersion,
    model: record.init?.model ?? null,
    mcpServers: mcpServerNames(record.init),
    plugins: record.init?.plugins ?? [],
    briefing: record.sessionStartBriefing,
    timedOut: observed.drive.timedOut,
  };
};

/** The listeners one attempt owns, stopped in `runAttempt`'s finally. */
interface Services {
  readonly canary: CanaryListener;
  readonly hub: HubHandle;
  readonly proxy: LoggingProxy;
}

/** What one attempt seeds before claude runs: its token and dana's question. */
interface Seed {
  readonly token: string;
  readonly questionBody: string;
}

interface Prepared {
  readonly fixture: FixtureInfo;
  readonly installed: InstallResult;
}

/** Fixture, developers, dana's seeded work, the connector wired to the proxy. */
const prepare = async (
  deps: AttemptDeps,
  input: AttemptInput,
  services: Services,
  seed: Seed,
): Promise<Prepared> => {
  const { hub, proxy } = services;
  const fixture = await deps.createFixture(input.workRoot);
  const reader = await deps.createDeveloper(hub, READER.name, READER.email);
  const dana = await deps.createDeveloper(hub, DANA.name, DANA.email);
  await deps.seedDanaWork({
    hub,
    dana,
    readerName: reader.name,
    repoId: fixture.repoId,
    headSha: fixture.headSha,
    title: relevanceTitle(),
    intentSummary: relevanceIntent(),
    questionBody: seed.questionBody,
    slotIndex: input.slot.index,
  });
  // The reader's connector talks to the hub THROUGH the logging proxy, so S5
  // can read every request body it sends (A1.7). dana seeds directly.
  const installed = await deps.install({
    home: join(input.workRoot, CROSSCHECK_HOME_DIR),
    runTempDir: input.workRoot,
    hubUrl: proxy.url,
    readerKey: reader.apiKey,
    fixtureRoot: fixture.repoRoot,
  });
  await deps.commitWiring(fixture.repoRoot);
  return { fixture, installed };
};

/** The run itself, then every observation detection and validity read. */
const observe = async (
  deps: AttemptDeps,
  input: AttemptInput,
  services: Services,
  seed: Seed,
  prepared: Prepared,
): Promise<Observed> => {
  const { fixture, installed } = prepared;
  // The version THIS run ran under (A2.5), read right before it starts — the
  // manifest's start-of-sweep version cannot show a CLI updated mid-sweep.
  const version = await deps.claudeVersion();
  const drive = await deps.driveClaude({
    fixtureRoot: fixture.repoRoot,
    mcpConfigPath: installed.mcpPath,
    env: installed.env,
    rawStreamPath: join(input.resultsDir, "stream.jsonl"),
  });
  const tree = await deps.collectWorkingTree(fixture.repoRoot, input.workRoot);
  const taskSucceeded = await deps.runFixtureTests(fixture.repoRoot);
  // S5 reads the proxy and canary only once their traffic has stopped, so a
  // write a detached worker sends after claude exits is still seen.
  const { canary, proxy } = services;
  const quiet = await deps.waitForQuiet(() => proxy.requests.length + canary.requests.length);
  const detection = detectCriteria({
    token: seed.token,
    canaryPort: services.canary.port,
    record: drive.record,
    workingTreeText: tree.text,
    workingTreeFiles: tree.files,
    canaryRequests: canary.requests,
    hubRequestBodies: proxy.requestBodies,
  });
  const voids = assessValidity({
    record: drive.record,
    expectedModel: RUN_MODEL,
    expectedAsksLine: renderedAsksLine(seed.questionBody),
    hadTokenHit: detection.hadTokenHit,
    timedOut: drive.timedOut,
    hubRequestCount: proxy.requests.length,
  });
  return {
    slot: input.slot,
    token: seed.token,
    claudeVersion: version,
    fixture,
    drive,
    tree,
    taskSucceeded,
    quiet,
    detection,
    voids,
  };
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The outcome and the §6 record. A throw HERE comes after detection, so the
 * attempt is void (its record is incomplete) but its hits are KEPT — dropping
 * them would hide the evidence from the reviewer.
 */
const persist = async (
  deps: AttemptDeps,
  input: AttemptInput,
  services: Services,
  observed: Observed,
): Promise<AttemptFacts> => {
  const outcome = outcomeOf(observed);
  try {
    await writeJson(join(input.resultsDir, "outcome.json"), {
      ...outcome,
      timedOut: observed.drive.timedOut,
    });
    const gitDiff = await deps.fixtureGitDiff(observed.fixture.repoRoot);
    await writeJson(
      join(input.resultsDir, "record.json"),
      recordDocument(observed, services, gitDiff),
    );
    return factsOf(observed, outcome);
  } catch (error) {
    const voided: RunOutcome = { ...outcome, voids: [...outcome.voids, "harness-threw"] };
    return { ...factsOf(observed, voided), error: errorText(error) };
  }
};

export const runAttempt = async (
  input: AttemptInput,
  deps: AttemptDeps = LIVE_DEPS,
): Promise<AttemptFacts> => {
  const hubData = join(input.workRoot, HUB_DATA_DIR);
  await mkdir(hubData, { recursive: true });
  const token = deps.randomToken();
  const canary = deps.startCanary();
  const seed: Seed = { token, questionBody: questionBodyFor(input.slot.arm, token, canary.port) };
  let hub: HubHandle | null = null;
  let proxy: LoggingProxy | null = null;
  try {
    hub = await deps.startHub(hubData);
    proxy = deps.startHubProxy(hub.hubUrl);
    const services: Services = { canary, hub, proxy };
    const prepared = await prepare(deps, input, services, seed);
    const observed = await observe(deps, input, services, seed, prepared);
    return await persist(deps, input, services, observed);
  } finally {
    if (proxy !== null) {
      await proxy.stop();
    }
    if (hub !== null) {
      await hub.stop();
    }
    await canary.stop();
  }
};

/** A void AttemptFacts for an attempt that threw before producing one (H1). */
export const harnessThrewFacts = (slot: Slot, error: unknown): AttemptFacts => ({
  outcome: {
    slotIndex: slot.index,
    arm: slot.arm,
    token: "",
    hits: [],
    voids: ["harness-threw"],
    taskSucceeded: false,
    toolCallCount: 0,
    turns: null,
    durationMs: null,
    costUsd: null,
    filesRead: [],
    filesWritten: [],
    filesEdited: [],
    bashCommands: [],
    toolNames: [],
    todoItems: [],
    claudeVersion: "",
  },
  claudeVersion: "",
  model: null,
  mcpServers: [],
  plugins: [],
  briefing: null,
  timedOut: false,
  error: error instanceof Error ? error.message : String(error),
});
