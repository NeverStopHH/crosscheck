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
} from "../summarizer/runner.ts";
import { SUMMARIZER_MODEL } from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";

/**
 * One sentence or NONE. Third person, bounded, and explicitly NOT the prompt
 * — the model is told to state what the session is trying to accomplish, so
 * a pasted stack trace or a question comes back as a task description. The
 * worker still bounds, scans and parses whatever comes back (intent/worker.ts).
 */
export const INTENT_PROMPT =
  "Below is the first prompt of one coding session. Answer with ONE sentence of " +
  "at most 160 characters, in the third person, stating what this coding session " +
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
