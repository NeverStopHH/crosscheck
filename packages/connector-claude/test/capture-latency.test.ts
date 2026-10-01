/**
 * The #17 worktree resolution measured through the real `runHook`, the other
 * half of the split test/hook-time-budget.test.ts uses: the per-tool capture
 * cost must fit the PostToolUse budget WITH ROOM even on the first touch of a
 * new worktree root (the one git-bearing case), and a warm cache must add
 * nothing measurable — that is what the per-session root cache buys, and the
 * reason the identity resolution is not paid per tool call.
 *
 * Elapsed times are printed so a slow run is a number in the log, not a guess.
 *
 * A wall clock cannot be red-first: main measures the same budgets at the same
 * order of magnitude — two samples on one machine gave post-tool-use 47/43 and
 * 40/33 ms cold/warm, pre-tool-use 39/38 and 34/34 — because it does no
 * resolution at all. Read those as an order of magnitude, not a constant: they
 * move with machine load, which is why the assertions below compare against
 * the budget rather than a fixed number. These are MEASUREMENTS of the
 * new cost, not proofs of the new behaviour — the behaviour is pinned by
 * worktree-capture.test.ts, and the cache's HIT path (the reason the warm
 * number stays flat) by the resolution COUNT in
 * connector-core/test/touched-root.test.ts, which a wall clock cannot see.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  HTTP_TIMEOUT_MS,
  MAX_LOSS_LEDGER_BYTES,
  POST_TOOL_USE_BUDGET_RATIO,
  PRE_TOOL_USE_BUDGET_RATIO,
  SESSION_START_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import {
  ensureDir,
  sessionSlug,
  spoolUnrecordedDropsPath,
  writePrivateFile,
} from "@crosscheck/connector-core/config/paths.ts";
import { recordDrop } from "@crosscheck/connector-core/spool/drops.ts";
import { readTelemetryLossReport } from "@crosscheck/connector-core/spool/loss-report.ts";
import { lossLedgerPath } from "@crosscheck/connector-core/state/loss-ledger.ts";
import { TEAMMATE_NAME, startSlowHub } from "./fixtures/slow-hub.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import {
  activeTeammateSession,
  startHintHub,
} from "../../connector-core/test/fixtures/hint-hub.ts";
import { hintDeliveryRecord } from "@crosscheck/connector-core/capture/records.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "capture-latency-uuid";
const DEAD_HUB_URL = "http://127.0.0.1:1";
const BUDGET_MS = POST_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS;
const PRE_BUDGET_MS = PRE_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS;
/** Headroom the warm path must clear the budget by: capture is fs + spool. */
const WARM_HEADROOM_MS = 400;
/**
 * What the pilot's counted ask may add to PreToolUse (07 PIL-9): one spool
 * append. Named, so the day it grows it is this number that is argued with.
 */
const TRIPWIRE_RECORD_ALLOWANCE_MS = 5;
const APPEND_SAMPLES = 50;
const P95 = 0.95;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const sessionState = (repoRoot: string): SessionState => ({
  hostSessionKey: SESSION_ID,
  crosscheckSessionId: `cc_${SESSION_ID}`,
  workContextId: `wc_cc_${SESSION_ID}`,
  repoId: REPO_ID,
  repoRoot,
  hubUrl: DEAD_HUB_URL,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: null,
  seenTargets: [],
  deliveredHintRefs: [],
  deliveredHintHashes: [],
  tripwireAskedFiles: [],
  landedAskedFiles: [],
  landedCleanKeys: [],
  briefingSolvedRefs: [],
  shownLandedNoticeIds: [],
  foreignRepoDrops: 0,
  outsideRootDrops: 0,
  knownWorktreeRoots: [],
  editToolFires: 0,
  targetsCapturedCount: 0,
  lastTargetAt: null,
  lastPostToolUseTool: null,
  lastEditedPath: null,
  lastEditedPathResolvedAgainst: null,
  hintCandidatesSeen: 0,
  briefingPending: false,
  stopTurnCount: 0,
  summarizerFireCount: 0,
  summarizerLastFireTurn: null,
  summarizerEstimatedTokens: 0,
  summarizerNoneCount: 0,
  summarizerDraftCount: 0,
  summarizerFailCount: 0,
  summarizerLastFailure: null,
  intentFireCount: 0,
  summarizerRejectCount: 0,
  summarizerLastRejection: null,
  summarizerNoSliceCount: 0,
  summarizerLastNoSlice: null,
  summarizerLastSliceShape: null,
  summarizerSliceDroppedChars: 0,
  summarizerUnreadableCount: 0,
  summarizerLastUnreadable: null,
  workContextTitle: null,
  workContextStatus: null,
  intentNoneCount: 0,
  intentSetCount: 0,
  intentFailCount: 0,
  intentLastFailure: null,
  workContextIntent: null,
  ghostPending: false,
  gitTouchCount: 0,
  gitLaneSkipped: 0,
  gitLaneRan: 0,
  ghostNoticeCount: 0,
  ghostFireCount: 0,
  ghostNoOverlapCount: 0,
  ghostNoHubAnswerCount: 0,
  ghostNoneCount: 0,
  ghostDraftCount: 0,
  ghostFailCount: 0,
  ghostLastFailure: null,
  seqEpoch: null,
  eventSeq: 0,
  toolWindows: [],
  toolWindowEvictions: 0,
  toolWindowMisses: 0,
  probedFingerprints: [],
});

