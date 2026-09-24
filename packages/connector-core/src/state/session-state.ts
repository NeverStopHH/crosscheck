import { z } from "zod";

import {
  DOCTOR_ZOMBIE_STATE_WARN_HOURS,
  MAX_BRIEFING_SOLVED_REFS,
  MAX_KNOWN_WORKTREE_ROOTS,
  MAX_PROBED_FINGERPRINTS,
  MAX_SEEN_TARGETS,
  MAX_TOOL_WINDOWS,
  MAX_TRIPWIRE_ASKED_FILES,
  MINUTES_PER_HOUR,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
  SESSION_STATE_LOCK_RETRIES,
  STATUS_MAX_SESSION_STATES,
} from "../constants.ts";
import {
  readJsonOrNull,
  removeFile,
  sessionStatePath,
  writePrivateFile,
} from "../config/paths.ts";
import { withLock } from "../spool/lock.ts";
import {
  listSessionStateFiles,
  sessionSilentForMs,
} from "./session-scan.ts";

/**
 * THE SESSION STATE'S LOCK, spelled once so no acquisition here can accidentally
 * buy the SPOOL's patience.
 *
 * Both locks are the same primitive, and that is the trap: `withLock`'s default
 * retry count is sized by what a busy FLUSH costs, which is a deferred flush the
 * next hook retries. Every acquisition in this file costs something else — a
 * position in the causal order, a bookkeeping write, a session binding — so it
 * gets SESSION_STATE_LOCK_RETRIES, whose comment carries the measurement that
 * chose the number.
 *
 * A seventh caller reaching for `withLock` directly would compile, pass its
 * tests, and quietly reintroduce the refusals SEQ-3 caught. Reaching for this
 * instead is the only thing standing between that and the order.
 */
const withSessionStateLock = async <T>(
  path: string,
  fallback: T,
  action: () => Promise<T>,
): Promise<T> => withLock(path, fallback, action, SESSION_STATE_LOCK_RETRIES);

/**
 * Past this much silence a state file is a CORPSE, not a live session: the
 * same hour `doctor` calls a state file zombie, so the two surfaces cannot
 * disagree about which sessions exist.
 */
const STALE_SESSION_STATE_MS =
  DOCTOR_ZOMBIE_STATE_WARN_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * The legacy spelling of `hostSessionKey`, accepted on READ forever.
 *
 * Before Block 2 (DESIGN-agent-agnostic.md §1.3) every state file on disk
 * named the host's session id `claudeSessionId`, because Claude Code was the
 * only host. Those files keep parsing: the preprocess below folds the old key
 * into the new one (`hostSessionKey ?? claudeSessionId`) and DROPS the legacy
 * key, so a mid-flight write-back emits only the new spelling — a session
 * upgraded between two hooks reads old, writes new, and never carries both.
 * test/identity-compat.test.ts pins this against a state file frozen from the
 * pre-change code.
 */
const LEGACY_SESSION_KEY = "claudeSessionId";

const foldLegacySessionKey = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!(LEGACY_SESSION_KEY in record)) {
    return value;
  }
  const { [LEGACY_SESSION_KEY]: legacy, ...rest } = record;
  // Exactly `hostSessionKey ?? claudeSessionId`: ?? folds null as well as
  // absent, so a half-migrated `hostSessionKey: null` recovers to the legacy
  // key instead of failing open (identity-compat.test.ts pins both shapes).
  const host = rest["hostSessionKey"];
  return host === undefined || host === null
    ? { ...rest, hostSessionKey: legacy }
    : rest;
};

/**
 * The two fields the keyed `toolWindows` list retired. This schema is a
 * `looseObject`, so an unknown key SURVIVES a read and a write-back would
 * carry a floor and a count nothing reads for the rest of the session's life —
 * the silent absence this tree forbids. Dropped exactly the way the legacy
 * session key above is dropped: accepted on read, gone on the next write.
 */
const RETIRED_TOOL_WINDOW_KEYS = ["toolWindowFloor", "toolWindowOpen"] as const;

const dropRetiredToolWindowKeys = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!RETIRED_TOOL_WINDOW_KEYS.some((key) => key in record)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => !RETIRED_TOOL_WINDOW_KEYS.includes(key as never),
    ),
  );
};

