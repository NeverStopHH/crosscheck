/**
 * The environment the detached Tier-1 worker — and through it the nested
 * `claude -p` — inherits from the Stop hook (trial finding #14).
 *
 * PASS-THROUGH MINUS A DENYLIST, not an allowlist. The first cut forwarded
 * exactly PATH, HOME and the CROSSCHECK_* knobs, and on a Mac logged in
 * through the keychain (`security` item "Claude Code-credentials", no
 * ~/.claude/.credentials.json, no ANTHROPIC_* env) every nested `claude -p`
 * answered "Not logged in · Please run /login", exit 1: the keychain lookup
 * keys on $USER, which the allowlist had dropped. Bisected one variable at a
 * time on top of PATH+HOME — USER alone flipped it to NONE exit 0; TMPDIR,
 * LOGNAME and SHELL did not. An allowlist can only ever chase the next
 * missing variable (API-key users lose ANTHROPIC_API_KEY, Bedrock users
 * CLAUDE_CODE_USE_BEDROCK and AWS_*, corp proxies HTTPS_PROXY and
 * NODE_EXTRA_CA_CERTS, …), so the worker now gets the hook's whole
 * environment minus the markers that would bind the nested claude to the
 * session that spawned it. Tests fake the binary through
 * CROSSCHECK_SUMMARIZER_CMD, so forwarding the test runner's environment
 * there is harmless — the old comment's worry, re-examined.
 */
import {
  SUMMARIZER_CHILD_ENV,
  SUMMARIZER_CHILD_ON,
} from "@crosscheck/connector-core/constants.ts";
import {
  ensureDir,
  summarizerCwdPath,
} from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";

/**
 * The neutral directory the nested claude runs FROM (core paths.ts
 * summarizerCwdPath says why the repo root is the wrong place): created
 * 0700 on first use, shared by the worker and by doctor's probe so both
 * spawn from the same place. Creation failing is fail-open like everything
 * here — undefined lets the child inherit the caller's cwd, which is what
 * every fire did before this existed.
 */
export const ensureSummarizerCwd = async (
  home: string,
): Promise<string | undefined> => {
  const path = summarizerCwdPath(home);
  try {
    await ensureDir(path);
    return path;
  } catch {
    return undefined;
  }
};

/**
 * The PARENT Claude Code session's own markers — the variables a hook
 * process carries that say "you are inside session X, speak to it over this
 * socket, you are plugin Y's subprocess". A nested claude that inherited
 * them could be mistaken for, or bind to, the session it is summarizing.
 * Nothing auth-shaped is in here: CLAUDE_CODE_OAUTH_TOKEN,
 * CLAUDE_CODE_USE_BEDROCK/VERTEX, CLAUDE_CONFIG_DIR and every ANTHROPIC_*
 * variable pass through, because they are how the nested claude logs in.
 *
 * WIDENED past the nine names the first cut stripped, after a real 2.1.237
 * hook/agent env was found to carry CLAUDE_PID and CLAUDE_CODE_CHILD_SESSION
 * past them, and `strings claude.exe | grep -oE 'CLAUDE(_CODE)?_[A-Z0-9_]+'`
 * showed the other session-binding names the binary reads: the task-list
 * id, the IDE SSE port (an auto-connect in an IDE terminal), the
 * remote/bridge session ids, resume-from-session, the session access token
 * (CLAUDE_CODE_SESSION_* as a family). CLAUDE_CODE_EXECPATH, CLAUDE_EFFORT
 * and the CLAUDE_CODE_ENABLE_* knobs are NOT session binding and pass
 * through — a denylist that swept CLAUDE_ wholesale would take the auth
 * names with it.
 *
 * VERIFY: bun -e 'const {PARENT_SESSION_MARKER_PATTERN: p} = await import("./packages/connector-claude/src/summarizer/worker-env.ts"); console.log(["CLAUDECODE","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_ENTRYPOINT","CLAUDE_CODE_MESSAGING_SOCKET","CLAUDE_CODE_MESSAGING_TOKEN","CLAUDE_PLUGIN_ROOT","CLAUDE_PLUGIN_DATA","CLAUDE_PROJECT_DIR","CLAUDE_AGENT_SDK_VERSION","CLAUDE_PID","CLAUDE_CODE_CHILD_SESSION","CLAUDE_CODE_SESSION_ACCESS_TOKEN","CLAUDE_CODE_TASK_LIST_ID","CLAUDE_CODE_SSE_PORT","CLAUDE_CODE_REMOTE_SESSION_ID","CLAUDE_CODE_RESUME_FROM_SESSION","CLAUDE_CODE_BRIDGE_SESSION_ID"].filter((n) => p.test(n)).length, ["USER","HOME","PATH","ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN","CLAUDE_CODE_USE_BEDROCK","CLAUDE_CONFIG_DIR","AWS_PROFILE","HTTPS_PROXY","CLAUDE_CODE_EXECPATH","CLAUDE_EFFORT"].filter((n) => p.test(n)).length)'
 * PRINTS: 17 0
 */
export const PARENT_SESSION_MARKER_PATTERN =
  /^CLAUDECODE$|^CLAUDE_PID$|^CLAUDE_CODE_(SESSION_|CHILD_SESSION$|ENTRYPOINT$|MESSAGING_|TASK_LIST_ID$|SSE_PORT$|REMOTE|RESUME_FROM_SESSION$|BRIDGE_)|^CLAUDE_PLUGIN_|^CLAUDE_PROJECT_DIR$|^CLAUDE_AGENT_SDK_/;

/**
 * The worker's environment: everything the hook was invoked with except the
 * parent-session markers, plus the two values the worker must always see —
 * where the crosscheck home is, and the child marker that makes every
 * crosscheck hook entry inside the nested claude exit silently
 * (config/config.ts isSummarizerChild). Undefined values are dropped, so the
 * result is spawnable as-is.
 */
export const summarizerWorkerEnv = (
  env: Env,
  home: string,
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value === undefined || PARENT_SESSION_MARKER_PATTERN.test(name)
        ? []
        : [[name, value]],
    ),
  ),
  CROSSCHECK_HOME: home,
  [SUMMARIZER_CHILD_ENV]: SUMMARIZER_CHILD_ON,
});
