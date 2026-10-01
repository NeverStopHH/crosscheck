/**
 * The AT-7 harness entry point and sweep orchestrator (09 §3, §8).
 *
 *   bun packages/connector-claude/bench/at7/cli.ts --dry-run    --out <dir>
 *   bun packages/connector-claude/bench/at7/cli.ts --measured   --out <dir>
 *   bun packages/connector-claude/bench/at7/cli.ts --live-control [--out <dir>]
 *
 * Each run is fully isolated (§3): a fresh temp dir holding the fixture clone,
 * the hub's data dir and CROSSCHECK_HOME; a fresh hub; a fresh reader and dana
 * (attempt.ts runs and records one attempt). The order is drawn once from the
 * seeded manifest and written to the results dir BEFORE the first run.
 * Results live OUTSIDE the repo by default (a temp root) unless --out is given.
 *
 * `--live-control` is a plumbing check, not part of the pre-registered run
 * order (§8 does not mention it): ONE control run to prove delivery, isolation
 * and detection end to end. It is never counted, never runs a treatment, and is
 * reported as a plumbing check.
 *
 * Keys and tokens are never printed — the per-run log names arms and verdicts,
 * not secrets.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { harnessThrewFacts, runAttempt } from "./attempt.ts";
import type { AttemptFacts } from "./attempt.ts";
import { childEnv, runProcess } from "./exec.ts";
import { RUN_TRIPWIRE_MODE } from "./install.ts";
import { buildManifest } from "./manifest-doc.ts";
import { dryRunOrder, measuredOrder } from "./manifest.ts";
import type { Arm, Slot } from "./manifest.ts";
import { worktreeRoot } from "./paths.ts";
import { CONTROL_NOTE, PAYLOAD_TEMPLATES } from "./payloads.ts";
import { checkShellProfiles, profilePaths } from "./profile.ts";
import { buildReport, renderReport } from "./report.ts";
import type { ReportMode, RunOutcome } from "./report.ts";
import { claudeVersion } from "./run.ts";
import { INITIAL_PROGRESS, recordVoidAttempt, remainingSlots } from "./sweep.ts";

/** A string the briefing must carry to prove dana's work was shown (§7). */
const DANA_MARKER = "slug bug";

type Mode = ReportMode | "live-control";

interface CliArgs {
  /** null when no explicit mode was given — the harness then refuses (LOW). */
  readonly mode: Mode | null;
  readonly outDir: string;
  readonly resume: boolean;
}

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

/** A minimal AttemptFacts for an outcome loaded from disk (resume / void log). */
const factsFromOutcome = (outcome: RunOutcome): AttemptFacts => ({
  outcome,
  claudeVersion: "",
  model: null,
  mcpServers: [],
  plugins: [],
  briefing: null,
  timedOut: false,
});

/** The identity of the harness at measurement time, for the manifest (M4, §3). */
const harnessProvenance = async (): Promise<{
  readonly claudeVersion: string;
  readonly harnessHead: string;
  readonly harnessDirty: boolean;
  readonly payloadTemplateHash: string;
}> => {
  const root = worktreeRoot();
  const head = await runProcess(["git", "rev-parse", "HEAD"], { cwd: root });
  const status = await runProcess(["git", "status", "--porcelain"], { cwd: root });
  const payloadTemplateHash = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ CONTROL_NOTE, PAYLOAD_TEMPLATES }))
    .digest("hex");
  return {
    claudeVersion: await claudeVersion(),
    harnessHead: head.stdout.trim(),
    harnessDirty: status.stdout.trim().length > 0,
    payloadTemplateHash,
  };
};

const logLine = (facts: AttemptFacts): string => {
  const { outcome } = facts;
  return (
    `  hits=${outcome.hits.map((h) => `${h.id}:${h.label}`).join(",") || "none"} ` +
    `void=${outcome.voids.join(",") || "none"} ` +
    `task=${outcome.taskSucceeded ? "ok" : "RED"} ` +
    `mcp=[${facts.mcpServers.join(",")}] plugins=[${facts.plugins.join(",")}]` +
    (facts.error === undefined ? "" : ` error=${facts.error}`)
  );
};

/** One attempt in its own sub-dir, so a re-run never collides (A1.6, H1). */
const runSlotAttempt = async (
  slot: Slot,
  outDir: string,
  attempt: number,
): Promise<AttemptFacts> => {
  const runDir = join(slotDirOf(outDir, slot), `attempt-${String(attempt)}`);
  await mkdir(runDir, { recursive: true });
  return runAttempt({ slot, workRoot: runDir, resultsDir: runDir });
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
  // A2.2 residue: the Bash tool sources the user's shell profile, which the
  // env allowlist does not bound. Refuse to measure on a machine whose profile
  // sets a CROSSCHECK_/CLAUDE_/ANTHROPIC_ name; the check rides in the manifest.
  const shellProfileCheck = await checkShellProfiles(
    profilePaths(homedir(), process.env["ZDOTDIR"]),
  );
  if (!shellProfileCheck.clean) {
    const flagged = shellProfileCheck.files
      .filter((file) => file.present && (!file.readable || file.watched.length > 0))
      .map((file) => `${file.path}${file.readable ? `: ${file.watched.join(", ")}` : " (unreadable)"}`);
    process.stdout.write(
      `refusing: a shell profile sets a CROSSCHECK_/CLAUDE_/ANTHROPIC_ variable or cannot be read (A2.2):\n  ${flagged.join("\n  ")}\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (!args.resume) {
    const provenance = await harnessProvenance();
    const manifest = buildManifest({
      mode,
      order,
      ...provenance,
      env: runEnv,
      shellProfileCheck,
      createdAt: new Date().toISOString(),
    });
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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

  const facts: AttemptFacts[] = [...winners.values()].map(factsFromOutcome);
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
    let winner: AttemptFacts | null = null;
    for (let attempt = 1; winner === null; attempt += 1) {
      let candidate: AttemptFacts;
      try {
        candidate = await runSlotAttempt(slot, args.outDir, attempt);
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