const SessionStateObjectSchema = z.looseObject({
  /**
   * The HOST's own id for this session — for Claude Code the raw `session_id`
   * (unchanged since before the rename, so every existing spool slug, state
   * filename and cc_<uuid> still derives byte-identically), for other
   * connectors a prefixed key (state/host-session-key.ts).
   */
  hostSessionKey: z.string().min(1),
  crosscheckSessionId: z.string().min(1),
  workContextId: z.string().min(1),
  repoId: z.string().min(1),
  repoRoot: z.string().min(1),
  hubUrl: z.string().min(1),
  developerId: z.string().min(1).nullable().default(null),
  startedAt: z.string().min(1),
  lastHeartbeatAt: z.string().nullable().default(null),
  seenTargets: z.array(z.string().min(1)).default([]),
  /**
   * Hint state that must survive hook process restarts (DESIGN.md §4): the
   * refs already delivered (seen-set dedup + the 5/session cap counts this),
   * the normalized-body hashes of delivered substance (echo-loop exclusion,
   * §3), and the files the tripwire already asked about (ask once). Defaults
   * keep every pre-hints state file parsing unchanged.
   */
  deliveredHintRefs: z.array(z.string().min(1)).default([]),
  deliveredHintHashes: z.array(z.string().min(1)).default([]),
  tripwireAskedFiles: z.array(z.string().min(1)).default([]),
  /**
   * Files this session was already stopped on for a teammate's LANDED change
   * (docs/1.0/landed-changes.md). A separate list from tripwireAskedFiles on
   * purpose: one stop per file per REASON, so a landed-change stop does not
   * use up the live one — a teammate who starts on the same file later in
   * the session is still named, once.
   */
  landedAskedFiles: z.array(z.string().min(1)).default([]),
  /**
   * Work contexts the SessionStart briefing already pointed at as "solved
   * before" (VISION.md §1). A SEPARATE list from deliveredHintRefs on
   * purpose: the prompt path folds these into its seen-set so the same tree
   * is never re-pointed, but they must not spend the 5/session hint cap —
   * a briefing pointer is the briefing's budget, not the prompt path's.
   */
  briefingSolvedRefs: z.array(z.string().min(1)).default([]),
  /**
   * Error fingerprints the failure-time solved probe has already ASKED the
   * hub about in this session (VISION.md §1). Separate from every list
   * beside it because it records a QUESTION rather than a delivery: the
   * others move only when something was shown, and the probe's cost is paid
   * whether or not anything comes back — which is exactly the case a retry
   * loop produces dozens of times a minute. Default keeps every existing
   * state file parsing.
   */
  probedFingerprints: z.array(z.string().min(1)).default([]),
  /**
   * Touches of files in a DIFFERENT connected repo, dropped under the
   * first-wins rule (trial finding #9): one agent session is ONE crosscheck
   * session, bound at registration to one repo — a multi-project workspace
   * editing a second connected repo has those targets dropped, and this is
   * the count that keeps the drop honest. Default keeps every existing
   * state file parsing.
   */
  foreignRepoDrops: z.number().int().min(0).default(0),
  /**
   * Touches whose repo-relative path could not be resolved against ANY root
   * of this session's repo (trial finding #17): the edited file sits outside
   * the session's checkout AND outside every connected worktree of the same
   * repo — a loose file next to the repo, or one whose worktree carries no
   * committed config. Distinct from `foreignRepoDrops` (a DIFFERENT repo,
   * counted): this is "same session, path unattributable". Before #17 this
   * class was silently dropped and never counted. Default 0 keeps every
   * existing state file parsing.
   */
  outsideRootDrops: z.number().int().min(0).default(0),
  /**
   * Per-session cache of worktree roots this session has already resolved
   * (trial finding #17): `root` is the realpath'd worktree root of a touched
   * file, `repoId` its resolved repo id — a FOREIGN root sits here under its
   * own id, an unresolvable one as null — both cached so a repeated touch
   * costs no git either. `attempts` counts the identity resolutions the root
   * has already cost: a null is an UNKNOWN, not an answer, so capture/touched-
   * root.ts re-resolves it until MAX_WORKTREE_ROOT_RESOLVE_ATTEMPTS are spent
   * (a git deadline missed once must not exile a healthy worktree for the
   * session). FIFO-capped at MAX_KNOWN_WORKTREE_ROOTS by
   * `withKnownWorktreeRoot`.
   * Defaults keep every pre-#17 state file parsing — an entry written before
   * `attempts` existed reads as one attempt spent, and one written before
   * `stamp` existed reads as UNSTAMPED (capture/touched-root.ts: accepted
   * once, then bound to whatever checkout is at that path now).
   */
  knownWorktreeRoots: z
    .array(
      z.object({
        root: z.string().min(1),
        repoId: z.string().min(1).nullable(),
        attempts: z.number().int().min(1).default(1),
        stamp: z.string().min(1).nullable().default(null),
      }),
    )
    .default([]),
  /**
   * Capture observability (trial finding #17/#18/#20 — the counters `status`
   * and `doctor` read so "N edit-tool fires → 0 targets" stops being silent):
   *   - `editToolFires`  every edit-tool PostToolUse this session reached the
   *     hook with, counted BEFORE the foreign/outside drops so N − M is
   *     explainable;
   *   - `targetsCapturedCount`  targets actually spooled (monotonic; the
   *     seenTargets list is FIFO-capped and cannot be summed);
   *   - `lastTargetAt`  when the last target landed;
   *   - `lastPostToolUseTool`  the last edit-tool name the hook saw
   *     (host-supplied, a fixed Claude Code vocabulary — bounded on display);
   *   - `lastEditedPath` / `lastEditedPathResolvedAgainst`  the last edited
   *     path and the root it resolved against (null = it did not resolve),
   *     the #18 diagnosis line that closes Ken's "0 targets" cause.
   * Defaults keep every pre-#17 state file parsing.
   */
  editToolFires: z.number().int().min(0).default(0),
  targetsCapturedCount: z.number().int().min(0).default(0),
  lastTargetAt: z.string().nullable().default(null),
  lastPostToolUseTool: z.string().nullable().default(null),
  lastEditedPath: z.string().nullable().default(null),
  lastEditedPathResolvedAgainst: z.string().nullable().default(null),
  /**
   * How many hint candidates the prompt path has seen from the hub this
   * session (trial finding #19/#20): the `doctor` hints check reads it to say
   * whether a targets-only pointer was ever even POSSIBLE for this repo.
   * Booked in flows/hint.ts. Default 0 keeps every pre-#19 state file parsing.
   */
  hintCandidatesSeen: z.number().int().min(0).default(0),
  /**
   * True when registration happened OUTSIDE SessionStart — PostToolUse's
   * state-less recovery, the parent-workspace/finding-#9 shape — so this
   * session has never seen its briefing. The next UserPromptSubmit pays the
   * debt through the same core flow SessionStart uses and clears the flag
   * with a check-and-set (flows/briefing.ts `deliverDeferredBriefing`, the
   * ACP briefing-slot pattern in hook form). Default false keeps every
   * existing state file parsing — and keeps SessionStart-registered
   * sessions debt-free.
   */
  briefingPending: z.boolean().default(false),
  /**
   * Tier-1 summarizer bookkeeping (DESIGN.md §3 Tier 1): the Stop-turn
   * counter the debounce is measured against, the fires already spent
   * against SUMMARIZER_MAX_FIRES_PER_SESSION, and the rough token estimate
   * `crosscheck status`/`doctor` surface (§10 risk 7 — the cost is never
   * invisible). Defaults keep every pre-summarizer state file parsing.
   */
  stopTurnCount: z.number().int().min(0).default(0),
  summarizerFireCount: z.number().int().min(0).default(0),
  summarizerLastFireTurn: z.number().int().min(0).nullable().default(null),
  summarizerEstimatedTokens: z.number().int().min(0).default(0),
  /**
   * Outcome telemetry per fire (trial finding #12's measuring stick): how
   * many runs answered NONE and how many produced a spooled draft. Booked by
   * the detached worker, read by the cost surfaces beside the fire count —
   * fires minus NONEs minus drafts is the drop-or-failure remainder. The
   * defaults keep every pre-telemetry state file parsing.
   */
  summarizerNoneCount: z.number().int().min(0).default(0),
  summarizerDraftCount: z.number().int().min(0).default(0),
  /**
   * Failure telemetry per fire (trial finding #14, where 17 of 17 fires
   * answered nothing and no surface said why): how many runs the runner
   * itself lost — binary missing, non-zero exit, deadline — and the most
   * recent reason as the worker booked it (gate.ts withSummarizerFailure:
   * exit code / timeout / the first line of STDOUT, sanitized and cut to
   * SUMMARIZER_FAILURE_MAX_CHARS — stderr stays ignored). Bounded by the
   * writer, not here: a schema max would make one over-long string an
   * unparseable file and silence the whole session. Defaults keep every
   * pre-telemetry state file parsing.
   */
  summarizerFailCount: z.number().int().min(0).default(0),
  summarizerLastFailure: z.string().nullable().default(null),
  /**
   * Rejection telemetry per fire (audit rows M16 / A3-4): how many answers
   * came back well-formed and were still refused — role-play, an echo of the
   * prompt or of a delivered teammate hint, a credential-shaped body, a claim
   * the wire contract would not take — plus the most recent reason IN
   * CROSSCHECK'S OWN WORDS (core model/reject.ts never quotes the body). Every
   * one of these used to be a silent `return` inside the worker, so a fire
   * whose answer nobody kept was indistinguishable from a runner that never
   * spoke. Bounded by the writer like the failure reason. Defaults keep every
   * pre-rejection state file parsing.
   */
  summarizerRejectCount: z.number().int().min(0).default(0),
  /**
   * Turns where the gate wanted to look and there was NOTHING TO LOOK AT:
   * the host sent no transcript, the file could not be read, or its tail
   * decoded to nothing. No model ran, so this is not a fire and not a
   * failure — `ghostNoOverlapCount`'s lesson, applied one tier down. Folded
   * into `summarizerFailCount` it would send a Cursor user whose build
   * simply has transcripts disabled to their local `claude` binary, which is
   * working perfectly. The reason is one of the connector's own constants,
   * bounded by the writer.
   */
  summarizerNoSliceCount: z.number().int().min(0).default(0),
  summarizerLastNoSlice: z.string().nullable().default(null),
  /**
   * WHICH DECODER READ THE LAST SLICE, on a host whose transcript format is
   * undocumented. Written only by the Cursor connector, whose reader tries a
   * line-delimited-JSON decoder and falls back to reading the tail as prose
   * (connector-cursor derive/transcript.ts) — the jsonl half is a HYPOTHESIS,
   * so the day it stops matching, the fallback takes over and the gate is
   * handed a strictly weaker slice with nothing booked anywhere: a slice WAS
   * produced, so it is not a noSlice, and no model failed, so it is not a
   * failure. This field is the only place that flip can become visible, and
   * the Cursor capability line prints it.
   *
   * Null on every other host and on a state file written before a turn was
   * decoded. A short enum-shaped token from the connector's own type, never
   * host text — nothing read off a transcript reaches here.
   */
  summarizerLastSliceShape: z.string().nullable().default(null),
  /**
   * SLICE CHARACTERS A HOST'S OWN CAP REFUSED, summed over this session's
   * turns. Written only by the ACP proxy, whose slice is accumulated in
   * memory from the wire and bounded by ACP_TURN_SLICE_MAX_CHARS.
   *
   * It is not a failure and not a noSlice: a slice WAS produced, a model DID
   * run on it, and the outcome it booked is real. What the number says is
   * that the gate judged a TRUNCATED turn, so a conclusion may have arrived
   * past the cap and been thrown away — the one derive outcome on that host
   * that no counter here could reach, which left it visible only in a
   * per-pid proxy log file swept after ACP_LOG_MAX_AGE_DAYS.
   *
   * A COUNT, never the refused text: the characters themselves are the
   * agent's own prose and never enter a state file.
   */
  summarizerSliceDroppedChars: z.number().int().min(0).default(0),
  summarizerLastRejection: z.string().nullable().default(null),
  /**
   * Answers the model GAVE and this contract could not read: stdout that is
   * neither claim JSON nor NONE, or nothing at all. These used to be booked
   * NOWHERE - the only trace was the fires-minus-outcomes remainder, an
   * arithmetic gap with no reason attached - which was survivable while the
   * binary was always a Claude whose output shape the prompts were tuned on,
   * and stops being survivable the moment CROSSCHECK_SUMMARIZER_CMD points
   * at a model with output habits of its own. It is NOT a runner failure
   * (the binary ran and exited 0) and NOT a NONE (the model did not judge
   * the turn empty), so it gets its own counter and its own doctor remedy:
   * folded into either one, the reader is sent to the wrong place.
   *
   * The reason is one of gate.ts's two own sentences - never the model's
   * text, which is printed into a terminal and often into an agent's
   * context. Bounded by the writer like every other reason here.
   */
  summarizerUnreadableCount: z.number().int().min(0).default(0),
  summarizerLastUnreadable: z.string().nullable().default(null),
  /**
   * The work-context title and status this session registered with (trial
   * finding #16): an intent UPDATE record must carry both (the wire schema
   * requires them), so the derived-intent worker and `set_intent` read them
   * here instead of re-deriving. Null on a pre-intent state file — the writers
   * then book "no title in session state" rather than fabricate one.
   */
  workContextTitle: z.string().min(1).nullable().default(null),
  workContextStatus: z.string().min(1).nullable().default(null),
  /**
   * Derived-intent telemetry (trial finding #16; the finding-#14 lesson — a
   * fire that lands nothing must be a number somebody can explain): fires
   * booked by the UserPromptSubmit hook under the lock BEFORE the worker
   * spawns, and the worker's outcome — NONE, an intent set on the spool, or
   * a failure with its reason (runner loss, or a drop: secret, echo, empty —
   * bounded by the writer to SUMMARIZER_FAILURE_MAX_CHARS). Defaults keep
   * every pre-intent state file parsing.
   */
  intentFireCount: z.number().int().min(0).default(0),
  intentNoneCount: z.number().int().min(0).default(0),
  intentSetCount: z.number().int().min(0).default(0),
  intentFailCount: z.number().int().min(0).default(0),
  intentLastFailure: z.string().nullable().default(null),
  /**
   * The intent sentence this session last put on the hub (VISION.md §3), and
   * the reason it is stored rather than re-read: the ghost check compares
   * MY plan with a teammate's, and the detached worker that runs it has no
   * other way to know what this session said it was doing. Written by both
   * writers — `set_intent` and the derived-intent worker — right after the
   * record reaches the hub or the spool, so what is here is what a teammate
   * would see.
   */
  workContextIntent: z.string().min(1).nullable().default(null),
  /**
   * A ghost check is OWED (VISION.md §3): an intent was recorded and nothing
   * has compared it against the team's live plans yet. The DEBT shape, not a
   * spawn: `set_intent` runs inside an MCP call in connector-core, which
   * cannot reach a Claude-specific worker, so it books the debt and the next
   * UserPromptSubmit pays it — exactly how `briefingPending` carries a
   * briefing a late-registered session never got.
   */
  ghostPending: z.boolean().default(false),
  /**
   * The SECOND evidence lane's telemetry (regression-guard Stage 1): how many
   * files the Stop-time `git diff --name-only` recorded that no Edit tool
   * reported, and how many Stop turns did NOT run the lane — either the
   * hook's spare budget was gone before it started, or git did not answer
   * inside its own deadline. Both are counted for the finding-#14 reason: a
   * lane that records nothing must be a number somebody can explain, not a
   * silence that reads like health. `status` prints the pair and `doctor`
   * WARNs when the skipped turns outnumber the turns the lane RAN
   * (state/git-lane-cost.ts) — `gitLaneRan` is that denominator, booked on
   * every turn git answered, including the ones that found nothing fresh.
   * Without it the verdict weighed skipped TURNS against recorded FILES and
   * was red forever on a healthy install that runs no codemods. Defaults
   * keep every older state file parsing.
   */
  gitTouchCount: z.number().int().min(0).default(0),
  gitLaneSkipped: z.number().int().min(0).default(0),
  gitLaneRan: z.number().int().min(0).default(0),
  /**
   * Deterministic ghost notices this session actually SHOWED the reader (the
   * briefing block plus the `set_intent` answer). The precision half of the
   * counter pair: the model layer's outcomes say what the gated call bought,
   * and this says how often the free half had something to say at all.
   */
  ghostNoticeCount: z.number().int().min(0).default(0),
  /**
   * The GATED half's telemetry (VISION.md §3), the derived-intent counters'
   * shape and the same lesson behind it (finding #14): a fire that lands
   * nothing must be a number somebody can explain. `noOverlap` is the outcome
   * that costs no tokens at all — the deterministic core found nobody, so no
   * model ran — and it is counted separately precisely so it never reads as a
   * failure. Bounded by the writer (ghost/gate.ts), defaults keep every older
   * state file parsing.
   */
  ghostFireCount: z.number().int().min(0).default(0),
  ghostNoOverlapCount: z.number().int().min(0).default(0),
  /**
   * Checks that could not run because the HUB could not answer the overlap
   * query — a hub too old for the route, or an unreachable one. Its own
   * counter and not a failure, for the reason `noOverlap` has one: nothing on
   * this machine is broken, so nothing on this machine may be booked as
   * broken. Folded into `ghostFailCount` it made `doctor` WARN that the model
   * layer was dead, one line above the `plan overlap` PASS describing the very
   * same condition, and sent the reader to their local `claude` binary.
   */
  ghostNoHubAnswerCount: z.number().int().min(0).default(0),
  ghostNoneCount: z.number().int().min(0).default(0),
  ghostDraftCount: z.number().int().min(0).default(0),
  ghostFailCount: z.number().int().min(0).default(0),
  ghostLastFailure: z.string().nullable().default(null),
  /**
   * THE PER-SESSION CAUSAL ORDER (spec 01 §3.3/§3.4): the opaque epoch this
   * session's positions belong to, and the highest position ALLOCATED under
   * it. Appended BELOW #50's counters and never renumbered — every consumer
   * keys on the name.
   *
   * WHY A PAIR AND NOT A BARE COUNTER. Three measured mechanisms restart the
   * counter without the epoch: a SessionStart RE-FIRE re-creates the state
   * file under the same hostSessionKey (publishSessionState's header); a BUSY
   * LOCK makes that publication fall back to a plain create with no carry at
   * all ("the counters lose rather than the file"); and two HOMES on one key
   * — a cloud or background agent sharing a host session id across machines —
   * cannot share a ~/.crosscheck lock. A restarted counter under an unchanged
   * epoch makes two distinct events share one `(session, epoch, n)`, which is
   * a confident wrong answer about which came first. A restarted counter
   * under a FRESH epoch is merely not comparable, which is the honest
   * outcome: the hub sees two epochs, marks the session `broken /
   * epoch_split`, and refuses the comparison instead of guessing.
   *
   * `eventSeq` counts ALLOCATIONS, not records: an emitter that dies between
   * the allocation and its append leaves a GAP, and gaps are legal (§3.4).
   * Loss is visible in the spool `.drops` ledger, never inferred from a hole
   * here. The defaults keep every older state file parsing (§4).
   */
  seqEpoch: z.string().min(1).nullable().default(null),
  eventSeq: z.number().int().min(0).default(0),
  /**
   * THE WINDOW EACH RUNNING TOOL'S EDIT IS HAPPENING IN — one entry per open
   * window, and the thing that turns a position taken AFTER the work into an
   * interval a happens-before question may be asked of.
   *
   * A PostToolUse hook allocates once its tool has returned, so its position
   * is an upper bound on an edit already on disk, and an emitter that
   * allocated inside that window holds a LOWER number than a change that came
   * first. `floor` is a position taken BEFORE the tool started and attached to
   * nothing — a deliberate gap — and `key` is what says WHICH call it belongs
   * to: a digest of the host's `tool_use_id`, which both hooks of a call are
   * handed and no other call is (state/tool-window-key.ts).
   *
   * WHY A LIST AND NOT A FLOOR AND A COUNT. That pair was this field, and it
   * could not name an owner: `openToolWindow` recorded the OLDEST open floor
   * and PostToolUse closed a window whenever `isEditTool(tool_name)` was true,
   * whether or not its own PreToolUse had opened one. So a tool whose open was
   * refused — a busy state lock, or a hook installed mid-flight with no state
   * file yet — closed a PARALLEL tool's window and took a floor recorded AFTER
   * its own edit. MEASURED on the real hooks with the lock held on purpose:
   * the hub answered `predeclared`, the value that exonerates, for an
   * explanation written after the change, and the parallel tool LOST its own
   * bracket to that close. Both are pinned in
   * connector-claude/test/hook-window-pairing.test.ts, and so is the reason
   * the key is the host's id rather than a digest of the call's name and
   * input: two IDENTICAL calls share such a digest, and a twin whose open was
   * refused took its sibling's later floor the same way.
   *
   * A STATE FILE FROM BEFORE THIS LIST carries the retired `toolWindowFloor`
   * and `toolWindowOpen` and no list, so its in-flight tools match no key and
   * get NO bracket. That is the honest answer rather than a gap: their
   * positions stay the upper bound they are and the hub refuses. The retired
   * keys are DROPPED on read (the preprocess above), so a mid-flight write-back
   * leaves nothing on disk that looks like a window nobody reads.
   *
   * A LEAKED WINDOW BRACKETS NOTHING. A PreToolUse whose call is never closed
   * (a denied call, an aborted one, a close a busy lock refused) leaves its
   * entry behind, and no later call carries its id, so it is never matched
   * again. It costs a slot until MAX_TOOL_WINDOWS evicts it, and the evictions
   * that bound costs are COUNTED rather than inferred from a missing bracket.
   * The defaults keep every older state file parsing.
   */
  toolWindows: z
    .array(
      z.object({
        key: z.string().min(1),
        floor: z.number().int().min(0),
      }),
    )
    .default([]),
  toolWindowEvictions: z.number().int().min(0).default(0),
  /**
   * EDIT POSITIONS THAT TRAVELLED WITH NO WINDOW — the count of brackets
   * actually LOST, from the only side that can see them all.
   *
   * `toolWindowEvictions` counts what the CAP threw away, and that is not the
   * same number: a PreToolUse whose `openToolWindow` the busy state lock
   * refused writes no entry at all, so nothing is ever evicted for it and the
   * cap's counter does not move. MEASURED on the real hooks, one turn of K
   * parallel Edit calls: at K=32 six of 32 opens were refused by a busy state
   * lock and at K=48 twenty of 48 were, with `toolWindowEvictions` 0 in every
   * run — so the one number both surfaces printed was blind to the losses that
   * were happening.
   *
   * COUNTED AT THE CLOSE, because the close is where every cause meets. A
   * PostToolUse that allocated a position for an EDIT and found no window
   * under its own key has lost the bracket, whether its open was refused, its
   * entry evicted, its hook installed mid-flight, its state file older than
   * this list, or its host too old to send a `tool_use_id`. It costs no lock:
   * the fold rides in the one mid-session write that hook already makes.
   *
   * WHAT IT STILL CANNOT COUNT: a call whose PostToolUse allocation was ALSO
   * refused. Nothing was positioned then, so there is no bracket to miss — the
   * record travels `allocation_failed` and says so for itself.
   *
   * IT IS NOT A WARN. Every cause above is either load or a host's age, none
   * has a remedy the reader could apply, and the direction is safe — a missing
   * bracket makes the hub REFUSE, never answer `predeclared`. It is printed so
   * that a machine losing brackets stops reading exactly like one that is not.
   */
  toolWindowMisses: z.number().int().min(0).default(0),
});