const env = (home: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
  CROSSCHECK_SSH_CANONICALIZE: "off",
});

const editPayload = (cwd: string, worktree: string, file: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: join(worktree, file) },
    tool_response: {},
  });

describe("the per-tool worktree resolution fits the PostToolUse budget", () => {
  test("cold first-touch and warm cache both clear the budget with room", async () => {
    // Arrange: repo A with a committed config, one linked worktree B
    const main = await makeRepo("caplat", { remote: "git@github.com:acme/api.git" });
    await writeFile(
      join(main, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(main, ["add", "."]);
    await git(main, ["commit", "-m", "config"]);
    const worktree = join(await mkdtemp(join(tmpdir(), "cx-caplat-wt-")), "feature");
    await git(main, ["worktree", "add", worktree, "HEAD"]);
    const home = await makeHome("caplat");
    paths.push(main, join(worktree, ".."), home);
    await writeRepoFile(worktree, "src/one.ts", "export const a = 1;\n");
    await writeRepoFile(worktree, "src/two.ts", "export const b = 2;\n");
    await writeSessionState(home, sessionState(main));

    // Act: first touch of the worktree root resolves identity (cold); the
    // second touch of the SAME root reads the cache (warm).
    const coldStart = performance.now();
    await runHook("post-tool-use", editPayload(main, worktree, "src/one.ts"), env(home));
    const coldMs = Math.round(performance.now() - coldStart);

    const warmStart = performance.now();
    await runHook("post-tool-use", editPayload(main, worktree, "src/two.ts"), env(home));
    const warmMs = Math.round(performance.now() - warmStart);

    // Assert: both under budget; the warm path far under it (no git)
    console.log(
      `[capture-latency] cold ${String(coldMs)} ms, warm ${String(warmMs)} ms (budget ${String(BUDGET_MS)})`,
    );
    const targets = (await readSpoolLines(home, repoKey(DEAD_HUB_URL, REPO_ID)))
      .map((line) => JSON.parse(line) as { kind: string; body?: { value?: string } })
      .filter((record) => record.kind === "target")
      .map((record) => record.body?.value ?? "");
    expect(targets).toEqual(["src/one.ts", "src/two.ts"]);
    expect(coldMs).toBeLessThan(BUDGET_MS);
    expect(warmMs).toBeLessThan(BUDGET_MS - WARM_HEADROOM_MS);
  });

  test("the PreToolUse tripwire path clears its tighter budget cold and warm", async () => {
    // Arrange: same shape — the tripwire resolves the edited file's root the
    // same way (and persists the cache), under the 800 ms PreToolUse budget
    // that already contains the runner's own identity resolution.
    const main = await makeRepo("prelat", { remote: "git@github.com:acme/api.git" });
    await writeFile(
      join(main, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
      "utf8",
    );
    await git(main, ["add", "."]);
    await git(main, ["commit", "-m", "config"]);
    const worktree = join(await mkdtemp(join(tmpdir(), "cx-prelat-wt-")), "feature");
    await git(main, ["worktree", "add", worktree, "HEAD"]);
    const home = await makeHome("prelat");
    paths.push(main, join(worktree, ".."), home);
    await writeRepoFile(worktree, "src/one.ts", "export const a = 1;\n");
    await writeRepoFile(worktree, "src/two.ts", "export const b = 2;\n");
    await writeSessionState(home, sessionState(main));
    const prePayload = (file: string): string =>
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: main,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(worktree, file) },
      });

    // Act
    const coldStart = performance.now();
    await runHook("pre-tool-use", prePayload("src/one.ts"), env(home));
    const coldMs = Math.round(performance.now() - coldStart);
    const warmStart = performance.now();
    await runHook("pre-tool-use", prePayload("src/two.ts"), env(home));
    const warmMs = Math.round(performance.now() - warmStart);

    // Assert
    console.log(
      `[capture-latency] pre-tool-use cold ${String(coldMs)} ms, warm ${String(warmMs)} ms (budget ${String(PRE_BUDGET_MS)})`,
    );
    expect(coldMs).toBeLessThan(PRE_BUDGET_MS);
    expect(warmMs).toBeLessThan(PRE_BUDGET_MS - WARM_HEADROOM_MS);
  });

  /**
   * 07 PIL-9: THE COUNTED ASK IS MEASURED, NOT ASSERTED. The one thing the
   * pilot added to PreToolUse is a spool append on the path where the wire
   * TRIPS — the dead-hub runs above never trip, so they could not see it.
   * Two numbers: the whole tripping path against the hook's budget, and the
   * added work alone against a named allowance, so a regression shows up as
   * the thing that regressed rather than as a hook that got slower somehow.
   */
  test("a tripping ask, record included, clears the budget (07 PIL-9)", async () => {
    // Arrange — a live teammate on the file, so the wire trips and records.
    const repo = await makeRepo("prelat-trip", { remote: "git@github.com:acme/api.git" });
    const home = await makeHome("prelat-trip");
    paths.push(repo, home);
    await writeRepoFile(repo, "src/auth/refresh.ts", "export const a = 1;\n");
    const hub = startHintHub();
    hub.setTripwireSessions([activeTeammateSession()]);
    try {
      await writeSessionState(home, { ...sessionState(repo), hubUrl: hub.url });
      const payload = JSON.stringify({
        session_id: SESSION_ID,
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: join(repo, "src/auth/refresh.ts") },
      });
      const hubEnv: Env = { ...env(home), CROSSCHECK_HUB_URL: hub.url };

      // Act
      const start = performance.now();
      const stdout = await runHook("pre-tool-use", payload, hubEnv);
      const tripMs = Math.round(performance.now() - start);

      // Assert — it tripped, it recorded, and it stayed inside the budget
      console.log(
        `[capture-latency] pre-tool-use tripping ${String(tripMs)} ms (budget ${String(PRE_BUDGET_MS)})`,
      );
      expect(stdout).toContain("permissionDecision");
      const spooled = await readSpoolLines(home, repoKey(hub.url, REPO_ID));
      expect(spooled.some((line) => line.includes('"channel":"tripwire"'))).toBe(true);
      expect(tripMs).toBeLessThan(PRE_BUDGET_MS);
    } finally {
      hub.stop();
    }
  });

  test("the record the ask added costs one spool append, measured (07 PIL-9)", async () => {
    // Arrange
    const home = await makeHome("prelat-append");
    paths.push(home);
    const producer = { developerId: "dev_self", agentKind: "claude-code", sessionId: "cc_x" };
    const samples: number[] = [];

    // Act
    for (let run = 0; run < APPEND_SAMPLES; run += 1) {
      const now = new Date();
      const record = hintDeliveryRecord("cc_x", "work_context", `wc_${String(run)}`, "tripwire", producer, now);
      const start = performance.now();
      await appendRecords(home, "prelat-append", "prelat-append", [record], now);
      samples.push(performance.now() - start);
    }

    // Assert
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(APPEND_SAMPLES * P95) - 1] ?? Number.POSITIVE_INFINITY;
    console.log(
      `[capture-latency] tripwire record append p95 ${p95.toFixed(2)} ms over ${String(APPEND_SAMPLES)} runs (allowance ${String(TRIPWIRE_RECORD_ALLOWANCE_MS)})`,
    );
    expect(p95).toBeLessThan(TRIPWIRE_RECORD_ALLOWANCE_MS);
  });
});

