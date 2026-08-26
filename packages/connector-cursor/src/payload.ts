/**
 * Cursor hook payload parsing — tolerant of everything except the fields a
 * mapping cannot live without (test/fixtures/cursor-contract/payloads.ts is
 * the recorded contract; the fixture header carries source + fetch date).
 *
 * The discipline is the Claude connector's HookPayloadSchema, new host:
 * unknown fields ignored, wrong-typed optional fields fall back to undefined,
 * and NOTHING here is required — required-ness is per event
 * (`missingMappedFields`), so a payload missing what we map degrades to a
 * NAMED contract-drift count (src/drift.ts) instead of a parse failure that
 * dies silently (§10 risk 5).
 *
 * PRIVACY (design §3.2, Tier-0): the content-bearing fields — the edit
 * strings, the prompt, the transcript, the user's email — have no schema
 * entry at all. What is never parsed cannot be stored, spooled, or logged;
 * the privacy suite pins the field names out of this package's source.
 */
import { z } from "zod";

export const CURSOR_HOOK_EVENTS = [
  "sessionStart",
  "afterFileEdit",
  "afterShellExecution",
  "postToolUse",
  "postToolUseFailure",
  "stop",
  "sessionEnd",
] as const;

export type CursorHookEvent = (typeof CURSOR_HOOK_EVENTS)[number];

export const isCursorHookEvent = (value: string): value is CursorHookEvent =>
  (CURSOR_HOOK_EVENTS as readonly string[]).includes(value);

export const CursorPayloadSchema = z.looseObject({
  /** Stable conversation id — the host session key (`cur-<id>`). */
  conversation_id: z.string().optional().catch(undefined),
  hook_event_name: z.string().optional().catch(undefined),
  cursor_version: z.string().optional().catch(undefined),
  /** Repo identity resolves from the first root (CURSOR_PROJECT_DIR backs it). */
  workspace_roots: z.array(z.string()).optional().catch(undefined),
  /** sessionStart / sessionEnd: background runs register under their own kind. */
  is_background_agent: z.boolean().optional().catch(undefined),
  /** afterFileEdit: the ONE thing Tier-0 takes from an edit — the path. */
  file_path: z.string().optional().catch(undefined),
  /**
   * afterShellExecution: full terminal output — read ONLY on an explicit
   * failure marker, only into `fingerprint()` (a hash leaves this process,
   * never the text).
   */
  output: z.string().optional().catch(undefined),
  /**
   * TOLERATED, NOT DOCUMENTED: the documented afterShellExecution input has
   * no exit field of any spelling, so the conservative rule ("no such field
   * means not a failure") makes the documented shape capture nothing. If a
   * real build sends a numeric exit code, it is the explicit failure marker.
   * The §6-q5 dogfood answers whether that ever happens.
   */
  exit_code: z.number().optional().catch(undefined),
  exitCode: z.number().optional().catch(undefined),
  /** postToolUse: JSON-stringified result payload (documented encoding). */
  tool_output: z.string().optional().catch(undefined),
  tool_name: z.string().optional().catch(undefined),
  /** postToolUseFailure: the documented failure signal. */
  error_message: z.string().optional().catch(undefined),
  failure_type: z.string().optional().catch(undefined),
  is_interrupt: z.boolean().optional().catch(undefined),
  /**
   * Tool events carry their own cwd; relative paths resolve against it. An
   * EMPTY one is folded to absent at the parse boundary — see
   * `withoutEmptyCwd` below for the payload that made that necessary.
   */
  cwd: z.string().optional().catch(undefined),
});

export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

/**
 * An EMPTY cwd is an ABSENT cwd, folded once here at the boundary instead of
 * at each use. A live Cursor 3.13.25 `preToolUse` capture carries `cwd: ""`
 * twice in one payload (top level and inside `tool_input`), and `??` folds
 * `undefined` and `null` but NOT `""` — so an empty one flows straight
 * through to `resolve("", filePath)`, i.e. the HOOK PROCESS's own working
 * directory. That was harmless while `cwd` merely backed one `resolve()`; it
 * became load-bearing with the #17 worktree resolution, where the same value
 * feeds `findConnectedRepoRootForFile` and both `toRepoRelative` calls inside
 * the resolver. The key is removed rather than blanked, so every reader's
 * `?? fallback` behaves exactly as it does for a payload that never had one.
 */
const withoutEmptyCwd = (payload: CursorPayload): CursorPayload => {
  if (payload.cwd !== "") {
    return payload;
  }
  const { cwd: _empty, ...rest } = payload;
  return rest;
};

export const parseCursorPayload = (stdin: string): CursorPayload | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
  } catch {
    return null;
  }
  const parsed = CursorPayloadSchema.safeParse(raw);
  return parsed.success ? withoutEmptyCwd(parsed.data) : null;
};

/**
 * The fields whose ABSENCE kills that event's Tier-0 mapping — exactly what
 * the contract-drift tripwire counts. Everything else missing is a normal
 * degrade (a failure event without a failure is silence, not drift).
 *
 * `workspace_roots` is special-cased in the runner: the documented
 * CURSOR_PROJECT_DIR env variable is its backstop, so it only counts as
 * drift when BOTH are absent.
 *
 * `afterShellExecution` requires only the id, deliberately: a silent
 * successful command (`mkdir`, `git add`) sends an empty `output`, so a
 * required `output` would count ordinary use as drift and train people to
 * ignore the one instrument the §6-q5 dogfood reads — and the handler's
 * real gate is the TOLERATED exit marker, which a documented-contract
 * tripwire cannot require.
 */
const MAPPED_FIELDS: Readonly<Record<CursorHookEvent, readonly string[]>> = {
  sessionStart: ["conversation_id"],
  afterFileEdit: ["conversation_id", "file_path"],
  afterShellExecution: ["conversation_id"],
  postToolUse: ["conversation_id"],
  postToolUseFailure: ["conversation_id", "error_message"],
  stop: ["conversation_id"],
  sessionEnd: ["conversation_id"],
};

/** Names of the mapped fields this payload is missing (empty = healthy). */
export const missingMappedFields = (
  event: CursorHookEvent,
  payload: CursorPayload,
): readonly string[] =>
  MAPPED_FIELDS[event].filter((field) => {
    const value = (payload as Record<string, unknown>)[field];
    return value === undefined || value === null || value === "";
  });
