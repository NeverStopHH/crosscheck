import { z } from "zod";

import {
  MAX_BRIEFING_SOLVED_REFS,
  MAX_KNOWN_WORKTREE_ROOTS,
  MAX_SEEN_TARGETS,
  MAX_TRIPWIRE_ASKED_FILES,
} from "../constants.ts";
import {
  readJsonOrNull,
  removeFile,
  sessionStatePath,
  writePrivateFile,
} from "../config/paths.ts";
import { withLock } from "../spool/lock.ts";

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
   * Work contexts the SessionStart briefing already pointed at as "solved
   * before" (VISION.md §1). A SEPARATE list from deliveredHintRefs on
   * purpose: the prompt path folds these into its seen-set so the same tree
   * is never re-pointed, but they must not spend the 5/session hint cap —
   * a briefing pointer is the briefing's budget, not the prompt path's.
   */
  briefingSolvedRefs: z.array(z.string().min(1)).default([]),
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
   * `attempts` existed reads as one attempt spent.
   */
  knownWorktreeRoots: z
    .array(
      z.object({
        root: z.string().min(1),
        repoId: z.string().min(1).nullable(),
        attempts: z.number().int().min(1).default(1),
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
});

/**
 * The read schema: the object schema behind a preprocess that folds the
 * legacy key. Writers never need the fold — they pass `hostSessionKey`.
 */
export const SessionStateSchema = z.preprocess(
  foldLegacySessionKey,
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

const sessionStateLockPath = (home: string, hostSessionKey: string): string =>
  `${sessionStatePath(home, hostSessionKey)}.lock`;

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
  withLock(sessionStateLockPath(home, hostSessionKey), false, async () => {
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
  previous === null ||
  previous.repoId !== state.repoId ||
  previous.hubUrl !== state.hubUrl
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
  const published = await withLock(
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
  withLock<SessionStateClaim | null>(
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
): SessionState => {
  const withoutRoot = state.knownWorktreeRoots.filter(
    (entry) => entry.root !== root,
  );
  const merged = [...withoutRoot, { root, repoId, attempts }];
  return {
    ...state,
    knownWorktreeRoots:
      merged.length <= MAX_KNOWN_WORKTREE_ROOTS
        ? merged
        : merged.slice(merged.length - MAX_KNOWN_WORKTREE_ROOTS),
  };
};

/** FIFO cap, same shape as withSeenTargets: asks are once per file. */
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
    briefingSolvedRefs: [],
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
  };
};
