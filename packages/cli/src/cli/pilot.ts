/**
 * `crosscheck pilot [--days N] [--json]` — the five proofs (1.0 spec 07 §5).
 *
 * ONE COMMAND, NO DASHBOARD. One hub read, then one bounded `git diff` per
 * repaired pin on THIS clone, to stdout. Nothing is uploaded anywhere and
 * `--json` writes to the reader's own terminal (§8.5).
 *
 * THE DIFF RUNS HERE because the hub holds no repository and never runs git.
 * Proof 3 asks whether the fix touched what the attribution named, and only a
 * clone can answer that; a range this clone never fetched is printed as
 * unresolvable with the remedy, never as a miss.
 *
 * PER REPO, NEVER PER PERSON (§8.4). `--by-developer` is refused BY NAME
 * rather than being an unknown flag: this is reliability infrastructure, not
 * employee measurement, and a silent absence would invite someone to build
 * the breakdown the spec refuses.
 */
import {
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  PILOT_FIX_DIFF_CONCURRENCY,
} from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { scoreFix } from "@crosscheck/connector-core/git/fix-diff.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { getPilotReport } from "@crosscheck/connector-core/http/pilot.ts";
import type { PilotRepair } from "@crosscheck/connector-core/http/pilot.ts";

import { pilotFailureLine, pilotJson, renderPilot } from "./pilot-render.ts";
import type { ScoredFix } from "./pilot-render.ts";
import type { CliResult } from "./login.ts";

export const PILOT_FLAG_DAYS = "--days";
export const PILOT_FLAG_JSON = "--json";
export const PILOT_FLAG_BY_DEVELOPER = "--by-developer";

export const PILOT_USAGE = [
  "usage: crosscheck pilot [--days N] [--json]",
  "",
  "  The five proofs for this repo, each measured or saying why not:",
  "  duplicate work surfaced, collisions flagged before merge, attribution",
  "  accuracy, proactive precision and coverage integrity. One hub read,",
  "  then one bounded `git diff` per repaired pin, run on this clone.",
  "",
  "  --days N   the window, in whole days (the hub's default when omitted)",
  "  --json     the same answer as data, every string cleaned",
  "",
  "  Per repo, never per person: there is no breakdown by developer.",
  "",
].join("\n");

const NOT_CONFIGURED = "not configured — run `crosscheck login <hubUrl>`\n";
const NOT_A_REPO = "not a git repository — the pilot is repo-scoped\n";

const BY_DEVELOPER_REFUSAL =
  "refused: the pilot counts per repo, never per person — this is reliability infrastructure, not employee measurement, so there is no breakdown by developer to ask for\n";

const WHOLE_DAYS = /^[1-9]\d*$/;

type PilotArgs =
  | { readonly days: number | undefined; readonly json: boolean }
  | { readonly error: string };

const parsePilotArgs = (argv: readonly string[]): PilotArgs => {
  const at = argv.indexOf(PILOT_FLAG_DAYS);
  const json = argv.includes(PILOT_FLAG_JSON);
  if (at === -1) {
    return { days: undefined, json };
  }
  const raw = argv[at + 1];
  if (raw === undefined || !WHOLE_DAYS.test(raw)) {
    return { error: `${PILOT_FLAG_DAYS} takes a whole number of days` };
  }
  return { days: Number(raw), json };
};

/**
 * Every repair's fix diff, PILOT_FIX_DIFF_CONCURRENCY at a time: one after
 * another the report's bound of twenty-five would keep somebody waiting half
 * a minute in the worst case.
 */
const scoreFixes = async (
  repoRoot: string,
  repairs: readonly PilotRepair[],
): Promise<readonly ScoredFix[]> => {
  let scored: readonly ScoredFix[] = [];
  for (let start = 0; start < repairs.length; start += PILOT_FIX_DIFF_CONCURRENCY) {
    const batch = repairs.slice(start, start + PILOT_FIX_DIFF_CONCURRENCY);
    const outcomes = await Promise.all(
      batch.map((repair) => scoreFix(repoRoot, repair)),
    );
    scored = [
      ...scored,
      ...batch.map((repair, index) => ({
        repair,
        outcome: outcomes[index] ?? "unresolvable",
      })),
    ];
  }
  return scored;
};

export const runPilot = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  if (argv.includes(PILOT_FLAG_BY_DEVELOPER)) {
    return { stdout: BY_DEVELOPER_REFUSAL, exitCode: EXIT_USAGE };
  }
  const args = parsePilotArgs(argv);
  if ("error" in args) {
    return { stdout: `${args.error}\n${PILOT_USAGE}`, exitCode: EXIT_USAGE };
  }
  const identity = await resolveRepoIdentity(cwd);
  const config = await loadConfig({ env, repoRoot: identity?.root });
  if (config === null) {
    return { stdout: NOT_CONFIGURED, exitCode: EXIT_OK };
  }
  if (identity === null) {
    return { stdout: NOT_A_REPO, exitCode: EXIT_USAGE };
  }
  const result = await getPilotReport(
    {
      hubUrl: config.hubUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      home: config.home,
      repoKey: repoKey(config.hubUrl, identity.repoId),
      now: () => new Date(),
    },
    args.days === undefined
      ? { repo: identity.repoId }
      : { repo: identity.repoId, days: args.days },
  );
  if (!result.ok) {
    return {
      stdout: pilotFailureLine(result.kind, result.message),
      exitCode: result.kind === "network" ? EXIT_UNREACHABLE : EXIT_FAIL,
    };
  }
  const view = {
    report: result.data,
    fixes: await scoreFixes(identity.root, result.data.attribution.repaired),
  };
  return {
    stdout: args.json ? pilotJson(view) : renderPilot(view),
    exitCode: EXIT_OK,
  };
};
