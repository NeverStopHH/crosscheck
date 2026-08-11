import { z } from "zod";

import { FINGERPRINT_SOURCE_CHARS } from "../constants.ts";

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
 */
export const isFailureResponse = (toolResponse: unknown): boolean => {
  if (typeof toolResponse !== "object" || toolResponse === null) {
    return false;
  }
  const record = toolResponse as Record<string, unknown>;
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

const TEXT_FIELDS = ["stdout", "stderr", "output", "error"] as const;

export const extractFailureText = (toolResponse: unknown): string => {
  if (typeof toolResponse === "string") {
    return toolResponse.slice(-FINGERPRINT_SOURCE_CHARS);
  }
  if (typeof toolResponse !== "object" || toolResponse === null) {
    return "";
  }
  const record = toolResponse as Record<string, unknown>;
  const joined = TEXT_FIELDS.map((field) => record[field])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return joined.slice(-FINGERPRINT_SOURCE_CHARS);
};