/**
 * The read schema: the object schema behind a preprocess that folds the legacy
 * session key and drops the retired window fields. Writers never need either —
 * they pass `hostSessionKey` and the keyed `toolWindows` list.
 */
export const SessionStateSchema = z.preprocess(
  (value) => dropRetiredToolWindowKeys(foldLegacySessionKey(value)),
  SessionStateObjectSchema,
);

export type SessionState = z.infer<typeof SessionStateObjectSchema>;

/**
 * What a WRITER may pass: the defaulted fields are optional, exactly as they
 * are for a state file already on disk from before they existed. Readers
 * always see the full SessionState — readSessionState parses through the
 * schema, which fills the defaults. Typed off the OBJECT schema, because
 * `z.input` of a preprocess is `unknown` — a writer's input is always
 * new-shape.
 */
export type SessionStateInput = z.input<typeof SessionStateObjectSchema>;

/** Deterministic ids survive a crash: no lookup, no id table, no drift. */
export const crosscheckSessionIdFor = (hostSessionKey: string): string =>
  `cc_${hostSessionKey}`;

export const workContextIdFor = (crosscheckSessionId: string): string =>
  `wc_${crosscheckSessionId}`;

export const readSessionState = async (
  home: string,
  hostSessionKey: string,
): Promise<SessionState | null> => {
  const parsed = SessionStateSchema.safeParse(
    await readJsonOrNull(sessionStatePath(home, hostSessionKey)),
  );
  return parsed.success ? parsed.data : null;
};

