/**
 * `crosscheck pilot --mine [--days N]` — the caller's own hint outcomes (1.0
 * spec 07 §13): how often crosscheck helped, from whose work, and how often a
 * hint was taken and still set aside, with the reasons.
 *
 * ONE HUB READ, keyed by the caller's own key. The hub takes no parameter that
 * names a person, so this command cannot be pointed at somebody else, and
 * `--by-developer` is refused here by name exactly as the team report refuses
 * it: the one view of a person this product offers is the person's own.
 */
import { EXIT_FAIL, EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { getMyHintOutcomes, isOutcomesNotServed } from "@crosscheck/connector-core/http/hint-outcomes.ts";

import {
  BY_DEVELOPER_REFUSAL,
  PILOT_FLAG_BY_DEVELOPER,
  PILOT_FLAG_JSON,
  PILOT_FLAG_MINE,
  PILOT_USAGE,
  parsePilotArgs,
} from "./pilot.ts";
import { MINE_JSON_REFUSAL, MINE_NOT_SERVED_LINE, renderMyOutcomes } from "./pilot-mine-render.ts";
import { pilotFailureLine } from "./pilot-render.ts";
import type { CliResult } from "./login.ts";

const NOT_CONFIGURED = "not configured — run `crosscheck login <hubUrl>`\n";
const NOT_A_REPO = "not a git repository — outcomes are repo-scoped\n";

export const runPilotMine = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  if (argv.includes(PILOT_FLAG_BY_DEVELOPER)) {
    return { stdout: BY_DEVELOPER_REFUSAL, exitCode: EXIT_USAGE };
  }
  if (argv.includes(PILOT_FLAG_JSON)) {
    return { stdout: MINE_JSON_REFUSAL, exitCode: EXIT_USAGE };
  }
  const args = parsePilotArgs(argv.filter((token) => token !== PILOT_FLAG_MINE));
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
  const result = await getMyHintOutcomes(
    {
      hubUrl: config.hubUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      home: config.home,
      repoKey: repoKey(config.hubUrl, identity.repoId),
      now: () => new Date(),
    },
    args.days === undefined ? { repo: identity.repoId } : { repo: identity.repoId, days: args.days },
  );
  if (isOutcomesNotServed(result)) {
    return { stdout: MINE_NOT_SERVED_LINE, exitCode: EXIT_FAIL };
  }
  if (!result.ok) {
    return {
      stdout: pilotFailureLine(result.kind, result.message),
      exitCode: result.kind === "network" ? EXIT_UNREACHABLE : EXIT_FAIL,
    };
  }
  return { stdout: renderMyOutcomes(result.data), exitCode: EXIT_OK };
};
