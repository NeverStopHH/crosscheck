/**
 * `crosscheck suspect <pin-id | path…>` — the post-hoc lookup (Stage 1).
 *
 * The whole feature in one sentence: a surface somebody declared working
 * stopped working, and the hub is the only place that knows which sessions —
 * across every person and every connector — recorded touching its files.
 * Sentry's suspect commits, with work contexts instead of stack frames.
 *
 * IT CANNOT BE NOISY. It runs when a person types it. There is no hook, no
 * budget and no injection, which is also why it behaves identically for
 * Claude Code, Cursor and ACP sessions.
 */
import { EXIT_FAIL, EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { getSuspect } from "@crosscheck/connector-core/http/hub.ts";
import { SAFE_ID_PATTERN } from "@crosscheck/schema";
import { renderSuspect } from "./suspect-render.ts";
import type { CliResult } from "./login.ts";

export const SUSPECT_USAGE = [
  "usage: crosscheck suspect <pin-id>",
  "   or: crosscheck suspect <path> [<path>…]",
  "",
  "  Answers who was in there: the sessions whose recorded work touched this",
  "  surface in the last two weeks, ranked by how concentrated their work was",
  "  on it rather than by how much they commit.",
  "",
  "  It names SESSIONS and what they said they were doing, never people —",
  "  open the work context it prints to see whose it is. With a pin, nothing",
  "  is named until somebody has run the pin's check and recorded it failing.",
  "",
].join("\n");

const NOT_CONFIGURED = "not configured — run `crosscheck login <hubUrl>`\n";
const NOT_A_REPO = "not a git repository — suspect is repo-scoped\n";

/** A pin id, as `crosscheck pin` mints them; anything else is a path. */
const PIN_ID_PREFIX = "pin_";

const looksLikePinId = (term: string): boolean =>
  term.startsWith(PIN_ID_PREFIX) && SAFE_ID_PATTERN.test(term);

export const runSuspect = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  const terms = argv.filter((term) => !term.startsWith("--"));
  if (terms.length === 0) {
    return { stdout: SUSPECT_USAGE, exitCode: EXIT_USAGE };
  }
  const identity = await resolveRepoIdentity(cwd);
  const config = await loadConfig({ env, repoRoot: identity?.root });
  if (config === null) {
    return { stdout: NOT_CONFIGURED, exitCode: EXIT_OK };
  }
  if (identity === null) {
    return { stdout: NOT_A_REPO, exitCode: EXIT_USAGE };
  }
  const first = terms[0] as string;
  const request = looksLikePinId(first)
    ? { repo: identity.repoId, pinId: first }
    : { repo: identity.repoId, paths: terms };
  const view = await getSuspect(
    {
      hubUrl: config.hubUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      home: config.home,
      repoKey: repoKey(config.hubUrl, identity.repoId),
      now: () => new Date(),
    },
    request,
  );
  if (!view.ok) {
    // THREE outcomes, never two: a hub that could not answer must never look
    // like a hub that answered "nobody".
    return view.kind === "network"
      ? {
          stdout: `hub unreachable: ${view.message} — who touched this surface is UNKNOWN, not "nobody"\n`,
          exitCode: EXIT_UNREACHABLE,
        }
      : { stdout: `${view.message}\n`, exitCode: EXIT_FAIL };
  }
  return { stdout: renderSuspect(view.data, new Date()), exitCode: EXIT_OK };
};
