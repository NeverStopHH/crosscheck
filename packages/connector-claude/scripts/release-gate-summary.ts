#!/usr/bin/env bun
/**
 * WHAT A RED RELEASE GATE SAYS, in the job that ran it (ci.yml `release-gate`,
 * simulation-nightly.yml `release-gate-loaded`): which case failed and on
 * which assertion, why in one line, and where the run's logs are kept.
 *
 *   bun run packages/connector-claude/scripts/release-gate-summary.ts \
 *     --log release-gate.log --run-url <url> --artifact <name> --summary "$GITHUB_STEP_SUMMARY"
 *
 * It reads the gate's console log — bun prints `(fail) <describe> > <test>`
 * for every failure, the assertion's `error:` line just before it, and, for a
 * test marked as an expected failure that PASSED, a line saying so — and
 * appends a summary to `--summary` (the job's summary page) and prints one
 * `::error::` annotation per failure (the job's header). A marked test that
 * passed is not a regression: its fix landed, and the summary says to remove
 * its line from release-gate/expected.ts.
 */
import { appendFile, readFile } from "node:fs/promises";

export interface GateFailure {
  /** The describe chain below the lane's own, outermost first: the case. */
  readonly case: string;
  readonly test: string;
  /** The test's id, the prefix of its name before ":" (release-gate/expected.ts keys). */
  readonly id: string;
  /** A marked expected failure that passed: its fix landed. */
  readonly isFixLanded: boolean;
  /** The assertion's `error:` line, when the log has one. */
  readonly error: string | null;
}

const FAIL_LINE = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;
const FIX_LANDED = "marked as failing but it passed";
const MAX_ERROR_CHARS = 200;

/** Every failure in a gate's console log, in the order bun printed them. */
export const failuresIn = (log: string): readonly GateFailure[] => {
  const lines = log.split("\n");
  const found: GateFailure[] = [];
  let lastError: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("error:")) {
      lastError = line.slice(0, MAX_ERROR_CHARS);
      continue;
    }
    if (line.startsWith("(pass)")) {
      lastError = null;
      continue;
    }
    const match = FAIL_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const path = (match[1] ?? "").split(" > ");
    const test = path.at(-1) ?? "";
    const isFixLanded = (lines[index + 1] ?? "").includes(FIX_LANDED);
    found.push({
      case: path.slice(1, -1).join(" > ") || (path[0] ?? ""),
      test,
      id: test.split(":")[0] ?? test,
      isFixLanded,
      error: isFixLanded ? null : lastError,
    });
    lastError = null;
  }
  return found;
};

/** The lines a case printed about itself (`P1 [production] …`, the burners), to read the failure by. */
export const caseLinesIn = (log: string): readonly string[] =>
  log.split("\n").filter((line) => /^P1 \[|: \d+ burners \(/.test(line));

export interface SummaryWhere {
  readonly runUrl: string;
  readonly artifact: string;
}

const failureLine = (failure: GateFailure): string =>
  failure.isFixLanded
    ? `- **${failure.case}** — \`${failure.test}\` PASSED although it is marked as an expected failure: its fix landed. Remove the \`${failure.id}\` line from \`release-gate/expected.ts\`.`
    : `- **${failure.case}** — \`${failure.test}\`${failure.error === null ? "" : `\n  \`${failure.error}\``}`;

/** The job summary, in Markdown. */
export const renderSummary = (failures: readonly GateFailure[], caseLines: readonly string[], where: SummaryWhere): string => {
  const head =
    failures.length === 0
      ? "The run ended without a failed case: it crashed or ran out of time before bun could report one. Read the log."
      : `${String(failures.length)} failed:`;
  return [
    "## Release gate: red",
    "",
    head,
    ...failures.map(failureLine),
    "",
    ...(caseLines.length === 0 ? [] : ["What the cases printed:", "```", ...caseLines, "```", ""]),
    `Logs: the console log is the artifact \`${where.artifact}\` of [this run](${where.runUrl}).`,
    "",
  ].join("\n");
};

/** One GitHub annotation per failure, for the job's header. */
export const annotationsFor = (failures: readonly GateFailure[]): readonly string[] =>
  failures.map((failure) =>
    failure.isFixLanded
      ? `::error title=Release gate: a fix landed::${failure.case} › ${failure.test} passed while marked as an expected failure — remove its line from release-gate/expected.ts`
      : `::error title=Release gate: ${failure.case}::${failure.test}${failure.error === null ? "" : ` — ${failure.error}`}`,
  );

const argOf = (args: readonly string[], name: string): string => {
  const at = args.indexOf(name);
  const value = at === -1 ? undefined : args[at + 1];
  if (value === undefined) {
    throw new Error(`release-gate-summary: missing ${name}`);
  }
  return value;
};

const main = async (args: readonly string[]): Promise<number> => {
  const log = await readFile(argOf(args, "--log"), "utf8").catch(() => "");
  const failures = failuresIn(log);
  const where = { runUrl: argOf(args, "--run-url"), artifact: argOf(args, "--artifact") };
  await appendFile(argOf(args, "--summary"), renderSummary(failures, caseLinesIn(log), where), "utf8");
  for (const annotation of annotationsFor(failures)) {
    console.log(annotation);
  }
  return 0;
};

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
