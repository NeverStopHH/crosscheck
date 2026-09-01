/**
 * IS THERE A MODEL ON THIS MACHINE AT ALL — one definition, read by every
 * surface that depends on the answer.
 *
 * WHY THIS FILE EXISTS. Every derive rung on every connector ends in the same
 * place: `resolveSummarizerArgv(env)` spawned as a child process. That argv is
 * `CROSSCHECK_SUMMARIZER_CMD` when it is set, and otherwise `claude -p ...`.
 * So on a machine with neither, NOTHING derives — not the summarizer, not the
 * session intent, not the ghost check, not the conference — no matter how
 * complete the hook install is or how many capabilities a connector declares.
 *
 * That state used to be reported by exactly one surface, the Claude
 * connector's runner probe, which called it "skipped" and said a Cursor- or
 * ACP-only machine could ignore it. That sentence was true while only Claude
 * could derive. It is false now, and it was false on precisely the machine
 * this parity work exists for: a Cursor install with no Claude Code, whose
 * four rung lines all print PASS while nothing is ever inferred.
 *
 * The fix is not a cleverer probe, it is a SHARED FACT: resolve it once, and
 * let each connector's doctor section say it in its own section, so "my host
 * declares four rungs" and "my host can run a model" are never one line.
 */
import type { Env } from "../config/paths.ts";

/**
 * The binary the default backend spawns. Kept beside the check so the test
 * and the sentence cannot drift from each other.
 */
export const DEFAULT_BACKEND_BINARY = "claude";

/** The variable that replaces the binary wholesale (docs/FOREIGN-MODELS.md). */
export const BACKEND_OVERRIDE_VAR = "CROSSCHECK_SUMMARIZER_CMD";

/**
 * What this machine would spawn if a rung fired right now.
 *
 * `absent` is the load-bearing member: it is not an error and not a
 * misconfiguration — a Cursor-only machine is a perfectly ordinary install —
 * but it IS the fact that decides whether any derived line ever appears.
 */
export type DeriveBackend =
  | { readonly kind: "override"; readonly command: string }
  | { readonly kind: "default" }
  | { readonly kind: "absent" };

/**
 * Resolved from the SAME inputs `resolveSummarizerArgv` uses, in the same
 * order, so this can never claim a backend the spawn would not find.
 *
 * The override is tested for non-empty exactly the way the resolver tests it:
 * an exported-but-empty variable is an unset variable, not a broken backend,
 * and calling it one would send a reader hunting a wrapper they never wrote.
 *
 * VERIFY: bun -e 'const {resolveDeriveBackend:r}=await import("./packages/connector-core/src/model/backend.ts");console.log(r({PATH:"/nonexistent"}).kind, r({PATH:"/nonexistent",CROSSCHECK_SUMMARIZER_CMD:""}).kind, r({PATH:"/nonexistent",CROSSCHECK_SUMMARIZER_CMD:"/x/y"}).kind, r({}).kind)'
 * PRINTS: absent absent override absent
 */
export const resolveDeriveBackend = (env: Env): DeriveBackend => {
  const override = env[BACKEND_OVERRIDE_VAR];
  if (override !== undefined && override.length > 0) {
    return { kind: "override", command: override };
  }
  return Bun.which(DEFAULT_BACKEND_BINARY, { PATH: env["PATH"] ?? "" }) === null
    ? { kind: "absent" }
    : { kind: "default" };
};

/**
 * The doctor sentence for a resolved backend, in crosscheck's own words.
 *
 * The absent sentence is the one that had to be written carefully, and it
 * carries three things a reader needs and no more: that nothing derives, that
 * this is about the MODEL and not about capture (a reader who concludes
 * crosscheck is dead will uninstall it), and where the remedy is written
 * down. It names no roadmap and blames no platform — a machine without a
 * model binary is a deployment fact, not a fault.
 */
export const deriveBackendSentence = (backend: DeriveBackend): string => {
  switch (backend.kind) {
    case "override":
      return `${BACKEND_OVERRIDE_VAR} is set, so derived lines come from ${backend.command} (docs/FOREIGN-MODELS.md)`;
    case "default":
      return `the default backend: ${DEFAULT_BACKEND_BINARY} on PATH`;
    case "absent":
      return `no model backend: ${DEFAULT_BACKEND_BINARY} is not on the PATH doctor runs with and ${BACKEND_OVERRIDE_VAR} is unset, so nothing on this machine can derive anything (docs/FOREIGN-MODELS.md) — deterministic capture is unaffected`;
  }
};
