/**
 * The AT-7 harness entry point (09 §3, §8).
 *
 *   bun packages/connector-claude/bench/at7/cli.ts --dry-run    --out <dir>
 *   bun packages/connector-claude/bench/at7/cli.ts --measured   --out <dir>
 *   bun packages/connector-claude/bench/at7/cli.ts --live-control [--out <dir>]
 *
 * Each run is fully isolated (§3): a fresh temp dir holding the fixture clone,
 * the hub's data dir and CROSSCHECK_HOME, under an opaque per-attempt id
 * (A2.4); a fresh hub; a fresh reader and dana (attempt.ts). The sweep —
 * re-runs in the slot, the void cap, resume — is driver.ts. The order is
 * drawn once from the seeded manifest and written to the results dir BEFORE
 * the first run. Results live OUTSIDE the repo by default (a temp root)
 * unless --out is given; the agent's working directories are never under the
 * results dir.
 *
 * `--live-control` is a plumbing check, not part of the pre-registered run
 * order (§8 does not mention it): ONE control run to prove delivery, isolation
 * and detection end to end. It is never counted, never runs a treatment, and is
 * reported as a plumbing check.
 *
 * Exit codes: 0 when the sweep finished, 1 when it aborted on the void cap, 2
 * when it refused to start. Keys and tokens are never printed.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { runAttempt } from "./attempt.ts";
import type { AttemptFacts } from "./attempt.ts";
import { runSweep } from "./driver.ts";
import { childEnv, runProcess } from "./exec.ts";
import { RUN_TRIPWIRE_MODE } from "./install.ts";
import { pathWithout } from "./layout.ts";
import { buildManifest, startDecision } from "./manifest-doc.ts";
import type { SweepMode } from "./manifest-doc.ts";
import { dryRunOrder, measuredOrder } from "./manifest.ts";
import type { Slot } from "./manifest.ts";
import { worktreeRoot } from "./paths.ts";
import { CONTROL_NOTE, PAYLOAD_TEMPLATES } from "./payloads.ts";
import { checkShellProfiles, profilePaths } from "./profile.ts";
import type { ProfileCheck } from "./profile.ts";
import { buildReport, renderReport } from "./report.ts";
import type { ReportMode } from "./report.ts";
import { claudeVersion } from "./run.ts";
import { VOID_BUDGET } from "./sweep.ts";

/** A string the briefing must carry to prove dana's work was shown (§7). */
const DANA_MARKER = "slug bug";

const EXIT_ABORTED = 1;
const EXIT_REFUSED = 2;
const EXIT_PAUSED = 3;

interface CliArgs {
  /** null when no explicit mode was given — the harness then refuses (LOW). */
  readonly mode: SweepMode | null;
  readonly outDir: string;
  readonly resume: boolean;
}

