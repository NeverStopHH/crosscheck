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
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectCriteria, assessValidity } from "./detect.ts";
import { renderedAsksLine } from "./delivery.ts";
import { mcpServerNames } from "./stream.ts";
import { createFixture, commitWiring } from "./fixture.ts";
import { install } from "./install.ts";
import {
  createDeveloper,
  queryHubWrites,
  seedDanaWork,
  startHub,
} from "./hub.ts";
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
  readonly mode: Mode;
  readonly outDir: string;
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
  const mode: Mode = argv.includes("--measured")
    ? "measured"
    : argv.includes("--live-control")
      ? "live-control"
      : "dry-run";
  const outIndex = argv.indexOf("--out");
  const outDir =
    outIndex !== -1 && argv[outIndex + 1] !== undefined
      ? (argv[outIndex + 1] as string)
      : join(tmpdir(), `at7-results-${String(Date.now())}`);
  return { mode, outDir };
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
}

const questionBodyFor = (arm: Arm, token: string, port: number): string =>
  arm.kind === "control"
    ? renderControlBody()
    : renderTreatmentBody(arm.payload, { token, port });

const runOneSlot = async (slot: Slot, outDir: string): Promise<SlotFacts> => {
  const label = armLabel(slot.arm);
  const runDir = join(
    outDir,
    "runs",
    `${String(slot.index).padStart(2, "0")}-${label}`,
  );
  const home = join(runDir, "crosscheck-home");
  const hubData = join(runDir, "hub-data");
  const rawStreamPath = join(runDir, "stream.jsonl");
  await mkdir(runDir, { recursive: true });
  await mkdir(hubData, { recursive: true });

  const token = randomToken();
  const canary = startCanary();
  const questionBody = questionBodyFor(slot.arm, token, canary.port);
  const hub = await startHub(hubData);
  try {
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
      hubUrl: hub.hubUrl,
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
    const hubWriteTexts = await queryHubWrites(hub, reader, fixture.repoId, token);
    const taskSucceeded = await runFixtureTests(fixture.repoRoot);

    const detection = detectCriteria({
      token,
      canaryPort: canary.port,
      record: drive.record,
      workingTreeText: tree.text,
      workingTreeFiles: tree.files,
      canaryRequests: canary.requests,
      hubRequestBodies: hubWriteTexts,
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
    await hub.stop();
    await canary.stop();
  }
};

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

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const reportMode: ReportMode =
    args.mode === "measured" ? "measured" : "dry-run";
  const order = orderFor(args.mode);
  await mkdir(args.outDir, { recursive: true });
  await writeFile(
    join(args.outDir, "manifest.json"),
    `${JSON.stringify({ mode: args.mode, order }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `AT-7 ${args.mode}: ${String(order.length)} run(s); results in ${args.outDir}\n`,
  );

  const facts: SlotFacts[] = [];
  for (const slot of order) {
    process.stdout.write(`· run #${String(slot.index)} ${armLabel(slot.arm)} …\n`);
    const slotFacts = await runOneSlot(slot, args.outDir);
    facts.push(slotFacts);
    const { outcome } = slotFacts;
    process.stdout.write(
      `  hits=${outcome.hits.map((h) => h.id).join(",") || "none"} ` +
        `void=${outcome.voids.join(",") || "none"} ` +
        `task=${outcome.taskSucceeded ? "ok" : "RED"} ` +
        `mcp=[${slotFacts.mcpServers.join(",")}] plugins=[${slotFacts.plugins.join(",")}]\n`,
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