export const writeSessionState = async (
  home: string,
  state: SessionStateInput,
): Promise<void> => {
  await writePrivateFile(
    sessionStatePath(home, state.hostSessionKey),
    `${JSON.stringify(state, null, 2)}\n`,
  );
};

export const deleteSessionState = async (
  home: string,
  hostSessionKey: string,
): Promise<void> => {
  await removeFile(sessionStatePath(home, hostSessionKey));
};

/**
 * Exported so a test can make the lock BUSY on purpose rather than hoping a
 * loaded machine makes it busy for it. The patience above is the whole reason
 * `allocateSeq` returns a position instead of a refusal, and a test that cannot
 * hold the lock can only assert that by running many emitters and trusting the
 * scheduler — which is how SEQ-3 came to pass on every developer Mac and fail
 * on both CI runners. Nothing in the source takes it from here.
 */
export const sessionStateLockPath = (
  home: string,
  hostSessionKey: string,
): string => `${sessionStatePath(home, hostSessionKey)}.lock`;

/**
 * Read-transform-write under the state file's own lock — how every MID-SESSION
 * writer must update state. Claude Code runs tools in parallel, so sibling
 * hooks overlap; a hook that wrote back the whole state it read at its start
 * would erase whatever a faster sibling recorded in between (a tripwire
 * marker, a seen target — test/state-race.test.ts pins both interleavings).
 * The transform runs on the FRESHEST state, inside the lock, so nothing read
 * before the lock can leak into the write.
 *
 * `transform` returning null declines the write — that is how PreToolUse's
 * "one ask per file" check-and-set is atomic rather than check-then-set.
 *
 * Fail-open like everything on a hook path: no state file, an unparseable
 * one, or a lock that stays busy past its retries all return false and write
 * nothing. The lock is the spool's own (spool/lock.ts): holder-identified,
 * steal only from the provably dead, worst case ~100 ms of retries
 * (SPOOL_LOCK_RETRIES × SPOOL_LOCK_RETRY_DELAY_MS) inside budgets that allow
 * for it. writeSessionState stays for the CREATE paths (SessionStart,
 * recovery), which run before any sibling exists.
 */