const parseArgs = (argv: readonly string[]): CliArgs => {
  // Explicit mode only: an unknown or typo'd flag must NOT default to a paid
  // dry run (LOW). null here makes main() refuse with usage.
  const mode: SweepMode | null = argv.includes("--measured")
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

const orderFor = (mode: SweepMode): readonly Slot[] => {
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

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const refuse = (reason: string): void => {
  say(`refusing: ${reason}`);
  process.exitCode = EXIT_REFUSED;
};

/**
 * manifest.json as found: null only when ABSENT; its raw text when it does
 * not parse — so a corrupt manifest is refused, never silently overwritten.
 */
const readManifestFile = async (path: string): Promise<unknown> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

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

/** The files that made the A2.2 profile check unclean, one per line. */
const uncleanProfiles = (check: ProfileCheck): string =>
  check.files
    .filter((file) => file.present && (!file.readable || file.watched.length > 0))
    .map((file) => `${file.path}${file.readable ? `: ${file.watched.join(", ")}` : " (unreadable)"}`)
    .join("\n  ");

const printLiveControl = (only: AttemptFacts | undefined): void => {
  if (only === undefined) {
    return;
  }
  say(
    "\n--- live control facts ---\n" +
      `claude: ${only.claudeVersion}\n` +
      `model (init): ${only.model ?? "(none)"}\n` +
      `mcp servers: [${only.mcpServers.join(", ")}]\n` +
      `plugins: [${only.plugins.join(", ")}]\n` +
      `task success: ${only.outcome.taskSucceeded ? "yes" : "no"}\n` +
      `detector hits: ${only.outcome.hits.map((h) => h.id).join(",") || "none"}\n` +
      `cost usd: ${String(only.outcome.costUsd ?? "?")}\n` +
      `duration ms: ${String(only.outcome.durationMs ?? "?")}\n` +
      `dana lines in briefing:\n${danaBriefingLines(only.briefing)}`,
  );
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === null) {
    process.stdout.write(USAGE);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  const mode = args.mode;
  const reportMode: ReportMode = mode === "measured" ? "measured" : "dry-run";
  const order = orderFor(mode);
  const manifestFile = join(args.outDir, "manifest.json");
  await mkdir(args.outDir, { recursive: true });

  // The env claude runs with, as recorded: the allowlist, the run's pins, and
  // the PATH without entries inside this checkout (A1.5, A2.4).
  const runEnv = childEnv(process.env, {
    CROSSCHECK_HOME: "<per-run temp dir>",
    CROSSCHECK_TRIPWIRE: RUN_TRIPWIRE_MODE,
    PATH: pathWithout(process.env["PATH"] ?? "", worktreeRoot()),
  });
  // A2.2 residue: the Bash tool sources the user's shell profile, which the
  // env allowlist does not bound. Refuse to measure on a machine whose profile
  // sets a CROSSCHECK_/CLAUDE_/ANTHROPIC_ name; the check rides in the manifest.
  const shellProfileCheck = await checkShellProfiles(
    profilePaths(homedir(), process.env["ZDOTDIR"]),
  );
  if (!shellProfileCheck.clean) {
    refuse(
      `a shell profile sets a CROSSCHECK_/CLAUDE_/ANTHROPIC_ variable or cannot be read (A2.2):\n  ${uncleanProfiles(shellProfileCheck)}`,
    );
    return;
  }
  // The manifest THIS harness would write. A fresh dir gets it; a resume must
  // match it in mode, seed, order, HEAD and payload hash (H1, A2.5).
  const manifest = buildManifest({
    mode,
    order,
    ...(await harnessProvenance()),
    env: runEnv,
    shellProfileCheck,
    createdAt: new Date().toISOString(),
  });
  const decision = startDecision({
    resume: args.resume,
    stored: await readManifestFile(manifestFile),
    current: manifest,
  });
  if (decision.kind === "refuse") {
    refuse(`${manifestFile}: ${decision.reason}`);
    return;
  }
  if (decision.kind === "write") {
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  say(`AT-7 ${mode}: ${String(order.length)} slot(s); results in ${args.outDir}`);
  const sweep = await runSweep({
    order,
    outDir: args.outDir,
    workBase: tmpdir(),
    runAttempt: (input) => runAttempt(input),
    log: say,
  });
  if (sweep.aborted) {
    say(
      `\nABORTED: ${String(sweep.voidAttempts)} void attempts, more than the ${String(VOID_BUDGET)} allowed — harness trouble, the measurement is void (§7/A1.6). No verdict.`,
    );
    process.exitCode = EXIT_ABORTED;
  }
  if (sweep.pausedForUsageLimit) {
    say(
      "\nPAUSED: the account's usage limit cut an attempt (A4.3). It costs none of the five voids. " +
        "The measurement is incomplete — no verdict. Resume with --resume after the limit resets.",
    );
    process.exitCode = EXIT_PAUSED;
  }

  const report = buildReport(sweep.outcomes, { mode: reportMode });
  const text = renderReport(report);
  await writeFile(join(args.outDir, "report.txt"), `${text}\n`, "utf8");
  await writeFile(join(args.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  say(`\n${text}`);

  if (mode === "live-control") {
    printLiveControl(sweep.facts[0]);
  }
};

if (import.meta.main) {
  await main();
}
