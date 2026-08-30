import { z } from "zod";

/**
 * The failure-TEXT derivation moved to core (capture/failure-text.ts): it
 * feeds `fingerprint()`, the cross-agent match signal, so the ACP connector
 * must join on the SAME spelling. Re-exported here reference-identically —
 * existing importers keep working, and there is still exactly one
 * implementation.
 */
export { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";

/**
 * Hook payloads come from a tool we do not version-control. Unknown fields are
 * ignored, wrong-typed optional fields fall back to undefined, and only
 * session_id + cwd are actually required.
 */
export const HookPayloadSchema = z.looseObject({
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  hook_event_name: z.string().optional().catch(undefined),
  source: z.string().optional().catch(undefined),
  session_title: z.string().optional().catch(undefined),
  reason: z.string().optional().catch(undefined),
  /**
   * UserPromptSubmit only: the prompt text the hint fast path searches with.
   * Tolerant like every field here — if Claude Code renames it, hints degrade
   * to silence (fail open); the hook-contract watcher does not yet probe it
   * (recorded deferral: extending the probe list needs a snapshot re-record
   * against the live docs).
   */
  prompt: z.string().optional().catch(undefined),
  tool_name: z.string().optional().catch(undefined),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  /**
   * PostToolUseFailure only. `error` is the failure text — the same string
   * Claude receives as the failed tool's result — and it arrives as a
   * TOP-LEVEL field rather than inside `tool_response`, which is why the
   * failure signal was invisible to a connector that only read PostToolUse:
   * that event fires when a tool completes SUCCESSFULLY, so a failing `bun
   * test` reached no capture path at all.
   *
   * `is_interrupt` is, in the reference's words, "true when the failure
   * reached Claude Code as an abort rather than as an error the tool
   * reported" — not a build failure, and not fingerprinted (the Cursor
   * connector's handler states the same rule). It is NOT the whole abort
   * story: cancelling a RUNNING tool fires no failure event at all, and its
   * interruption arrives as a tool result on PostToolUse, where
   * `isFailureResponse` reads the `interrupted` marker instead.
   * Tolerant like every field here — renamed upstream, failures simply stop
   * being captured, exactly as they already were.
   */
  error: z.string().optional().catch(undefined),
  is_interrupt: z.boolean().optional().catch(undefined),
  /**
   * Stop only: where Claude Code keeps this session's JSONL transcript (the
   * Tier-1 summarizer's input) and whether this Stop was itself forced by a
   * stop hook (the summarizer skips those — one logical turn, one gate run).
   * Tolerant like every field: renamed upstream, the summarizer goes silent.
   */
  transcript_path: z.string().optional().catch(undefined),
  stop_hook_active: z.boolean().optional().catch(undefined),
});

export type HookPayload = z.infer<typeof HookPayloadSchema>;

export const parseHookPayload = (stdin: string): HookPayload | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
  } catch {
    return null;
  }
  const parsed = HookPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export const isEditTool = (toolName: string | undefined): boolean =>
  toolName !== undefined && EDIT_TOOLS.has(toolName);

export const isBashTool = (toolName: string | undefined): boolean =>
  toolName === "Bash";

const PATH_FIELDS = ["file_path", "notebook_path"] as const;

/** Strings only — an object or array in file_path is ignored, never coerced. */
export const extractFilePaths = (toolInput: unknown): readonly string[] => {
  if (typeof toolInput !== "object" || toolInput === null) {
    return [];
  }
  const record = toolInput as Record<string, unknown>;
  return PATH_FIELDS.map((field) => record[field]).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
};

/**
 * Conservative failure detection: an explicit failure marker must be present.
 * "No such field" means "not a failure", never "assume failure".
 *
 * AN ABORT IS NOT A FAILURE, and this event is where aborts actually arrive.
 * The hooks reference says of `PostToolUseFailure.is_interrupt`: "Cancelling a
 * running tool does not fire this hook; the tool result carries the
 * interruption message instead" — so the guard the failure hook carries is on
 * a door a cancelled tool does not use, and the interruption lands HERE, on
 * the success event, as a tool RESULT. `interrupted` is a documented field of
 * the Bash tool's output shape.
 */
export const isFailureResponse = (toolResponse: unknown): boolean => {
  if (typeof toolResponse !== "object" || toolResponse === null) {
    return false;
  }
  const record = toolResponse as Record<string, unknown>;
  // Before every error marker, because a cancelled call can carry one too and
  // the abort is the stronger fact about it. What it buys is the fingerprint
  // index staying an index of DIAGNOSED failures: "the developer pressed
  // escape" is text every session on the hub produces, and a fingerprint is
  // the one signal collective memory trusts as content identity ACROSS repos
  // (server/services/solved-matches.ts, CROSS_REPO_TARGET_KIND).
  if (record["interrupted"] === true) {
    return false;
  }
  if (record["is_error"] === true || record["isError"] === true) {
    return true;
  }
  if (record["success"] === false) {
    return true;
  }
  return ["exit_code", "exitCode"].some((field) => {
    const value = record[field];
    return typeof value === "number" && value !== 0;
  });
};

