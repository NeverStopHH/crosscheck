/**
 * The AT-7 harness entry point and per-run orchestrator (09 §3, §8).
 *
 *   bun packages/connector-claude/bench/at7/cli.ts --dry-run    --out <dir>
 *   bun packages/connector-claude/bench/at7/cli.ts --measured   --out <dir>
 *   bun packages/connector-claude/bench/at7/cli.ts --live-control [--out <dir>]
 *
 * Each run is fully isolated (§3): a fresh temp dir holding the fixture clone,
 * the hub's data dir and CROSSCHECK_HOME; a fresh hub; a fresh reader and dana.
 * The order is drawn once from the seeded manifest and written to the results
 * dir BEFORE the first run. Results live OUTSIDE the repo by default (a temp
 * root) unless --out is given.
 *
 * `--live-control` is the single plumbing check the pre-registration permits
 * after the harness is green: ONE control run, to prove delivery, isolation and
 * detection end to end. It is not counted, and it never runs a treatment.
 *
 * Keys and tokens are never printed — the per-run log names arms and verdicts,
 * not secrets.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectCriteria, assessValidity } from "./detect.ts";
import { renderedAsksLine } from "./delivery.ts";
import { mcpServerNames } from "./stream.ts";
import { createFixture, commitWiring } from "./fixture.ts";
import { childEnv } from "./exec.ts";
import { install, RUN_TRIPWIRE_MODE } from "./install.ts";
import { createDeveloper, seedDanaWork, startHub } from "./hub.ts";
import { startHubProxy } from "./proxy.ts";
import { dryRunOrder, measuredOrder } from "./manifest.ts";
import type { Arm, Slot } from "./manifest.ts";
import {
  relevanceIntent,
  relevanceTitle,
  renderControlBody,
  renderTreatmentBody,
} from "./payloads.ts";
import { buildReport, renderReport } from "./report.ts";
import type { ReportMode, RunOutcome } from "./report.ts";
import { INITIAL_PROGRESS, recordVoidAttempt, remainingSlots } from "./sweep.ts";
import {
  claudeVersion,
  collectWorkingTree,
  driveClaude,
  RUN_MODEL,
  runFixtureTests,
  startCanary,
} from "./run.ts";

/** A string the briefing must carry to prove dana's work was shown (§7). */
const DANA_MARKER = "slug bug";

type Mode = ReportMode | "live-control";

interface CliArgs {
  /** null when no explicit mode was given — the harness then refuses (LOW). */
  readonly mode: Mode | null;
  readonly outDir: string;
  readonly resume: boolean;
}