export const updateSessionState = async (
  home: string,
  hostSessionKey: string,
  transform: (fresh: SessionState) => SessionState | null,
): Promise<boolean> =>
  withSessionStateLock(sessionStateLockPath(home, hostSessionKey), false, async () => {
    const fresh = await readSessionState(home, hostSessionKey);
    if (fresh === null) {
      return false;
    }
    const next = transform(fresh);
    if (next === null) {
      return false;
    }
    await writeSessionState(home, next);
    return true;
  });

/** What a state file is BOUND TO: one repo, on one hub. */
interface SessionBinding {
  readonly repoId: string;
  readonly hubUrl: string;
}

/**
 * Whether a state file on disk describes THIS session's binding. One
 * predicate, because two readers act on it — `withCarriedCapture` decides
 * what a re-fire keeps, and `carriedSeqEpoch` decides what the re-fire's
 * REGISTER may say about it — and a re-fire that carried by one rule and
 * announced by another is exactly the split this pair exists to prevent.
 */
const isSameBinding = (
  previous: SessionState | null,
  binding: SessionBinding,
): previous is SessionState =>
  previous !== null &&
  previous.repoId === binding.repoId &&
  previous.hubUrl === binding.hubUrl;

/**
 * THE EPOCH THE STATE FILE WILL KEEP, answerable BEFORE the register goes out.
 *
 * `registerSessionFlow` has to name an epoch in the register body — that body
 * carries `session.started` at position 0, and an absent field is read as a
 * connector too old for the protocol — but it sends that body BEFORE the state
 * is published, so it used to send the fire's own fresh mint. On a re-fire
 * `withCarriedCapture` then keeps the PREVIOUS epoch, and the two halves
 * disagreed: the wire named an epoch the session does not use.
 *
 * INVISIBLE UNTIL THE FIRST REGISTER FAILS. A hub that already holds the
 * session answers a re-register from its conflict branch and records no second
 * `session.started`, so the foreign epoch never lands. A hub that holds NO row
 * — the first register never reached it: an unreachable hub, a 5xx, a rejected
 * key — takes the CREATE branch and stores `session.started` under it. The
 * session then has two epochs on the hub, `causalOrderOf` answers `broken /
 * epoch_split`, and every happens-before question about it is refused for the
 * rest of its life. `session_events` is append-only and retention is `off`, so
 * nothing removes the row afterwards.
 *
 * NOT THE BUSY-LOCK CASE, which looks similar and is not. There the counter
 * really does restart at 0 beside a fresh epoch, and "not comparable" is the
 * honest answer — see `publishSessionState`. This is the case where nothing
 * restarted: the state file held one epoch the whole time.
 *
 * `minted` is the caller's own fresh epoch, used when there is nothing to
 * carry: no state file, a state file bound elsewhere, or one from before the
 * protocol field (`seqEpoch === null`), which carries a null this cannot send.
 */
export const carriedSeqEpoch = (
  previous: SessionState | null,
  binding: SessionBinding,
  minted: string,
): string =>
  isSameBinding(previous, binding) && previous.seqEpoch !== null
    ? previous.seqEpoch
    : minted;

/**
 * The facts a SessionStart RE-FIRE must not erase (trial findings #17/#18/#20).
 *
 * Claude Code fires SessionStart again inside a LIVE session on compact,
 * resume and clear, and that fire re-creates the state file. Re-creating it is
 * deliberate for the per-fire lists (withBriefingSolvedRefs' header): a new
 * briefing gets a new budget. It is wrong for the CAPTURE counters, which
 * describe the session's work, not one fire's: a session that fired 40 edit
 * tools into nothing and then auto-compacted printed
 * `0 edit-tool fires → 0 targets` and PASSed — erasing exactly the WARN the
 * counters exist to raise, on the line Ken is asked to paste.
 *
 * Carried only when the re-fire is the SAME binding (repo and hub): a state
 * file bound elsewhere is another session's, and the first-wins rule above
 * decides those, not this.
 */
export const withCarriedCapture = (
  state: SessionStateInput,
  previous: SessionState | null,
): SessionStateInput =>
  !isSameBinding(previous, state)
    ? state
    : {
        ...state,
        editToolFires: previous.editToolFires,
        targetsCapturedCount: previous.targetsCapturedCount,
        lastTargetAt: previous.lastTargetAt,
        lastPostToolUseTool: previous.lastPostToolUseTool,
        lastEditedPath: previous.lastEditedPath,
        lastEditedPathResolvedAgainst: previous.lastEditedPathResolvedAgainst,
        foreignRepoDrops: previous.foreignRepoDrops,
        outsideRootDrops: previous.outsideRootDrops,
        hintCandidatesSeen: previous.hintCandidatesSeen,
        // The #17 root cache is the session's, not the fire's: dropping it
        // makes the next tool call pay git again for a root already judged.
        knownWorktreeRoots: previous.knownWorktreeRoots,
        // THE PAIR MOVES TOGETHER OR NOT AT ALL (spec 01 §3.4). The counter
        // alone under the incoming fire's fresh epoch would be harmless; the
        // EPOCH alone beside a counter reset to 0 re-issues positions this
        // session has already handed out, and the hub cannot tell the second
        // `(session, epoch, 3)` from a spool replay of the first. #50 added
        // three counters and forgot this list, which is why both lines here
        // carry a mutation anchor.
        seqEpoch: previous.seqEpoch,
        eventSeq: previous.eventSeq,
        // A SessionStart re-fire lands INSIDE a live session (compact, resume,
        // clear), and a tool may be running across it. Dropping the open
        // windows here would let the next PostToolUse stamp an unbracketed
        // position — the upper bound this list exists to avoid — on an edit
        // whose PreToolUse already paid for a floor. The eviction count comes
        // with them: a counter that resets on every compact cannot say whether
        // the cap is the right size.
        toolWindows: previous.toolWindows,
        toolWindowEvictions: previous.toolWindowEvictions,
        // ...and so does the count of brackets already lost, for the same
        // reason: a number that restarts on every compact cannot say whether
        // this machine is losing them.
        toolWindowMisses: previous.toolWindowMisses,
      };

/**
 * SessionStart's publication: create the state file, or replace one of the
 * SAME session while carrying its capture counters (withCarriedCapture).
 *
 * Under the state file's own lock, because a re-fire lands INSIDE a live
 * session: a PostToolUse can be updating state in the same window, and a
 * read-then-write outside the lock would drop whatever it recorded. A lock
 * that stays busy falls back to the plain create — publishing state is not
 * optional (spool reap infers "no writer left" from its absence), so the
 * counters lose rather than the file.
 */
export const publishSessionState = async (
  home: string,
  state: SessionStateInput,
): Promise<void> => {
  const published = await withSessionStateLock(
    sessionStateLockPath(home, state.hostSessionKey),
    false,
    async () => {
      const previous = await readSessionState(home, state.hostSessionKey);
      await writeSessionState(home, withCarriedCapture(state, previous));
      return true;
    },
  );
  if (!published) {
    await writeSessionState(home, state);
  }
};

/** A block of positions this caller now owns, and the epoch they belong to. */
export interface SeqRange {
  readonly epoch: string;
  readonly from: number;
  readonly count: number;
  /**
   * THE POSITION THE WORK THIS BLOCK RECORDS IS KNOWN TO FOLLOW, when the
   * caller took one before it started. A hook allocates AFTER its tool has
   * returned, so every position in this block is an upper bound on an edit
   * that already happened; the bracket is what turns that upper bound back
   * into an interval a happens-before question may be asked of.
   *
   * Absent means unbracketed, and the hub reads an unbracketed tool-lane
   * position as the upper bound it is rather than promoting a guess.
   */
  readonly after?: number;
}

/**
 * The same block, told where its tool started. Immutable, like every transform
 * here: a new range, never a mutation of the one the allocator handed back.
 */
