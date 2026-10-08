/**
 * Sweeps the spool simulation (test/spool-simulation.test.ts) wide: every
 * generator over a seed range, one `bun test` per generator, a summary at the
 * end, and exit 1 when any generator found a seed no documented residual
 * explains.
 *
 * PR CI runs 300 seeds of `shipped` with the rest of the suite. This is what
 * runs wider: the nightly workflow (.github/workflows/simulation-nightly.yml),
 * one generator per job, and the release-candidate sweep before a release
 * (docs/1.0/loss-accounting.md, "The simulation as a standing method").
 *
 *   bun run packages/connector-core/scripts/sim-sweep.ts                  # every generator, 2000 seeds each
 *   ... --generators io,focus --seeds 500 --base 4001                     # a slice
 *   ... --rc                                                              # release candidate: 5000 seeds each
 *   ... --report sim-report                                               # each generator's <name>.json there
 *
 * Each report holds the generator's failing seeds, the shrunk events and
 * trace of the first few (`reports`: a shrunk trace is a corpus entry's
 * `events` as is, simulation/seed-corpus.ts), its residuals and its
 * over-count. Under GitHub Actions the summary is also written to the job's
 * step summary.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Every generator the simulation has (test/simulation/sim-world.ts GENERATORS; pinned by spool-simulation.test.ts). */
export const SWEEP_GENERATORS = ["shipped", "io", "sleep", "focus", "all"] as const;

/** Seeds per generator a sweep runs when it is not told: the nightly's. */
const NIGHTLY_SEEDS = 2000;
/** Seeds per generator of the release-candidate sweep. */
const RC_SEEDS = 5000;
const PACKAGE_DIR = resolve(import.meta.dir, "..");

interface SweepOptions {
  readonly generators: readonly string[];
  readonly seeds: number;
  readonly base: number;
  readonly reportDir: string | null;
}

interface SweepReport {
  readonly seeds?: number;
  readonly durationMs?: number;
  readonly failing?: readonly string[];
  readonly residual?: readonly string[];
  readonly overCount?: { readonly seeds: number; readonly records: number };
}

interface SweepResult {
  readonly generator: string;
  readonly exitCode: number;
  readonly report: SweepReport | null;
}

const valueOf = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

const positive = (raw: string | undefined, fallback: number, flag: string): number => {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} takes a positive whole number, not ${raw}`);
  }
  return value;
};

export const parseSweepArgs = (args: readonly string[]): SweepOptions => {
  const isRc = args.includes("--rc");
  const generators = (valueOf(args, "--generators") ?? SWEEP_GENERATORS.join(",")).split(",").filter((name) => name !== "");
  const unknown = generators.filter((name) => !(SWEEP_GENERATORS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(`--generators names no generator: ${unknown.join(", ")} (${SWEEP_GENERATORS.join(", ")})`);
  }
  const report = valueOf(args, "--report");
  return {
    generators,
    seeds: positive(valueOf(args, "--seeds"), isRc ? RC_SEEDS : NIGHTLY_SEEDS, "--seeds"),
    base: positive(valueOf(args, "--base"), 1, "--base"),
    reportDir: report === undefined ? null : resolve(report),
  };
};

const readReport = async (reportDir: string | null, generator: string): Promise<SweepReport | null> => {
  if (reportDir === null) {
    return null;
  }
  try {
    return JSON.parse(await readFile(resolve(reportDir, `${generator}.json`), "utf8")) as SweepReport;
  } catch {
    return null;
  }
};

const sweepOne = async (options: SweepOptions, generator: string): Promise<SweepResult> => {
  console.log(`[sim-sweep] ${generator}: ${String(options.seeds)} seeds from ${String(options.base)}`);
  const proc = Bun.spawn({
    cmd: [process.execPath, "test", "test/spool-simulation.test.ts", "-t", "seeded scenarios"],
    cwd: PACKAGE_DIR,
    env: {
      ...process.env,
      SIM_ADD: generator,
      SIM_SEEDS: String(options.seeds),
      SIM_SEED_BASE: String(options.base),
      ...(options.reportDir === null ? {} : { SIM_REPORT_DIR: options.reportDir }),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  return { generator, exitCode, report: await readReport(options.reportDir, generator) };
};

const summaryRow = (options: SweepOptions, result: SweepResult): string => {
  const report = result.report;
  const failing = report?.failing ?? [];
  const verdict = result.exitCode === 0 ? "pass" : failing.length > 0 ? "FAIL" : `FAIL (exit ${String(result.exitCode)})`;
  return `| ${result.generator} | ${String(report?.seeds ?? options.seeds)} | ${String(options.base)} | ${verdict} | ${failing.join(" ") || "-"} | ${(report?.residual ?? []).join(" ") || "-"} | ${String(report?.overCount?.records ?? "?")} | ${report?.durationMs === undefined ? "?" : `${String(Math.round(report.durationMs / 1000))} s`} |`;
};

const summaryOf = (options: SweepOptions, results: readonly SweepResult[]): string =>
  [
    "| generator | seeds | from | result | failing seeds | residual | over-count | time |",
    "|---|---|---|---|---|---|---|---|",
    ...results.map((result) => summaryRow(options, result)),
  ].join("\n");

const main = async (): Promise<number> => {
  const options = parseSweepArgs(process.argv.slice(2));
  if (options.reportDir !== null) {
    await mkdir(options.reportDir, { recursive: true });
  }
  const results: SweepResult[] = [];
  for (const generator of options.generators) {
    results.push(await sweepOne(options, generator));
  }
  const summary = summaryOf(options, results);
  console.log(`\n${summary}`);
  const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (stepSummary !== undefined && stepSummary !== "") {
    await appendFile(stepSummary, `### Spool simulation sweep\n\n${summary}\n`);
  }
  return results.every((result) => result.exitCode === 0) ? 0 : 1;
};

if (import.meta.main) {
  process.exit(await main());
}
