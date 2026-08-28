/**
 * ONE DOOR FROM A TRIGGER TO A DETACHED DERIVE WORKER — the spawn shape every
 * connector's trigger uses, and the one place the worker's environment is
 * finished.
 *
 * It exists because of a bug that was live in this tree until this file was:
 * the workers stamp the record's producer with
 * `env["CROSSCHECK_AGENT_KIND"] ?? DEFAULT_AGENT_KIND`, session state carries
 * no agentKind, and DEFAULT_AGENT_KIND is `claude-code`. That was invisible
 * while only the Claude connector could spawn a worker — the default was the
 * truth — and becomes a WRONG ATTRIBUTION the moment Cursor spawns the same
 * worker: Ken's derived intent would arrive on the hub as a Claude Code
 * session's. A hook process's own environment does not carry the variable
 * (nothing sets it), so "the worker will figure it out" was never an option;
 * the trigger is the only place that knows.
 *
 * So `agentKind` is a REQUIRED argument here, not an optional one. An optional
 * parameter is a thing a trigger can forget, and this is exactly the class of
 * mistake that fails silently: the draft still lands, it is just filed under
 * the wrong host. `summarizerWorkerEnv` stays as it was for the doctor PROBE,
 * which writes no record and has no session to attribute.
 *
 * The spawn itself is the Stop hook's shape, byte for byte and now shared:
 * the child is unref'd, its stdio ignored, and a spawn failure swallowed —
 * the fire is already booked and losing one worker is the cheap outcome (fail
 * open).
 *
 * VERIFY: bun -e 'const {deriveWorkerEnv} = await import("./packages/connector-core/src/derive/spawn.ts"); const e = deriveWorkerEnv({CROSSCHECK_AGENT_KIND: "claude-code", CLAUDECODE: "1", PATH: "/bin"}, "/tmp/h", "cursor"); console.log(e["CROSSCHECK_AGENT_KIND"], e["CROSSCHECK_HOME"], e["CLAUDECODE"] === undefined, e["PATH"])'
 * PRINTS: cursor /tmp/h true /bin
 */
import type { Env } from "../config/paths.ts";
import { summarizerWorkerEnv } from "../model/worker-env.ts";

/**
 * The worker's environment: the shared pass-through-minus-markers
 * (model/worker-env.ts states why a denylist and not an allowlist), with the
 * spawning connector's OWN agent kind stamped last so it outranks whatever
 * the trigger process happened to inherit.
 *
 * Stamped last on purpose. `ctx.config.agentKind` is already
 * `CROSSCHECK_AGENT_KIND ?? <configured> ?? claude-code` (config/config.ts),
 * so an operator override still wins — it has simply been resolved once, by
 * the process that can see the repo's config, instead of being re-derived by
 * a detached child with a different environment.
 */
export const deriveWorkerEnv = (
  env: Env,
  home: string,
  agentKind: string,
): Record<string, string> => ({
  ...summarizerWorkerEnv(env, home),
  CROSSCHECK_AGENT_KIND: agentKind,
});

export interface DeriveSpawnInput {
  readonly env: Env;
  readonly home: string;
  /** The SPAWNING connector's kind — see the header for why it is required. */
  readonly agentKind: string;
  /** argv, entry path included; the caller owns which worker it is. */
  readonly cmd: readonly string[];
}

/**
 * Fire-and-forget. Returns nothing on purpose: a trigger that branched on
 * whether the spawn succeeded would be waiting on the model by another name.
 */
export const spawnDeriveWorker = (input: DeriveSpawnInput): void => {
  try {
    const proc = Bun.spawn({
      cmd: [...input.cmd],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: deriveWorkerEnv(input.env, input.home, input.agentKind),
    });
    proc.unref();
  } catch {
    // Fail open — the fire slot is spent, the work is lost, nothing breaks.
  }
};