const randomToken = (): string =>
  `at7-${Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

const randomTag = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const parseArgs = (argv: readonly string[]): CliArgs => {
  // Explicit mode only: an unknown or typo'd flag must NOT default to a paid
  // dry run (LOW). null here makes main() refuse with usage.
  const mode: Mode | null = argv.includes("--measured")
    ? "measured"
    : argv.includes("--dry-run")
      ? "dry-run"
      : argv.includes("--live-control")
        ? "live-control"
        : null;
  const outIndex = argv.indexOf("--out");
  const outDir =
    outIndex !== -1 && argv[outIndex + 1] !== undefined
      ? (argv[outIndex + 1] as string)
      : join(tmpdir(), `at7-results-${String(Date.now())}`);
  return { mode, outDir, resume: argv.includes("--resume") };
};

const armLabel = (arm: Arm): string =>
  arm.kind === "control" ? "control" : arm.payload;

interface SlotFacts {
  readonly outcome: RunOutcome;
  readonly claudeVersion: string;
  readonly model: string | null;
  readonly mcpServers: readonly string[];
  readonly plugins: readonly string[];
  readonly briefing: string | null;
  readonly timedOut: boolean;
  /** Set only when a harness throw produced this (void) SlotFacts (H1). */
  readonly error?: string;
}

const questionBodyFor = (arm: Arm, token: string, port: number): string =>
  arm.kind === "control"
    ? renderControlBody()
    : renderTreatmentBody(arm.payload, { token, port });

const runOneSlot = async (
  slot: Slot,
  outDir: string,
  attempt: number,
): Promise<SlotFacts> => {
  const label = armLabel(slot.arm);
  const slotDir = join(
    outDir,
    "runs",
    `${String(slot.index).padStart(2, "0")}-${label}`,
  );
  // A fresh sub-dir per attempt: a re-run in the same slot must not collide
  // with the voided attempt's fixture clone, hub data or stream (A1.6, H1).
  const runDir = join(slotDir, `attempt-${String(attempt)}`);
  const home = join(runDir, "crosscheck-home");
  const hubData = join(runDir, "hub-data");
  const rawStreamPath = join(runDir, "stream.jsonl");
  await mkdir(runDir, { recursive: true });
  await mkdir(hubData, { recursive: true });

  const token = randomToken();
  const canary = startCanary();
  const questionBody = questionBodyFor(slot.arm, token, canary.port);
  let hub: Awaited<ReturnType<typeof startHub>> | null = null;
  let proxy: ReturnType<typeof startHubProxy> | null = null;
  try {
    hub = await startHub(hubData);
    // The reader's connector talks to the hub THROUGH this logging proxy, so
    // S5 can read every request body it sends (A1.7). dana seeds directly.
    proxy = startHubProxy(hub.hubUrl);
    const fixture = await createFixture(runDir);
    const tag = randomTag();
    const reader = await createDeveloper(
      hub,
      `AT7 Reader ${String(slot.index)} ${tag}`,
      `reader-${String(slot.index)}-${tag}@at7-bench.invalid`,
    );
    const dana = await createDeveloper(
      hub,
      `AT7 Dana ${String(slot.index)} ${tag}`,
      `dana-${String(slot.index)}-${tag}@at7-bench.invalid`,
    );
    await seedDanaWork({
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
    const installed = await install({
      home,
      runTempDir: runDir,
      hubUrl: proxy.url,
      readerKey: reader.apiKey,
      fixtureRoot: fixture.repoRoot,
    });
    await commitWiring(fixture.repoRoot);

    const drive = await driveClaude({
      fixtureRoot: fixture.repoRoot,
      mcpConfigPath: installed.mcpPath,
      env: installed.env,
      rawStreamPath,
    });
    const tree = await collectWorkingTree(fixture.repoRoot);
    const taskSucceeded = await runFixtureTests(fixture.repoRoot);

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
    const { record } = drive;
    const outcome: RunOutcome = {
      slotIndex: slot.index,
      arm: slot.arm,
      token,
      hits: detection.hits,
      voids,
      taskSucceeded,
      toolCallCount: record.toolUses.length,
      turns: record.numTurns,
      durationMs: record.durationMs,
      costUsd: record.totalCostUsd,
      filesRead: record.filesRead,
      filesWritten: record.filesWritten,
      filesEdited: record.filesEdited,
      bashCommands: record.bashCommands,
      toolNames: record.toolUses.map((use) => use.name),
      todoItems: record.todoItems,
    };
    await writeFile(
      join(runDir, "outcome.json"),
      `${JSON.stringify({ ...outcome, timedOut: drive.timedOut }, null, 2)}\n`,
      "utf8",
    );
    return {
      outcome,
      claudeVersion: await claudeVersion(),
      model: record.init?.model ?? null,
      mcpServers: mcpServerNames(record.init),
      plugins: record.init?.plugins ?? [],
      briefing: record.sessionStartBriefing,
      timedOut: drive.timedOut,
    };
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

/** A void SlotFacts for a slot whose attempt threw before producing one (H1). */
const harnessThrewFacts = (slot: Slot, error: unknown): SlotFacts => ({
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

const orderFor = (mode: Mode): readonly Slot[] => {
  if (mode === "measured") {
    return measuredOrder();
  }
  if (mode === "dry-run") {
    return dryRunOrder();
  }
  return [{ index: 0, arm: { kind: "control" } }];
};

/** Lines a control run may safely show: dana's rendered block, never a key. */
const danaBriefingLines = (briefing: string | null): string => {
  if (briefing === null) {
    return "(no briefing)";
  }
  const lines = briefing
    .split("\n")
    .filter(
      (line) =>
        line.toLowerCase().includes(DANA_MARKER) ||
        line.includes("Dana") ||
        line.trim().startsWith("asks:"),
    );
  return lines.length === 0
    ? "(briefing present, no dana line matched)"
    : lines.join("\n");
};

const USAGE =
  "usage: bun bench/at7/cli.ts (--dry-run | --measured | --live-control) [--out <dir>] [--resume]\n";

const slotDirOf = (outDir: string, slot: Slot): string =>
  join(outDir, "runs", `${String(slot.index).padStart(2, "0")}-${armLabel(slot.arm)}`);

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
};

/** Valid winner outcomes already on disk, keyed by slot index (resume, H1). */
const loadWinners = async (
  outDir: string,
  order: readonly Slot[],
): Promise<Map<number, RunOutcome>> => {
  const winners = new Map<number, RunOutcome>();
  for (const slot of order) {
    const outcome = (await readJson(join(slotDirOf(outDir, slot), "outcome.json"))) as
      | RunOutcome
      | null;
    if (outcome !== null && Array.isArray(outcome.voids) && outcome.voids.length === 0) {
      winners.set(slot.index, outcome);
    }
  }
  return winners;
};

/** A minimal SlotFacts for an outcome loaded from disk (resume / void log). */
const factsFromOutcome = (outcome: RunOutcome): SlotFacts => ({
  outcome,
  claudeVersion: "",
  model: null,
  mcpServers: [],
  plugins: [],
  briefing: null,
  timedOut: false,
});

const logLine = (facts: SlotFacts): string => {
  const { outcome } = facts;
  return (
    `  hits=${outcome.hits.map((h) => `${h.id}:${h.label}`).join(",") || "none"} ` +
    `void=${outcome.voids.join(",") || "none"} ` +
    `task=${outcome.taskSucceeded ? "ok" : "RED"} ` +
    `mcp=[${facts.mcpServers.join(",")}] plugins=[${facts.plugins.join(",")}]` +
    (facts.error === undefined ? "" : ` error=${facts.error}`)
  );
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === null) {
    process.stdout.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const mode = args.mode;
  const reportMode: ReportMode = mode === "measured" ? "measured" : "dry-run";
  const order = orderFor(mode);
  const manifestFile = join(args.outDir, "manifest.json");
  await mkdir(args.outDir, { recursive: true });

  // Refuse an out dir that already holds a manifest unless --resume: a sweep
  // must never silently re-run into another's results (H1).
  const existingManifest = await readJson(manifestFile);
  if (existingManifest !== null && !args.resume) {
    process.stdout.write(
      `refusing: ${manifestFile} already exists — use --resume, or a fresh --out\n`,
    );
    process.exitCode = 2;
    return;
  }

  const runEnv = childEnv(process.env, {
    CROSSCHECK_HOME: "<per-run temp dir>",
    CROSSCHECK_TRIPWIRE: RUN_TRIPWIRE_MODE,
  });
  if (!args.resume) {
    await writeFile(
      manifestFile,
      `${JSON.stringify({ mode, model: RUN_MODEL, env: runEnv, order }, null, 2)}\n`,
      "utf8",
    );
  }

  // Resume: completed winners are kept, their void attempts replayed into the
  // tally, and only the unfinished slots are run (H1).
  const winners: Map<number, RunOutcome> = args.resume
    ? await loadWinners(args.outDir, order)
    : new Map();
  const voidLogPath = join(args.outDir, "voids.jsonl");
  const priorVoids = args.resume
    ? (await readFile(voidLogPath, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line.trim().length > 0)
    : [];
  const todo = remainingSlots(order, winners.keys());
  process.stdout.write(
    `AT-7 ${mode}: ${String(order.length)} run(s), ${String(todo.length)} to do; results in ${args.outDir}\n`,
  );

  const facts: SlotFacts[] = [...winners.values()].map(factsFromOutcome);
  // Prior void attempts are recorded outcomes too (A1.6) — fold them back in.
  for (const line of priorVoids) {
    try {
      facts.push(factsFromOutcome(JSON.parse(line) as RunOutcome));
    } catch {
      // A torn void-log line contributes nothing.
    }
  }
  // Prior voids seed the cap so a resume cannot exceed five across restarts.
  let progress = { ...INITIAL_PROGRESS, voidAttempts: priorVoids.length };
  let aborted = false;

  for (const slot of todo) {
    process.stdout.write(`· run #${String(slot.index)} ${armLabel(slot.arm)} …\n`);
    let winner: SlotFacts | null = null;
    for (let attempt = 1; winner === null; attempt += 1) {
      let candidate: SlotFacts;
      try {
        candidate = await runOneSlot(slot, args.outDir, attempt);
      } catch (error) {
        candidate = harnessThrewFacts(slot, error);
      }
      process.stdout.write(`${logLine(candidate)}\n`);
      if (candidate.outcome.voids.length === 0) {
        winner = candidate;
        break;
      }
      // A void attempt: record it, count it toward the cap, re-run in the slot.
      facts.push(candidate);
      await appendFile(voidLogPath, `${JSON.stringify(candidate.outcome)}\n`).catch(
        () => undefined,
      );
      progress = recordVoidAttempt(progress);
      if (progress.aborted) {
        aborted = true;
        break;
      }
    }
    if (winner === null) {
      break;
    }
    facts.push(winner);
    await writeFile(
      join(slotDirOf(args.outDir, slot), "outcome.json"),
      `${JSON.stringify(winner.outcome, null, 2)}\n`,
      "utf8",
    );
  }

  if (aborted) {
    process.stdout.write(
      `\nABORTED: more than ${String(progress.voidAttempts - 1)} void attempts — harness trouble, the measurement is void (§7/A1.6). No verdict.\n`,
    );
  }

  const report = buildReport(
    facts.map((f) => f.outcome),
    { mode: reportMode },
  );
  const text = renderReport(report);
  await writeFile(join(args.outDir, "report.txt"), `${text}\n`, "utf8");
  await writeFile(
    join(args.outDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`\n${text}\n`);

  if (args.mode === "live-control") {
    const only = facts[0];
    if (only !== undefined) {
      process.stdout.write(
        "\n--- live control facts ---\n" +
          `claude: ${only.claudeVersion}\n` +
          `model (init): ${only.model ?? "(none)"}\n` +
          `mcp servers: [${only.mcpServers.join(", ")}]\n` +
          `plugins: [${only.plugins.join(", ")}]\n` +
          `task success: ${only.outcome.taskSucceeded ? "yes" : "no"}\n` +
          `detector hits: ${only.outcome.hits.map((h) => h.id).join(",") || "none"}\n` +
          `cost usd: ${String(only.outcome.costUsd ?? "?")}\n` +
          `duration ms: ${String(only.outcome.durationMs ?? "?")}\n` +
          `dana lines in briefing:\n${danaBriefingLines(only.briefing)}\n`,
      );
    }
  }
};

if (import.meta.main) {
  await main();
}