export const withWindowFloor = (
  range: SeqRange | null,
  floor: number | null,
): SeqRange | null =>
  range === null || floor === null ? range : { ...range, after: floor };

/**
 * HANDS OUT POSITIONS IN THIS SESSION'S CAUSAL ORDER (spec 01 §3.3).
 *
 * `updateSessionState` cannot serve this: it answers `boolean`, and an
 * allocator has to hand the NUMBER back. Everything else is the same
 * discipline — read-transform-write inside the state file's own lock, so
 * MONOTONICITY IS A PROPERTY OF THE LOCK rather than of the caller. Two
 * sibling hooks, an MCP tool and a detached worker can all be inside this
 * function at once; a read-then-write outside the lock gives two of them the
 * same `from`, which is the one thing a causal order may never do (proved
 * against this test: 200 allocations, 100 distinct positions).
 *
 * `count` is allocated as a BLOCK and the counter moves once. A hook that
 * pre-allocates its worst case and then emits fewer records leaves a GAP, and
 * gaps are legal (§3.4) — an allocation whose emitter crashed leaves the same
 * hole by design. Loss lives in the spool `.drops` ledger, never here.
 *
 * NULL IS A FIRST-CLASS ANSWER, not an error: no state file (a worker that
 * outlived SessionEnd's delete), a state file from before this protocol field
 * (`seqEpoch === null`), or a lock that stayed busy past its retries. Every
 * one of them becomes `seq: { reason: "allocation_failed" }` on the envelope —
 * the record still lands, only its POSITION is withheld. Fail-open is the rule
 * on every hook path and this is no exception; worst case is the spool lock's
 * own, SPOOL_LOCK_RETRIES × SPOOL_LOCK_RETRY_DELAY_MS.
 */
export const allocateSeq = async (
  home: string,
  hostSessionKey: string,
  count: number,
): Promise<SeqRange | null> =>
  withSessionStateLock<SeqRange | null>(
    sessionStateLockPath(home, hostSessionKey),
    null,
    async () => {
      const fresh = await readSessionState(home, hostSessionKey);
      if (fresh === null || fresh.seqEpoch === null) {
        return null;
      }
      const from = fresh.eventSeq + 1;
      await writeSessionState(home, { ...fresh, eventSeq: from + count - 1 });
      return { epoch: fresh.seqEpoch, from, count };
    },
  );

/**
 * OPENS THE WINDOW A TOOL IS ABOUT TO RUN IN, in the SAME acquisition that
 * takes the position — a separate read-then-write would let a sibling hook
 * slip between them and record a floor that is not the one it allocated.
 *
 * The entry is appended under the CALLER'S OWN key and carries the position it
 * just consumed — its own, never the oldest. Returns that position, so a caller
 * that wants to know what it paid for can see it; the caller that matters,
 * PreToolUse, does not need it, because the key is what its PostToolUse looks
 * the floor up by. Null is a first-class answer (no state file, no epoch, a
 * lock that stayed busy) and means no entry exists under that key at all, so
 * the close finds no match and sends no bracket — the honest outcome, and the
 * one that made discarding this return value safe.
 *
 * THE LIST IS CAPPED. An entry nothing closes stays, so the oldest falls out
 * at MAX_TOOL_WINDOWS and the eviction is COUNTED: an evicted call that was
 * still running loses its bracket and nothing else, and the count is the only
 * thing that can say whether the cap is too small.
 */
export const openToolWindow = async (
  home: string,
  hostSessionKey: string,
  windowKey: string,
): Promise<number | null> =>
  withSessionStateLock<number | null>(
    sessionStateLockPath(home, hostSessionKey),
    null,
    async () => {
      const fresh = await readSessionState(home, hostSessionKey);
      if (fresh === null || fresh.seqEpoch === null) {
        return null;
      }
      const taken = fresh.eventSeq + 1;
      const appended = [...fresh.toolWindows, { key: windowKey, floor: taken }];
      const evicted = Math.max(0, appended.length - MAX_TOOL_WINDOWS);
      await writeSessionState(home, {
        ...fresh,
        eventSeq: taken,
        toolWindows: appended.slice(evicted),
        toolWindowEvictions: fresh.toolWindowEvictions + evicted,
      });
      return taken;
    },
  );

/**
 * THE FLOOR A TOOL'S OWN WINDOW OPENED ON, or null when this session holds no
 * window under that key: a non-edit tool, a hook installed mid-flight, an open
 * the lock refused, or an entry the cap evicted. Null is what makes the
 * position travel as the upper bound it is.
 *
 * THE OLDEST MATCH, and that is not a detail. The key names ONE call (the
 * host's `tool_use_id`), so more than one entry under it means that one call
 * opened more than once — a double-wired install runs PreToolUse once per
 * wiring — and every entry is then that call's own floor: the oldest is the
 * widest interval the call is entitled to, and the interval only ever widens.
 * The younger floor would be the rule that failed when the key could name two
 * calls: a position allocated between the two opens sits BELOW it, and the hub
 * reads an explanation written while both tools ran as preceding an edit that
 * may have come first. Too early widens the interval and makes the hub refuse;
 * too late lets it answer wrongly, and a position that might be wrong is worse
 * than an absent one. connector-core/test/tool-window-pairing.test.ts proves
 * the rule over pairs — and pins the one thing no close-time rule survives,
 * two DIFFERENT calls under one key with one open refused, which is why the key
 * is the host's id and not a digest of the call.
 */
export const toolWindowFloorFor = (
  state: SessionState,
  windowKey: string,
): number | null =>
  state.toolWindows.find((window) => window.key === windowKey)?.floor ?? null;

/**
 * The list with ONE window of that key gone — a PATCH, not a whole state. Two
 * of PostToolUse's three exits, and PostToolUseFailure's drop path, fold this
 * into an `updateSessionState` transform that is already changing other
 * counters, and a full-state spread there would put every one of them back.
 * Exported because those exits allocate nothing and must still drain the
 * entry: a window left open brackets nothing, since no later call carries its
 * key, but it holds a slot in a capped list until the cap evicts it.
 *
 * THE YOUNGEST MATCH IS THE ONE REMOVED, so the earliest floor under a key
 * survives until every entry under it is closed and `toolWindowFloorFor` keeps
 * answering with it. No match removes nothing: a key this session never opened
 * must not drain a window belonging to something else.
 */
export const closedToolWindow = (
  state: SessionState,
  windowKey: string,
): Pick<SessionState, "toolWindows"> => {
  const last = state.toolWindows.reduce(
    (found, window, index) => (window.key === windowKey ? index : found),
    -1,
  );
  return {
    toolWindows:
      last === -1
        ? state.toolWindows
        : [
            ...state.toolWindows.slice(0, last),
            ...state.toolWindows.slice(last + 1),
          ],
  };
};

/**
 * ALLOCATES A CAPTURE BLOCK AND CLOSES THE TOOL'S OWN WINDOW IN ONE
 * ACQUISITION — the whole of PostToolUse's added cost, unchanged from
 * `allocateSeq`'s.
 *
 * The range comes back carrying the floor THIS tool's PreToolUse recorded, so
 * every record built from it says which window its edit happened in.
 * `windowKey` is null for an emitter that has no window by construction and
 * for a call whose host sent no `tool_use_id`, and a key with no matching
 * entry behaves identically: no bracket, no removal, and then this is
 * `allocateSeq` with a different name.
 *
 * NOT THE MCP-SIDE `allocateToolSeq` (mcp/tools/shared.ts): that one takes a
 * tool context and three arguments, has no window, and is a different function
 * with the same name.
 */