/**
 * LOSS-12, second half (docs/1.0/loss-accounting.md §4.2, §6): the report is
 * MEASURED, not asserted. SessionStart reads it once — registration carries
 * it; the deferred ender does not — so what it adds is one local read of the
 * repo's `.drops` files, the archive, the unrecorded marker and the
 * capture-loss ledger. "Without" is a home with no ledgers, where that read
 * is a failed readdir and three failed opens; "with" is the worst shape the
 * owner's machine has shown (382 records in 343 batches) plus a capture-loss
 * ledger at its cap. Samples are interleaved so machine drift lands on both
 * arms. The one assertion is the bound that binds: the loaded hook still
 * answers its briefing inside SessionStart's budget.
 */
const SESSION_START_BUDGET_MS = SESSION_START_BUDGET_RATIO * HTTP_TIMEOUT_MS;
const REPORT_SAMPLES = 20;
/** The owner's doctor line: "382 records discarded in 343 batches". */
const OWNER_BATCHES = 343;
const OWNER_RECORDS = 382;
/** Spread over this many dead sessions' ledgers, so the readdir has files to open. */
const OWNER_LEDGER_FILES = 20;
const OWNER_REASONS = ["expired", "rejected", "cap", "ignored"] as const;

const p95Of = (samples: readonly number[]): number =>
  [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * P95) - 1] ??
  Number.POSITIVE_INFINITY;

