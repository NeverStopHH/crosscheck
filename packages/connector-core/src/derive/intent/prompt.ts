/**
 * What the derived-intent worker asks the model, and how it spawns it —
 * the summarizer runner's argv shape (runner.ts) with a different prompt:
 * the same headless `claude -p` on the Haiku-class model, the same lean
 * flags (a model call, not a session), the same CROSSCHECK_SUMMARIZER_CMD
 * override that replaces the binary WHOLESALE for tests and operators (the
 * first prompt arrives on stdin, the sentence comes back on stdout).
 */
import {
  SUMMARIZER_LEAN_FLAGS,
} from "../../model/runner.ts";
import { INTENT_MAX_CHARS, SUMMARIZER_MODEL } from "../../constants.ts";
import type { Env } from "../../config/paths.ts";

/**
 * One sentence or NONE. Third person, bounded, and explicitly NOT the prompt
 * — the model is told to state what the session is trying to accomplish, so
 * a pasted stack trace or a question comes back as a task description. The
 * worker still bounds, scans and parses whatever comes back (intent/worker.ts).
 *
 * THE BOUND IS THE RENDER CAP, not the storage cap, and it is interpolated
 * rather than typed so the two cannot drift. INTENT_MAX_CHARS (120) is what
 * every surface can show; MAX_INTENT_SUMMARY_CHARS (200) is only what the
 * hub will store, and a DECLARED sentence may legitimately use it. Asking
 * the model for anything above the render cap guarantees an ellipsis on a
 * sentence it was told to keep short — the one thing a one-line intent
 * cannot afford. Pinned by test/intent-worker.test.ts.
 *
 * VERIFY: bun -e 'const p=await import("./packages/connector-core/src/derive/intent/prompt.ts");const c=await import("./packages/connector-core/src/constants.ts");console.log(p.INTENT_PROMPT.includes(`at most ${c.INTENT_MAX_CHARS} characters`))'
 * PRINTS: true
 */
export const INTENT_PROMPT =
  "Below is the first prompt of one coding session. Answer with ONE sentence of " +
  `at most ${String(INTENT_MAX_CHARS)} characters, in the third person, stating what this coding session ` +
  "is trying to accomplish — for example \"Fix the refresh 500s after the key " +
  "rotation\" — or exactly NONE if the prompt is not about a task. Never repeat " +
  "the prompt, never quote it, no preamble, no markdown.";

/** The override wins wholesale; else headless claude with the lean flags. */
export const resolveIntentArgv = (env: Env): readonly string[] => {
  const override = env["CROSSCHECK_SUMMARIZER_CMD"];
  if (override !== undefined && override.length > 0) {
    return [override];
  }
  return ["claude", "-p", INTENT_PROMPT, "--model", SUMMARIZER_MODEL, ...SUMMARIZER_LEAN_FLAGS];
};