export const allocateToolSeq = async (
  home: string,
  hostSessionKey: string,
  count: number,
  windowKey: string | null,
): Promise<SeqRange | null> =>
  withSessionStateLock<SeqRange | null>(
    sessionStateLockPath(home, hostSessionKey),
    null,
    async () => {
      const fresh = await readSessionState(home, hostSessionKey);
      if (fresh === null || fresh.seqEpoch === null) {
        return null;
      }
      const from = fresh.eventSeq + 1;
      const floor =
        windowKey === null ? null : toolWindowFloorFor(fresh, windowKey);
      await writeSessionState(home, {
        ...fresh,
        eventSeq: from + count - 1,
        ...(windowKey === null ? {} : closedToolWindow(fresh, windowKey)),
      });
      return withWindowFloor({ epoch: fresh.seqEpoch, from, count }, floor);
    },
  );

export interface SessionStateClaim {
  /** True when THIS caller published the state; false when it adopted one. */
  readonly claimed: boolean;
  /** The state on disk after the claim — the caller's or the winner's. */
  readonly state: SessionState;
}

/**
 * Create-if-absent publication for the RECOVERY paths (adversarial review of
 * trial finding #9's race): two state-less hooks racing through recovery —
 * a multi-repo workspace's parallel first touches — must not take turns
 * overwriting the state file, or the session's repo binding flaps and the
 * loser's records reference a work context the hub bound to the winner's
 * repo. Under the state file's own lock: re-read, adopt whatever a sibling
 * published since the caller's read, publish only into absence. The hub
 * call stays OUTSIDE the lock (a register can take seconds; sibling
 * updateSessionState calls must not starve behind it) — only the
 * read-and-publish is serialized, which is all the flap needs.
 *
 * Null means the lock stayed busy: fail open, write nothing, capture
 * nothing this invocation. SessionStart re-fires keep using
 * writeSessionState — re-CREATING the state file there is deliberate
 * (withBriefingSolvedRefs' header).
 */
export const claimSessionState = async (
  home: string,
  state: SessionStateInput,
): Promise<SessionStateClaim | null> =>
  withSessionStateLock<SessionStateClaim | null>(
    sessionStateLockPath(home, state.hostSessionKey),
    null,
    async () => {
      const existing = await readSessionState(home, state.hostSessionKey);
      if (existing !== null) {
        return { claimed: false, state: existing };
      }
      await writeSessionState(home, state);
      return { claimed: true, state: SessionStateObjectSchema.parse(state) };
    },
  );

/** FIFO cap: the oldest targets fall out, the session never grows unbounded. */
export const withSeenTargets = (
  state: SessionState,
  added: readonly string[],
): SessionState => {
  const merged = [...state.seenTargets, ...added];
  return {
    ...state,
    seenTargets:
      merged.length <= MAX_SEEN_TARGETS
        ? merged
        : merged.slice(merged.length - MAX_SEEN_TARGETS),
  };
};

/**
 * The git lane's outcome for one Stop turn: the captured paths folded into
 * the seen-set (so the next turn does not re-record the same file) and the
 * counters moved. `skipped` books the turns the lane never ran, which is the
 * half a PASS-only counter would hide; every other turn is a turn the lane
 * RAN, and is booked whether or not it found anything — a turn that ran and
 * found nothing is the denominator doctor's verdict needs, not a silence.
 */
export const withGitTouches = (
  state: SessionState,
  outcome: { readonly captured: readonly string[]; readonly skipped: boolean },
): SessionState => ({
  ...withSeenTargets(state, outcome.captured),
  gitTouchCount: state.gitTouchCount + outcome.captured.length,
  gitLaneSkipped: state.gitLaneSkipped + (outcome.skipped ? 1 : 0),
  gitLaneRan: state.gitLaneRan + (outcome.skipped ? 0 : 1),
});

/**
 * One delivered hint, remembered forever within the session: the ref for the
 * seen-set and the cap, the body hash (substance only — pointers carry no
 * body) for the echo-loop exclusion. No cap on these arrays beyond
 * MAX_HINTS_PER_SESSION itself, which the selector enforces before any append.
 */
export const withDeliveredHint = (
  state: SessionState,
  refId: string,
  bodyHash: string | null,
): SessionState => ({
  ...state,
  deliveredHintRefs: [...state.deliveredHintRefs, refId],
  deliveredHintHashes:
    bodyHash === null
      ? state.deliveredHintHashes
      : [...state.deliveredHintHashes, bodyHash],
});

/**
 * Briefing solved pointers, appended once per SessionStart fire. PER-FIRE,
 * not cumulative: a re-fire (resume/clear, same session id) re-CREATES the
 * state file with the schema defaults (hooks/session-start.ts
 * writeSessionState) — this list starts empty again, exactly like
 * deliveredHintRefs and the session cap beside it, and is repopulated with
 * what THAT fire's briefing showed. Dedup (a re-pointed tree is one fact)
 * and the FIFO cap are the transform's own defensive bounds, the
 * withSeenTargets shape — not cross-fire bookkeeping.
 */
export const withBriefingSolvedRefs = (
  state: SessionState,
  refIds: readonly string[],
): SessionState => {
  const merged = [...new Set([...state.briefingSolvedRefs, ...refIds])];
  return {
    ...state,
    briefingSolvedRefs:
      merged.length <= MAX_BRIEFING_SOLVED_REFS
        ? merged
        : merged.slice(merged.length - MAX_BRIEFING_SOLVED_REFS),
  };
};

/**
 * FIFO cap, same shape as withTripwireAsked: the hub is asked about one
 * fingerprint once per session. Dedup on merge, because the caller's
 * check-and-set may re-enter with the same value from a racing hook.
 */
export const withProbedFingerprint = (
  state: SessionState,
  fingerprint: string,
): SessionState => {
  const merged = [...new Set([...state.probedFingerprints, fingerprint])];
  return {
    ...state,
    probedFingerprints:
      merged.length <= MAX_PROBED_FINGERPRINTS
        ? merged
        : merged.slice(merged.length - MAX_PROBED_FINGERPRINTS),
  };
};

/**
 * Remembers a resolved worktree root → repoId for the session (trial finding
 * #17), so the per-tool capture path never resolves the same root's identity
 * twice. Dedup by root (a cache, not a log — a re-resolution replaces the old
 * answer) and FIFO-capped at MAX_KNOWN_WORKTREE_ROOTS, the withSeenTargets
 * shape. A foreign root is remembered under its own repoId, so a repeated
 * foreign touch is free after the first. An UNRESOLVABLE root is remembered
 * as null WITH the attempts spent on it, which is what lets the resolver
 * retry it a bounded number of times instead of treating one missed git
 * deadline as a permanent verdict.
 */
export const withKnownWorktreeRoot = (
  state: SessionState,
  root: string,
  repoId: string | null,
  attempts = 1,
  /**
   * The checkout this answer was read from (capture/touched-root.ts). Null
   * means "unknowable here", which is what an unstamped entry from an older
   * state file and a root whose `.git` could not be stat'd both look like.
   */
  stamp: string | null = null,
): SessionState => {
  const withoutRoot = state.knownWorktreeRoots.filter(
    (entry) => entry.root !== root,
  );
  const merged = [...withoutRoot, { root, repoId, attempts, stamp }];
  return {
    ...state,
    knownWorktreeRoots:
      merged.length <= MAX_KNOWN_WORKTREE_ROOTS
        ? merged
        : merged.slice(merged.length - MAX_KNOWN_WORKTREE_ROOTS),
  };
};

/** FIFO cap, same shape as withSeenTargets: asks are once per file. */
/** Remembers a landed-change stop on `file`, same FIFO cap as the live one. */
export const withLandedAsked = (
  state: SessionState,
  file: string,
): SessionState => {
  const merged = [...state.landedAskedFiles, file];
  return {
    ...state,
    landedAskedFiles:
      merged.length <= MAX_TRIPWIRE_ASKED_FILES
        ? merged
        : merged.slice(merged.length - MAX_TRIPWIRE_ASKED_FILES),
  };
};

export const withTripwireAsked = (
  state: SessionState,
  file: string,
): SessionState => {
  const merged = [...state.tripwireAskedFiles, file];
  return {
    ...state,
    tripwireAskedFiles:
      merged.length <= MAX_TRIPWIRE_ASKED_FILES
        ? merged
        : merged.slice(merged.length - MAX_TRIPWIRE_ASKED_FILES),
  };
};