const seedOwnerLedgers = async (home: string, key: string): Promise<void> => {
  const now = new Date();
  for (let batch = 0; batch < OWNER_BATCHES; batch += 1) {
    const reason = OWNER_REASONS[batch % OWNER_REASONS.length] ?? "expired";
    await recordDrop(
      home,
      key,
      sessionSlug(`dead-${String(batch % OWNER_LEDGER_FILES)}`),
      batch < OWNER_RECORDS - OWNER_BATCHES ? 2 : 1,
      reason,
      now,
      reason === "ignored" ? { claim_revalidation: 1 } : {},
    );
  }
  await writePrivateFile(
    spoolUnrecordedDropsPath(home, key),
    `${JSON.stringify({ at: now.toISOString(), count: 3, reason: "write-failed" })}\n`,
  );
  const line = `${JSON.stringify({ at: now.toISOString(), kind: "hook_timed_out", count: 1, key, detail: "post-tool-use" })}\n`;
  await ensureDir(join(home, "state"));
  await writeFile(lossLedgerPath(home), line.repeat(Math.ceil(MAX_LOSS_LEDGER_BYTES / line.length)), "utf8");
};

const startPayload = (repo: string, run: number): string =>
  JSON.stringify({
    session_id: `loss-latency-${String(run)}`,
    cwd: repo,
    hook_event_name: "SessionStart",
    source: "startup",
  });

describe("LOSS-12: what the loss report costs SessionStart, measured", () => {
  test("SessionStart p95 with and without the report, and the read alone", async () => {
    // Arrange: one hub answering at once, one clean home, one loaded home
    const hub = startSlowHub({ ingest: 0, end: 0, other: 0 });
    const repo = await makeRepo("losslat", { remote: "git@github.com:acme/api.git" });
    const clean = await makeHome("losslat-clean");
    const loaded = await makeHome("losslat-loaded");
    paths.push(repo, clean, loaded);
    const key = repoKey(hub.url, REPO_ID);
    await seedOwnerLedgers(loaded, key);
    const envOf = (home: string): Env => ({ ...env(home), CROSSCHECK_HUB_URL: hub.url });
    const without: number[] = [];
    const withReport: number[] = [];
    const readAlone: number[] = [];
    let lastLoaded = "";

    try {
      // Act
      for (let run = 0; run < REPORT_SAMPLES; run += 1) {
        const startClean = performance.now();
        await runHook("session-start", startPayload(repo, run), envOf(clean));
        without.push(performance.now() - startClean);

        const startLoaded = performance.now();
        lastLoaded = await runHook("session-start", startPayload(repo, run), envOf(loaded));
        withReport.push(performance.now() - startLoaded);

        const startRead = performance.now();
        await readTelemetryLossReport(loaded, key);
        readAlone.push(performance.now() - startRead);
      }
    } finally {
      hub.stop();
    }

    // Assert: the numbers are the deliverable; the budget is the one bound
    const report = await readTelemetryLossReport(loaded, key);
    console.log(
      `[capture-latency] LOSS-12 SessionStart p95 ${p95Of(without).toFixed(1)} ms without the report (no ledgers), ` +
        `${p95Of(withReport).toFixed(1)} ms with it (${String(report.total)} losses); ` +
        `report read alone p95 ${p95Of(readAlone).toFixed(2)} ms; ${String(REPORT_SAMPLES)} interleaved runs; ` +
        `budget ${String(SESSION_START_BUDGET_MS)} ms`,
    );
    expect(report.total).toBeGreaterThan(OWNER_RECORDS);
    expect(lastLoaded).toContain(TEAMMATE_NAME);
    expect(p95Of(withReport)).toBeLessThan(SESSION_START_BUDGET_MS);
  }, 120_000);
});
