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
 * PRIVACY, NARROWED (design §3.2). The rule was "the content-bearing fields
 * have no schema entry at all", and for the edit strings, the terminal
 * output's siblings, the submitted file list and the user's email it still
 * is: what
 * is never parsed cannot be stored, spooled, or logged, and the privacy
 * suite greps this package's whole source for those names.
 *
 * TWO FIELDS LEFT THAT RULE when the derive rungs landed, deliberately and
 * with narrower pins in their place, because "Ken gets nothing derived" was
 * the price of the wider one:
 *
 *   `prompt` (beforeSubmitPrompt) — read to decide ONE thing (is this
 *     prompt substantive enough to be worth a model call) and then written
 *     to a single 0600 file the detached intent worker unlinks in `finally`.
 *     It reaches no spool record, no session state, no log line and no hub
 *     request; test/privacy.test.ts proves it lands in exactly one file,
 *     names that file, and proves it is gone once the worker has run.
 *   `transcript_path` (common input, documented `string | null`) — a PATH,
 *     not content, and read only by the summarizer slice reader
 *     (derive/transcript.ts). The path itself is never stored or printed —
 *     doctor says whether a transcript was available, never where it is.
 *
 * Neither field is mapped, and neither is required: a build that stops
 * sending them degrades to a booked, named outcome, never to a crash.
 */
import { z } from "zod";

export const CURSOR_HOOK_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
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
   * beforeSubmitPrompt: the user's prompt text (docs: input is `prompt` plus
   * the file list beside it; fetched 2026-08-28). The header states the whole
   * privacy argument for parsing this one. The file list has no entry here
   * and its field name stays on the privacy suite's banned list — which is
   * why this comment does not spell it either.
   */
  prompt: z.string().optional().catch(undefined),
  /**
   * Common input, documented `string | null` ("Path to the main conversation
   * transcript file (null if transcripts disabled)"). Nullable in the schema
   * because the docs say null, not merely absent — and `.catch(undefined)`
   * folds both into the same one branch the summarizer rung refuses on.
   */
  transcript_path: z.string().nullable().optional().catch(undefined),
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
  /** Tool events carry their own cwd; relative paths resolve against it. */
  cwd: z.string().optional().catch(undefined),
});

export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

export const parseCursorPayload = (stdin: string): CursorPayload | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
  } catch {
    return null;
  }
  const parsed = CursorPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
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
  beforeSubmitPrompt: ["conversation_id"],
  afterFileEdit: ["conversation_id", "file_path"],
  afterShellExecution: ["conversation_id"],
  postToolUse: ["conversation_id"],
  postToolUseFailure: ["conversation_id", "error_message"],
  stop: ["conversation_id"],
  sessionEnd: ["conversation_id"],
};

/**
 * Fields whose ABSENCE is contract news but whose EMPTINESS is ordinary use.
 *
 * `prompt` is the only one, and it needs its own rule because the two
 * conditions mean opposite things here. A submit carrying files and no
 * words sends `"prompt": ""` — a real thing a user does, and the intent gate
 * would decline it anyway — while a Cursor build that RENAMED the field sends
 * no `prompt` key at all, and that is the one event the derived-intent rung
 * cannot survive silently. Folding them (the `MAPPED_FIELDS` rule, which
 * treats "" as missing) would put a drift line in the ledger every time
 * somebody dragged a file into the composer, and a tripwire that cries on
 * ordinary use is a tripwire people learn to ignore — this repo's own
 * absence-check lesson.
 */
const PRESENCE_ONLY_FIELDS: Readonly<
  Partial<Record<CursorHookEvent, readonly string[]>>
> = {
  beforeSubmitPrompt: ["prompt"],
};

/** Names of the mapped fields this payload is missing (empty = healthy). */
export const missingMappedFields = (
  event: CursorHookEvent,
  payload: CursorPayload,
): readonly string[] => {
  const record = payload as Record<string, unknown>;
  return [
    ...MAPPED_FIELDS[event].filter((field) => {
      const value = record[field];
      return value === undefined || value === null || value === "";
    }),
    ...(PRESENCE_ONLY_FIELDS[event] ?? []).filter(
      (field) => record[field] === undefined,
    ),
  ];
};