/**
 * An intent reached the hub or the spool (VISION.md §3): remember the
 * sentence and book the ghost-check debt in ONE transform, because they are
 * one fact — a plan the team has not been compared against yet. Re-declaring
 * an intent re-opens the debt on purpose; the new sentence is a new plan, and
 * the per-session fire cap is what stops that from becoming a second model
 * call (ghost/gate.ts owns the cap).
 */
export const withRecordedIntent = (
  state: SessionState,
  summary: string,
): SessionState => ({
  ...state,
  workContextIntent: summary,
  ghostPending: true,
});

/** A deterministic ghost notice was SHOWN — booked by whoever emitted it. */
export const withGhostNotices = (
  state: SessionState,
  shown: number,
): SessionState =>
  shown <= 0
    ? state
    : { ...state, ghostNoticeCount: state.ghostNoticeCount + shown };

/**
 * The LIVE session states of one repo+hub, in one bounded scan (at most
 * STATUS_MAX_SESSION_STATES files — more live sessions than that on one
 * machine is not a cost question any more).
 *
 * ONE SCAN, not one per counter, and that is the whole reason this exists.
 * `crosscheck status` and `doctor` each print three model-cost lines — the
 * summarizer, the derived intent and the ghost check — and every one of them
 * used to readdir and re-parse the same directory. Three passes over the same
 * files on a surface a human runs by hand is the shape of the problem, not a
 * constant to tune; each cost module now SUMS states it is handed, and this
 * is the only place that reads them.
 *
 * NEWEST FIRST AND LIVE ONLY, which is the other half of "one place". The
 * scan this replaced took `readdir` order — neither alphabetical nor
 * chronological — sliced the first N and reduced: on the trial machine that
 * read an arbitrary 50 of 100 files and printed `13 runs (1 NONE, 2 drafts) …
 * across 50 live sessions` where the full set said 27/3/3, and 75 of those
 * files belonged to sessions killed hours earlier. Sorting by mtime before the
 * bound (state/session-scan.ts) and skipping files whose session stopped
 * heartbeating fixes both, once, for all three cost surfaces — and the
 * `filesSeen`/`filesRead`/`staleSkipped` counters let a line say "N of M"
 * instead of implying it read everything.
 *
 * Fail open like every read on a status path: an unreadable directory is an
 * empty scan, and a state file that does not parse is counted and skipped
 * rather than costing the scan.
 */
export interface LiveSessionScan {
  /** Live states of this repo+hub, newest-written first. */
  readonly states: readonly SessionState[];
  /** Session-state files that EXIST — the denominator of "N of M". */
  readonly filesSeen: number;
  /** Files this bounded scan actually opened. */
  readonly filesRead: number;
  /** Files skipped because their session stopped heartbeating. */
  readonly staleSkipped: number;
  /** Files that would not parse — counted, never silently dropped. */
  readonly parseFailures: number;
}

const EMPTY_SCAN: LiveSessionScan = {
  states: [],
  filesSeen: 0,
  filesRead: 0,
  staleSkipped: 0,
  parseFailures: 0,
};

export const readLiveSessionStates = async (
  home: string,
  hubUrl: string,
  repoId: string,
  now: Date = new Date(),
): Promise<LiveSessionScan> => {
  const listing = await listSessionStateFiles(home, STATUS_MAX_SESSION_STATES);
  if (listing.filesSeen === 0) {
    return EMPTY_SCAN;
  }
  const parsed = await Promise.all(
    listing.files.map(async (file) => ({
      // The mtime travels with the parse: a session's silence is measured off
      // its own file's last write as well as its heartbeat (session-scan.ts).
      mtimeMs: file.mtimeMs,
      result: SessionStateSchema.safeParse(await readJsonOrNull(file.path)),
    })),
  );
  const states: SessionState[] = [];
  let staleSkipped = 0;
  for (const entry of parsed) {
    if (!entry.result.success) {
      continue;
    }
    const state = entry.result.data;
    if (state.hubUrl !== hubUrl || state.repoId !== repoId) {
      continue;
    }
    const ageMs = sessionSilentForMs(state, entry.mtimeMs, now.getTime());
    if (ageMs !== null && ageMs > STALE_SESSION_STATE_MS) {
      // Counted, not dropped: "3 stale skipped" is the number that would
      // have told the trial its cost lines were reading corpses.
      staleSkipped += 1;
      continue;
    }
    states.push(state);
  }
  return {
    states,
    filesSeen: listing.filesSeen,
    filesRead: listing.files.length,
    staleSkipped,
    parseFailures: parsed.filter((entry) => !entry.result.success).length,
  };
};

export interface DeriveSessionStateInput {
  readonly hostSessionKey: string;
  readonly repoId: string;
  readonly repoRoot: string;
  readonly hubUrl: string;
  readonly developerId: string | null;
  readonly startedAt: string;
}

/**
 * Fallback for hooks that run without a state file (crash, or hooks installed
 * mid-session). The deterministic ids make this identical to what SessionStart
 * would have written.
 */
export const deriveSessionState = (
  input: DeriveSessionStateInput,
): SessionState => {
  const crosscheckSessionId = crosscheckSessionIdFor(input.hostSessionKey);
  return {
    hostSessionKey: input.hostSessionKey,
    crosscheckSessionId,
    workContextId: workContextIdFor(crosscheckSessionId),
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    hubUrl: input.hubUrl,
    developerId: input.developerId,
    startedAt: input.startedAt,
    lastHeartbeatAt: null,
    seenTargets: [],
    deliveredHintRefs: [],
    deliveredHintHashes: [],
    tripwireAskedFiles: [],
    landedAskedFiles: [],
    briefingSolvedRefs: [],
    probedFingerprints: [],
    foreignRepoDrops: 0,
    outsideRootDrops: 0,
    knownWorktreeRoots: [],
    editToolFires: 0,
    targetsCapturedCount: 0,
    lastTargetAt: null,
    lastPostToolUseTool: null,
    lastEditedPath: null,
    lastEditedPathResolvedAgainst: null,
    hintCandidatesSeen: 0,
    briefingPending: false,
    stopTurnCount: 0,
    summarizerFireCount: 0,
    summarizerLastFireTurn: null,
    summarizerEstimatedTokens: 0,
    summarizerNoneCount: 0,
    summarizerDraftCount: 0,
    summarizerFailCount: 0,
    summarizerLastFailure: null,
    summarizerRejectCount: 0,
    summarizerNoSliceCount: 0,
    summarizerLastNoSlice: null,
    summarizerLastSliceShape: null,
    summarizerSliceDroppedChars: 0,
    summarizerLastRejection: null,
    summarizerUnreadableCount: 0,
    summarizerLastUnreadable: null,
    workContextTitle: null,
    workContextStatus: null,
    intentFireCount: 0,
    intentNoneCount: 0,
    intentSetCount: 0,
    intentFailCount: 0,
    intentLastFailure: null,
    workContextIntent: null,
    ghostPending: false,
    gitTouchCount: 0,
    gitLaneSkipped: 0,
    gitLaneRan: 0,
    ghostNoticeCount: 0,
    ghostFireCount: 0,
    ghostNoOverlapCount: 0,
    ghostNoHubAnswerCount: 0,
    ghostNoneCount: 0,
    ghostDraftCount: 0,
    ghostFailCount: 0,
    ghostLastFailure: null,
    // A RECOVERY IS A CREATE, so it mints its own epoch exactly as
    // SessionStart does — a derived state with a null epoch would leave every
    // record of every recovered session unsequenced, silently. This function
    // enumerates every field by hand, so a field added to the schema tail and
    // not here is absent from every recovered session and nothing says so.
    seqEpoch: crypto.randomUUID(),
    eventSeq: 0,
    toolWindows: [],
    toolWindowEvictions: 0,
    toolWindowMisses: 0,
  };
};
