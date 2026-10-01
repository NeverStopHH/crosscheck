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
import { install } from "./install.ts";
import type { Arm, Slot } from "./manifest.ts";
import {
  relevanceIntent,
  relevanceTitle,
  renderControlBody,
  renderTreatmentBody,
} from "./payloads.ts";
import { startHubProxy } from "./proxy.ts";
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
import type { DriveResult, WorkingTree } from "./run.ts";
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
  readonly fixture: FixtureInfo;
  readonly drive: DriveResult;
  readonly tree: WorkingTree;
  readonly taskSucceeded: boolean;
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
  };
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

/** The full §6 record, persisted for the human review (M4). */
const recordDocument = (
  observed: Observed,
  canaryRequests: readonly string[],
  hubRequestBodies: readonly string[],
  gitDiff: string,
): unknown => {
  const { record } = observed.drive;
  return {
    slotIndex: observed.slot.index,
    arm: observed.slot.arm,
    model: record.init?.model ?? null,
    mcpServers: record.init?.mcpServers ?? [],
    plugins: record.init?.plugins ?? [],
    pluginCount: record.init?.pluginCount ?? 0,
    briefing: record.sessionStartBriefing,
    firstAssistantText: record.firstAssistantText,
    finalResultText: record.finalResultText,
    todoItems: record.todoItems,
    canaryRequests,
    hubRequestBodies,
    gitDiff,
    timedOut: observed.drive.timedOut,
  };
};

const factsOf = (observed: Observed, outcome: RunOutcome, version: string): AttemptFacts => {
  const { record } = observed.drive;
  return {
    outcome,
    claudeVersion: version,
    model: record.init?.model ?? null,
    mcpServers: mcpServerNames(record.init),
    plugins: record.init?.plugins ?? [],
    briefing: record.sessionStartBriefing,
    timedOut: observed.drive.timedOut,
  };
};

export const runAttempt = async (
  input: AttemptInput,
  deps: AttemptDeps = LIVE_DEPS,
): Promise<AttemptFacts> => {
  const { slot, workRoot, resultsDir } = input;
  const hubData = join(workRoot, HUB_DATA_DIR);
  await mkdir(hubData, { recursive: true });
  const token = deps.randomToken();
  const canary = deps.startCanary();
  const questionBody = questionBodyFor(slot.arm, token, canary.port);
  let hub: Awaited<ReturnType<AttemptDeps["startHub"]>> | null = null;
  let proxy: ReturnType<AttemptDeps["startHubProxy"]> | null = null;
  try {
    hub = await deps.startHub(hubData);
    // The reader's connector talks to the hub THROUGH this logging proxy, so
    // S5 can read every request body it sends (A1.7). dana seeds directly.
    proxy = deps.startHubProxy(hub.hubUrl);
    const fixture = await deps.createFixture(workRoot);
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
      questionBody,
      slotIndex: slot.index,
    });
    const installed = await deps.install({
      home: join(workRoot, CROSSCHECK_HOME_DIR),
      runTempDir: workRoot,
      hubUrl: proxy.url,
      readerKey: reader.apiKey,
      fixtureRoot: fixture.repoRoot,
    });
    await deps.commitWiring(fixture.repoRoot);

    const drive = await deps.driveClaude({
      fixtureRoot: fixture.repoRoot,
      mcpConfigPath: installed.mcpPath,
      env: installed.env,
      rawStreamPath: join(resultsDir, "stream.jsonl"),
    });
    const tree = await deps.collectWorkingTree(fixture.repoRoot, workRoot);
    const taskSucceeded = await deps.runFixtureTests(fixture.repoRoot);
    const detection = detectCriteria({
      token,
      canaryPort: canary.port,
      record: drive.record,
      workingTreeText: tree.text,
      workingTreeFiles: tree.files,
      canaryRequests: canary.requests,
      hubRequestBodies: proxy.requestBodies,
    });
    const voids = assessValidity({
      record: drive.record,
      expectedModel: RUN_MODEL,
      expectedAsksLine: renderedAsksLine(questionBody),
      hadTokenHit: detection.hadTokenHit,
      timedOut: drive.timedOut,
    });
    const observed: Observed = { slot, token, fixture, drive, tree, taskSucceeded, detection, voids };
    const outcome = outcomeOf(observed);
    await writeJson(join(resultsDir, "outcome.json"), { ...outcome, timedOut: drive.timedOut });
    const gitDiff = await deps.fixtureGitDiff(fixture.repoRoot);
    await writeJson(
      join(resultsDir, "record.json"),
      recordDocument(observed, canary.requests, proxy.requestBodies, gitDiff),
    );
    return factsOf(observed, outcome, await deps.claudeVersion());
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
  },
  claudeVersion: "",
  model: null,
  mcpServers: [],
  plugins: [],
  briefing: null,
  timedOut: false,
  error: error instanceof Error ? error.message : String(error),
});
