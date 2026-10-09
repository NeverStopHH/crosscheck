/**
 * PreToolUse tripwire (DESIGN.md §4, ask-mode): an Edit/Write to a file that
 * an ACTIVE teammate session has targeted, or that a teammate's LANDED change
 * touched (docs/1.0/landed-changes.md), gets a permission "ask" with a
 * factual reason — never more.
 *
 * TWO QUESTIONS, ONE STOP. The live half asks the hub who is working on the
 * file right now. The landed half asks the reader's own clone which
 * teammate commits to the file have landed on a landing branch — missing
 * from this checkout at any age, or already in it and recent — and needs no
 * hub at all: a clone is the authority on what it contains, so a dead hub
 * costs the live half and never the landed one. Both run in parallel and
 * both fail open. Each reason has its own once-per-file marker: a file stops
 * a session at most once per reason, and when both apply at once it is ONE
 * stop that says both — so a landed-change stop never uses up the live one
 * for a teammate who starts on the file later.
 *
 * THE LADDER STOPS AT "ask" STRUCTURALLY: this module contains exactly one
 * permission decision literal, `ASK_DECISION`, and every other branch returns
 * silence. There is no code path that could emit a deny, and
 * test/tripwire-hook.test.ts plus a mutation-check entry hold that shut.
 *
 * Everything reused, nothing re-invented: the hot-file denylist, the
 * generated-target rule and the repo-relative path logic are PostToolUse's
 * own (capture/denylist.ts, capture/generated.ts, hooks/post-tool-use.ts), the
 * self/own-worktree exclusion is the hub's
 * developer-id filter on the tripwire endpoint, and "active" is the presence
 * TTL the presence endpoint applies. One bounded hub call, one ask per file
 * per session (state file), fail-open everywhere.
 *
 * HEADLESS SESSIONS (trial Q2, settled empirically on Claude Code 2.1.237 with
 * real `claude -p` runs against a throwaway hub): a session that cannot show a
 * permission prompt — `claude -p`, an Agent-SDK subagent — turns a hook "ask"
 * into a ONE-SHOT DENY of that tool call in EVERY permission mode
 * (acceptEdits, default+allowedTools, auto, bypassPermissions, dontAsk), no
 * hang, no PermissionRequest hook; the `permissionDecisionReason` reaches the
 * model verbatim as an is_error tool_result, and the next identical edit
 * passes because of the ask-once marker below.
 *
 * There is no TRUSTWORTHY per-hook signal for headless, which is not the same
 * as no signal — stated MEASURED so nobody "fixes" this by auto-detecting: a
 * `claude -p` whose caller left CLAUDE_CODE_ENTRYPOINT unset hands the hook
 * `sdk-cli`, but a caller-supplied value survives verbatim — the same headless
 * run reported `sdk-cli` and `claude-vscode` depending only on the spawn env
 * (probe V7 vs V8). Orchestration subagents are spawned FROM a Claude Code
 * session, so the parent's interactive value is exactly what leaks in and the
 * marker would read "interactive" in the one shape a detection exists for.
 * stdin is a pipe in interactive sessions too, and the payload carries no
 * flag. So the fallback is an explicit knob:
 * CROSSCHECK_TRIPWIRE=notice emits `additionalContext` ONLY (the ladder's
 * notice rung, DESIGN §4) — briefed, never blocked. `additionalContext` is
 * emitted in BOTH modes (trial finding #25): it is the one field that reaches
 * the MODEL on an ask, and the live hooks reference documents it for
 * PreToolUse (scripts/hook-contract-watch.ts probes it).
 *
 * The edited file's id resolves against the root that governs the FILE
 * (capture/touched-root.ts, trial finding #17): an edit in a linked worktree
 * of the same repo trips the wire; before, it resolved to null against the
 * session's checkout and the wire stayed silent.
 *
 * THE PERSON IS TOLD TOO (pilot, 2026-10-07: every collision reached an
 * agent's context and no person). The first live hit on a teammate's work
 * context in a session adds a top-level `systemMessage` — the hooks
 * reference's "Warning message shown to the user", the one field that reaches
 * the person in both modes and on every platform — rendered by core
 * hints/collision-notice.ts from the same projected row the ask is built
 * from, and ONE renderer-owned sentence at the end of `additionalContext`
 * asking the agent to say it in its next reply. Once per (teammate, work
 * context) per session, claimed inside the same locked transform as the ask's
 * own marker, so it costs no lock round of its own. A hit inside a SUBAGENT
 * (`agent_id` on the payload) is also QUEUED for the main thread's next
 * UserPromptSubmit (hooks/user-prompt-submit.ts): the docs promise nothing
 * about where a subagent hook's `systemMessage` shows, and the subagent's
 * context is not the conversation the person reads.
 */
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeniedUnlessAuthoritative, resolveDenylist } from "@crosscheck/connector-core/capture/denylist.ts";
import { classifyGenerated, wireGeneratedSignal } from "@crosscheck/connector-core/capture/generated.ts";
import type { GeneratedClassification } from "@crosscheck/connector-core/capture/generated.ts";
import {
  isAuthoritative,
  readAuthoritativeGenerated,
} from "@crosscheck/connector-core/capture/authoritative-generated.ts";
import type { AuthoritativeGenerated } from "@crosscheck/connector-core/capture/authoritative-generated.ts";
import { extractFilePaths, isEditTool } from "../capture/tool-events.ts";
import { getTripwireSessions } from "@crosscheck/connector-core/http/hub.ts";
import type { TripwireSession } from "@crosscheck/connector-core/http/hub.ts";
import type { CoverageRecord } from "@crosscheck/connector-core/http/coverage.ts";
import {
  UNKNOWN_DEVELOPER_ID,
  hintDeliveryRecord,
  landedStopRecord,
} from "@crosscheck/connector-core/capture/records.ts";
import type { Producer } from "@crosscheck/connector-core/capture/records.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import { renderEditWarning } from "@crosscheck/connector-core/hints/render.ts";
import { appendOutcomeClause } from "@crosscheck/connector-core/hints/outcome-clause.ts";
import {
  COLLISION_RELAY_SENTENCE,
  renderCollisionNotices,
  tripwireCollision,
} from "@crosscheck/connector-core/hints/collision-notice.ts";
import {
  isTripwireFresh,
  newCollisionKeys,
  openToolWindow,
  readSessionState,
  updateSessionState,
  withCollisionNotices,
  withKnownWorktreeRoot,
  withLandedAsked,
  withLandedClean,
  withQueuedCollisionRelays,
  withOverdueRest,
  withTripwireAsked,
  withTripwireChecked,
  withTripwireGroupAsked,
  withoutCollisionNotices,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { CollisionNotice, SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { recordRestOmission } from "@crosscheck/connector-core/state/rest-omissions.ts";
import { toolWindowKey } from "@crosscheck/connector-core/state/tool-window-key.ts";
import { resolveTouchedRoots } from "@crosscheck/connector-core/capture/touched-root.ts";
import { toRepoRelative } from "@crosscheck/connector-core/capture/target-paths.ts";
import { aPersonReads, resolveTripwireMode } from "@crosscheck/connector-core/config/tripwire.ts";
import { probeLandedChanges, worthStopping } from "@crosscheck/connector-core/landed-changes/probe.ts";
import type {
  LandedChanges,
  LandedProbe,
  LandedProbeCutShort,
} from "@crosscheck/connector-core/landed-changes/probe.ts";
import { bookLandedProbeCut } from "@crosscheck/connector-core/state/landed-probe-cuts.ts";
import { resolveTimeZone } from "@crosscheck/connector-core/landed-changes/working-days.ts";
import { TRIPWIRE_MODE_NOTICE } from "@crosscheck/connector-core/constants.ts";
import type { LandedContextAnswer, LandedToldAuthor } from "@crosscheck/connector-core/http/hub.ts";
import { cutWellFormed } from "@crosscheck/connector-core/briefing/cut.ts";
import { namedLandedCommits } from "@crosscheck/connector-core/landed-changes/named-commits.ts";
import { LANDED_STOP_MAX_SUBJECT_CHARS, LandedStopSchema, containsSecret } from "@crosscheck/schema";
import { NO_LANDED_ANSWER, landedWhyFor } from "./landed-why.ts";
import { requestLandingFetchFor } from "./landing-fetch.ts";
import { onePerKey, recheckOverdueRests } from "./rest-recheck.ts";
import type { HookBudget, HookContext } from "./runner.ts";

/** The ONLY decision this connector can emit — the ladder's ceiling (§4). */
const ASK_DECISION = "ask";

/**
 * The edited file's repo-relative id, resolved against the root that governs
 * the FILE (trial finding #17): PostToolUse's own resolution, so an edit in a
 * linked worktree of the same repo trips the wire instead of resolving to null
 * against the session's checkout. A newly-resolved worktree root is persisted
 * to the session-state cache so pre- and post-tool-use never pay git twice for
 * it (hook budgets are binding).
 */
interface EditedFile {
  /** Repo-relative, as git and the hub name it. */
  readonly file: string;
  /** The root of the worktree the file lives in — where git is asked. */
  readonly root: string;
  /**
   * A generated file the repo's own rule keeps as evidence (declared in
   * `authoritativeGenerated`, or a contract or migration): the hub is told,
   * so its path signal does not answer "nobody" for it.
   */
  readonly authoritative?: boolean;
}

const resolveEditedFile = async (
  ctx: HookContext,
  state: SessionState,
): Promise<EditedFile | null> => {
  const [first] = extractFilePaths(ctx.payload.tool_input);
  if (first === undefined) {
    return null;
  }
  const resolution = await resolveTouchedRoots({
    paths: [first],
    cwd: ctx.payload.cwd,
    sessionRepoRoot: state.repoRoot,
    sessionRepoId: state.repoId,
    identityRoot: ctx.identity.root,
    identityRepoId: ctx.identity.repoId,
    knownWorktreeRoots: state.knownWorktreeRoots,
  });
  if (resolution.newlyResolved.length > 0) {
    await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) =>
      resolution.newlyResolved.reduce(
        (next, entry) =>
          withKnownWorktreeRoot(
            next,
            entry.root,
            entry.repoId,
            entry.attempts,
            entry.stamp,
          ),
        fresh,
      ),
    );
  }
  const root = resolution.rootByPath.get(first);
  const file = root === undefined ? null : await toRepoRelative(root, ctx.payload.cwd, first);
  return root === undefined || file === null ? null : { file, root };
};

/** Neighbours one edit hands the attribute call: a directory's worth, never a tree. */
const MAX_EDIT_NEIGHBOURS = 64;

/**
 * The edited file's neighbours — the other files in its directory,
 * repo-relative — which the classification's `check-attr` answers in the same
 * call when the file misses the cache (batch-2 review, M6): agents edit a
 * directory's files one after another, and each of those edits is then a
 * cache hit instead of a git spawn on this hook's critical path.
 */
const neighboursOf = async (edited: EditedFile): Promise<readonly string[]> => {
  const dir = dirname(edited.file);
  const entries = await readdir(join(edited.root, dir), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => (dir === "." ? entry.name : `${dir}/${entry.name}`))
    .filter((path) => path !== edited.file)
    .slice(0, MAX_EDIT_NEIGHBOURS);
};

/** The edited file as the generated-target rule classifies it — the rule capture applies. */
const classifyEditedFile = async (
  home: string,
  edited: EditedFile,
  declared: AuthoritativeGenerated,
): Promise<GeneratedClassification> => {
  const prefetch = await neighboursOf(edited);
  const classified = await classifyGenerated({ home, root: edited.root, paths: [edited.file], authoritative: declared, prefetch });
  return classified.get(edited.file) ?? "unknown";
};

/** What one edit's own tripwire found to say: the ask's reason, and the groups its person is told of. */
interface EditAnswer {
  readonly reason: string | null;
  readonly notices: readonly CollisionNotice[];
}

const NO_EDIT_ANSWER: EditAnswer = { reason: null, notices: [] };

const askBeforeEdit = async (ctx: HookContext, budget: HookBudget): Promise<EditAnswer> => {
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    return NO_EDIT_ANSWER;
  }
  // OPENS THE WINDOW THIS TOOL'S EDIT WILL HAPPEN IN — before the tripwire
  // work, because the bracket is about the TOOL and must not depend on whether
  // a teammate happens to overlap the file, whether the denylist covers it, or
  // whether the hub answers. PostToolUse allocates once the tool has RETURNED,
  // so without this its position is an upper bound on an edit already on disk
  // and an MCP call that raced the hook is ordered BEFORE a change that came
  // first — `predeclared`, the value that exonerates, from a coin flip.
  //
  // UNDER THIS CALL'S OWN KEY, which is what makes the window THIS call's.
  // The key is the host's `tool_use_id` (core state/tool-window-key.ts): the
  // one thing both hooks of a call are handed and no other call is.
  // PostToolUse looks the floor up by that key and closes that entry, never
  // the oldest one open — and never an identical twin's, which a digest of
  // `tool_name` + `tool_input` could not tell apart.
  //
  // THE RETURN VALUE IS DISCARDED, and with a key that names one call that is
  // finally honest. A refused open (busy lock, or no state file yet on a hook
  // installed mid-flight) writes NO entry, so this call's PostToolUse finds no
  // match and sends no bracket — the hub reads the upper bound it has and
  // refuses. A payload with no id opens nothing at all, for the same reason.
  //
  // ONE acquisition, and the only new cost on this hook. It is the same lock
  // the tripwire marker below takes, an order of magnitude under the hub call
  // this hook already makes.
  const windowKey = toolWindowKey(
    ctx.payload.tool_name,
    ctx.payload.tool_use_id,
  );
  if (windowKey !== null) {
    await openToolWindow(ctx.config.home, ctx.payload.session_id, windowKey);
  }
  const edited = await resolveEditedFile(ctx, state);
  if (edited === null) {
    return NO_EDIT_ANSWER;
  }
  const { file } = edited;
  // Hot files drown real overlap signal — the same denylist capture applies,
  // with the same exception: an authoritative file (declared by the repo, or a
  // contract or migration) passes the generated-output entries
  // (capture/denylist.ts).
  const declared = await readAuthoritativeGenerated(edited.root);
  const patterns = resolveDenylist(ctx.config.denylist ?? undefined);
  if (isDeniedUnlessAuthoritative(file, patterns, isAuthoritative(file, declared))) {
    return NO_EDIT_ANSWER;
  }
  // One stop per file per session for the LANDED reason, and one per (file,
  // teammate work context) for the LIVE one (review M4): a teammate who starts
  // on a file already asked about is new on it, so the live question is asked
  // of the hub again — the one bounded call an unasked file always cost — and
  // only the landed probe is skipped once it was answered. Not on EVERY edit
  // (round 2, L1): within TRIPWIRE_RECHECK_TTL_MS of an answer this session
  // fully dealt with, the next edit of the file asks nothing and writes
  // nothing.
  const askedLanded = state.landedAskedFiles.includes(file);
  const isLiveFresh = isTripwireFresh(state, file, ctx.now());
  const probing = startLandedProbe(ctx, edited, askedLanded, state.landedCleanKeys);
  // A mechanically generated, non-authoritative file is skipped exactly as a
  // denied one: a lockfile or a regenerated client is not anybody's plan
  // (capture/generated.ts). Asked the way capture asks, so the attribute
  // answer this pays for is the cached one this edit's PostToolUse reads —
  // one `check-attr` per path, not two. An UNKNOWN answer is not generated,
  // and an AUTHORITATIVE one stays evidence: the wire is asked as before.
  const classification = await classifyEditedFile(ctx.config.home, edited, declared);
  if (wireGeneratedSignal(classification) !== undefined) {
    return NO_EDIT_ANSWER;
  }
  const found = await findReasons(
    ctx,
    budget,
    { ...edited, authoritative: classification === "authoritative" },
    { askedLanded, isLiveFresh },
    probing,
  );
  if (found.cleanKey !== null && !state.landedCleanKeys.includes(found.cleanKey)) {
    await rememberClean(ctx, found.cleanKey);
  }
  const answer = await stopFor(ctx, budget, state, file, found);
  // A cut check is booked once the stop is decided and claimed, never before
  // it: the claim stays the step right after the one request (the lock
  // allowance), and what is left of the budget after the why still holds the
  // reserve, an order of magnitude over one lock round and one append.
  if (found.probeCut !== null) {
    await bookProbeCut(ctx, found.probeCut);
  }
  return answer;
};

/** The stop and the person's line the found reasons make, claimed and recorded — NO_EDIT_ANSWER when none. */
const stopFor = async (
  ctx: HookContext,
  budget: HookBudget,
  state: SessionState,
  file: string,
  found: FoundReasons,
): Promise<EditAnswer> => {
  if (found.sessions.length === 0 && found.landed === null) {
    return NO_EDIT_ANSWER;
  }
  const groups = onePerKey(found.sessions.map((session) => tripwireCollision(session, file, found.coverage)));
  const claim = await claimStop(ctx, budget, { file, sessions: found.sessions, groups }, found.landed);
  // A sibling hook may have booked both reasons: then there is no ask to
  // state and no why to wait for — but a teammate group untold so far is
  // still told.
  const { won } = claim;
  const reason = won.teammate === null && won.landed === null ? null : await statedReason(ctx, state, file, found, won);
  return { reason, notices: claim.told };
};

/**
 * The ask's reason for the reasons this call WON, and the records that go
 * with it. The reason states what a teammate is doing and what landed; the
 * record states how far the archive the live claim came from reaches (03
 * §5.1). It annotates only on a positively observed gap, so an un-upgraded
 * hub leaves the live lines byte-identical to what they were. Only a WON
 * landed stop waits for its why (already under way since git answered); the
 * hook's process ends a why nobody waits for.
 */
const statedReason = async (
  ctx: HookContext,
  state: SessionState,
  file: string,
  found: FoundReasons,
  won: Reasons,
): Promise<string> => {
  const answer = won.landed === null ? NO_LANDED_ANSWER : await found.why;
  // Recorded BEFORE it is rendered: a name the stop prints is a name the hub
  // will tell (step 4, decision 11), so only what reached the spool is said.
  const told =
    won.landed === null || !mayTellAuthors(ctx, state)
      ? []
      : await recordLandedStop(ctx, state, file, won.landed, answer.told);
  const warning = renderEditWarning({
    live: won.teammate,
    landed: won.landed,
    file,
    now: ctx.now(),
    ...(found.coverage === undefined ? {} : { coverage: found.coverage }),
    why: answer.matches,
    told,
  });
  // 07 §13 (D-O3): the live half is a tripwire-channel delivery of the
  // teammate's context, so where the repo records outcomes the ask ends with
  // the clause naming that context. Only the LIVE half — the landed half is
  // no delivery (recordLandedStop) and has nothing to name.
  const reason =
    won.teammate !== null && found.recordsOutcomes
      ? appendOutcomeClause(warning, won.teammate.workContextId)
      : warning;
  if (won.teammate !== null) {
    await recordTripwireAsk(ctx, state, won.teammate);
  }
  return reason;
};

/** One live answer for one file, as the person's half of the hook takes it. */
interface LiveAnswer {
  readonly file: string;
  readonly sessions: readonly TripwireSession[];
  readonly groups: readonly CollisionNotice[];
}

/** Whether every teammate session this answer named on the file has been asked about. */
const isAllAsked = (state: SessionState, answer: LiveAnswer): boolean =>
  answer.sessions.every((session) => (state.tripwireAskedGroups ?? []).includes(liveAskKey(answer.file, session)));

/** The collision fields a tell can change: nothing to write when none of them did. */
const collisionFieldsOf = (state: SessionState): string =>
  JSON.stringify([state.collisionNotices, state.collisionRelayQueue, state.collisionRelayDropped, state.tripwireCheckedFiles]);

export const handlePreToolUse = async (ctx: HookContext, budget: HookBudget): Promise<string> => {
  if (!isEditTool(ctx.payload.tool_name)) {
    return "";
  }
  // An edit also asks for the background fetch of the landing branches
  // (hooks/landing-fetch.ts): an agent can work for an hour on one prompt,
  // and the stop only sees what the clone has fetched. Beside the stop, not
  // before it — the fetch serves the NEXT edit and must cost this one nothing.
  // And beside it too, the rechecks other files' rests still owe once their
  // rest is over (round 3, F-M2; hooks/rest-recheck.ts): a turn that ran past
  // a rest without ending pays it at its next edit, not never.
  const [answer, swept] = await Promise.all([
    askBeforeEdit(ctx, budget),
    recheckOverdueRests(ctx, budget, PRE_TOOL_USE_HOOK, extractFilePaths(ctx.payload.tool_input)[0]),
    requestLandingFetchFor(ctx),
  ]);
  const notices = [...answer.notices, ...swept];
  return answer.reason === null && notices.length === 0
    ? ""
    : askOutput(ctx, answer.reason, notices.length === 0 ? null : renderCollisionNotices(notices, ctx.now()));
};

/** This hook, as the loss ledger names it. */
const PRE_TOOL_USE_HOOK = "pre-tool-use";

interface Reasons {
  readonly teammate: TripwireSession | null;
  readonly landed: LandedChanges | null;
}

interface FoundReasons {
  /** EVERY live teammate session the hub named on the file, in its order (review M4). */
  readonly sessions: readonly TripwireSession[];
  readonly landed: LandedChanges | null;
  readonly coverage?: CoverageRecord;
  /** The tripwire answer said this repo records hint outcomes (07 §13); false when it did not answer. */
  readonly recordsOutcomes: boolean;
  /** The probe answered "nothing" under this key (landed-changes/probe.ts). */
  readonly cleanKey: string | null;
  /** Why the probe could not say all it would have, or null (bookProbeCut). */
  readonly probeCut: LandedProbeCutShort | null;
  /**
   * The hub's why for the landed half, asked the moment GIT answered — not
   * after the live tripwire's hub call too, which is what leaves it room on
   * a hub across a network (hooks/landed-why.ts) — and who the stop tells.
   * Empty when nothing landed.
   */
  readonly why: Promise<LandedContextAnswer>;
}

const NO_REASONS: Reasons = { teammate: null, landed: null };

/** The live half's once-per key: this file, this teammate's work context. */
const liveAskKey = (file: string, session: TripwireSession): string =>
  JSON.stringify([file, session.developerId, session.workContextId]);

/** Which of the two questions this edit already has an answer to. */
interface Answered {
  /** The landed probe answered for this file once this session. */
  readonly askedLanded: boolean;
  /** The live answer for this file was dealt with inside the re-check TTL (round 2, L1). */
  readonly isLiveFresh: boolean;
}

/**
 * THE LANDED PROBE STARTS THE MOMENT THE FILE IS KNOWN (batch-2 review, M6):
 * it asks only the reader's own clone, and nothing it asks depends on how the
 * file is classified, so it runs beside the classification's `check-attr`
 * instead of after it — under load, a git spawn of the hook's critical path.
 * A generated file's answer is never read. ONE REQUEST of deadline
 * (LANDED_PROBE_BUDGET_MS says why), so it ends no later than the live call
 * that starts after the classification.
 */
const startLandedProbe = (
  ctx: HookContext,
  edited: EditedFile,
  askedLanded: boolean,
  knownCleanKeys: readonly string[],
): Promise<LandedProbe> => {
  const probing = askedLanded
    ? Promise.resolve(NOT_PROBED)
    : probeLandedChanges({
        root: edited.root,
        file: edited.file,
        now: ctx.now(),
        timeZone: resolveTimeZone(ctx.env),
        budgetMs: ctx.config.timeoutMs,
        knownCleanKeys,
        cacheHome: ctx.config.home,
      });
  return probing;
};

/**
 * Asks only the questions this session has not been stopped for yet, in
 * parallel, and neither waits on the other: the live tripwire's hub call is
 * bounded by its own timeout, the landed probe (already under way,
 * `startLandedProbe`) by its own deadline — never longer than one hub call,
 * so the live ask keeps the budget it always had — and a failure of either
 * is silence for that half only. The moment the probe finds a landed change,
 * the second hub call, its why, starts beside them (`why`, bounded by what
 * the budget spares; hooks/landed-why.ts).
 */
const findReasons = async (
  ctx: HookContext,
  budget: HookBudget,
  edited: EditedFile,
  answered: Answered,
  probing: Promise<LandedProbe>,
): Promise<FoundReasons> => {
  const live = answered.isLiveFresh
    ? Promise.resolve(null)
    : getTripwireSessions(ctx.hub, ctx.identity.repoId, edited.file, edited.authoritative === true).then((result) =>
        result.ok ? result.data : null,
      );
  const why = probing
    .then((probed) => {
      const landed = worthStopping(probed.landed);
      return landed === null ? NO_LANDED_ANSWER : landedWhyFor(ctx, budget, edited.file, landed);
    })
    .catch((): LandedContextAnswer => NO_LANDED_ANSWER);
  const [hub, probed] = await Promise.all([live, probing]);
  return {
    sessions: hub?.sessions ?? [],
    landed: worthStopping(probed.landed),
    cleanKey: probed.landed?.cleanKey ?? null,
    probeCut: probed.cutShort,
    ...(hub === null ? {} : { coverage: hub.coverage }),
    recordsOutcomes: hub?.recordsOutcomes ?? false,
    why,
  };
};

/** A file this session was already stopped on for a landed change: not asked again. */
const NOT_PROBED: LandedProbe = { landed: null, cutShort: null };

/**
 * A LANDED-CHANGE CHECK CUT SHORT IS BOOKED, NEVER SILENT (2026-10-08): one
 * count in this session's state, which its next prompt tells once
 * (hooks/user-prompt-submit.ts), and one line in the local ledger doctor and
 * status count (state/landed-probe-cuts.ts). The edit itself prints nothing
 * for it — a line per edit is the noise the stop's once-per-file rule exists
 * to prevent. Only on a cut: one lock round and one append. A hook the
 * budget abandoned before it got here is booked by the runner instead
 * (hooks/runner.ts bookCutEditCheck), through the same once-per-call door.
 */
const bookProbeCut = async (ctx: HookContext, cut: LandedProbeCutShort): Promise<void> => {
  await bookLandedProbeCut({
    home: ctx.config.home,
    sessionId: ctx.payload.session_id,
    toolUseId: ctx.payload.tool_use_id ?? null,
    key: ctx.repoKey,
    reason: cut,
    now: ctx.now(),
  });
};

/**
 * A probe key that answered "nothing" is remembered, so the next edit of the
 * same file in the same state of the repo costs the five git calls that
 * compute the key, not the walk. Only a complete answer that found nothing
 * carries one.
 * Best effort: a busy lock only means the next edit asks again.
 */
const rememberClean = async (ctx: HookContext, key: string): Promise<void> => {
  await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) =>
    fresh.landedCleanKeys.includes(key) ? null : withLandedClean(fresh, key),
  );
};

/** What one claim won: the reasons it may state, and the groups its person is told of. */
interface Claim {
  readonly won: Reasons;
  readonly told: readonly CollisionNotice[];
}

const NO_CLAIM: Claim = { won: NO_REASONS, told: [] };

/** What a claim wrote, as its undo needs it (`releaseCutStop`). */
interface ClaimMade {
  readonly file: string;
  /** The live half's once-per key this claim won, or null. */
  readonly askKey: string | null;
  /** This claim won the landed half. */
  readonly isLandedWon: boolean;
  /** The groups this claim recorded told. */
  readonly toldKeys: readonly string[];
  /** The hub named a live teammate on the file: a cut leaves its recheck owed. */
  readonly isLive: boolean;
}

/**
 * THE STOP AND THE PERSON'S LINE ARE ONE CLAIM (batch-2 review, H2):
 * check-and-set under the state lock, on the freshest state, in ONE write.
 *
 * The ASK markers: a sibling PreToolUse racing this one finds a marker
 * already present and drops that reason, and a slower PostToolUse writing
 * after us can no longer erase it (test/state-race.test.ts). The LIVE half is
 * won by the first session in the hub's order whose (file, work context) pair
 * this session has not asked about yet (review M4) — the ask names one
 * teammate, and the next edit of the file asks about the next one.
 *
 * The PERSON'S LINE, in the same write: every group the hub named is
 * recorded — a new file of a told group grows it, which is what the
 * statusline counts — and the groups new to this session are the ones to
 * tell, queued for the main thread too when this is a subagent's hook. Once
 * every teammate on the file is asked about AND told, the file rests for
 * TRIPWIRE_RECHECK_TTL_MS; when nothing changed at all, nothing is written
 * (round 2, L1).
 *
 * NOT GATED ON THE SPARE BUDGET. It was (review L3, "told only when it can
 * be said"), and under load the spare was spent by the time the hub
 * answered: a subagent's agent was warned and nothing else happened — no
 * relay, no rest, nothing counted, the pilot's defect (H2). What L3 guarded
 * against — a group marked told by a hook the race then abandons — is now
 * the race's to settle: the claim registers its undo (`releaseCutStop`)
 * inside this very transform, so no cut can fall between the two, and a
 * transform that runs after the cut claims nothing. Returns only what THIS
 * call won and told — the only things it may say.
 */
const claimStop = async (
  ctx: HookContext,
  budget: HookBudget,
  answer: LiveAnswer,
  found: LandedChanges | null,
): Promise<Claim> => {
  const { file } = answer;
  // A holder rather than a plain `let`, so the assignment inside the
  // callback is visible after it.
  const claimed: { value: Claim } = { value: NO_CLAIM };
  const isWritten = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
    if (budget.isCut?.() === true) {
      return null;
    }
    const askedGroups = fresh.tripwireAskedGroups ?? [];
    const teammate = answer.sessions.find((session) => !askedGroups.includes(liveAskKey(file, session))) ?? null;
    const landed = found !== null && !fresh.landedAskedFiles.includes(file) ? found : null;
    const withLive =
      teammate === null ? fresh : withTripwireGroupAsked(withTripwireAsked(fresh, file), liveAskKey(file, teammate));
    const asked = landed === null ? withLive : withLandedAsked(withLive, file);
    const fresher = newCollisionKeys(asked, answer.groups);
    const told = answer.groups.filter((group) => fresher.includes(group.key));
    const remembered = answer.groups.length === 0 ? asked : rememberGroups(ctx, asked, answer.groups, fresher);
    const isSettled = answer.sessions.length > 0 && isAllAsked(remembered, answer);
    const next = isSettled ? withTripwireChecked(remembered, file, ctx.now()) : remembered;
    if (teammate === null && landed === null && collisionFieldsOf(next) === collisionFieldsOf(fresh)) {
      return null;
    }
    claimed.value = { won: { teammate, landed }, told };
    budget.onCut?.(() =>
      releaseCutStop(ctx, {
        file,
        askKey: teammate === null ? null : liveAskKey(file, teammate),
        isLandedWon: landed !== null,
        toldKeys: told.map((group) => group.key),
        isLive: answer.sessions.length > 0,
      }),
    );
    return next;
  });
  return isWritten ? claimed.value : NO_CLAIM;
};

/**
 * A CLAIM WHOSE OUTPUT NEVER LEFT IS GIVEN BACK (batch-2 review, H2): the
 * race abandoned the hook after `claimStop` wrote, so the agent saw no ask
 * and the person no line. Undone under the same lock — re-asked, or booked,
 * never lost:
 *
 *   - the ask is released, so the file's next edit asks again;
 *   - the landed stop is released the same way;
 *   - a MAIN-THREAD group goes back to untold; a subagent's stays told, its
 *     relay still queued for the main thread, which tells the person
 *     whatever became of the subagent's output;
 *   - a live file owes its recheck NOW (an already-overdue rest): the next
 *     sync hook asks the hub about it and tells the person, or books
 *     `rest_unchecked` (hooks/rest-recheck.ts) — so a subagent that edits a
 *     file once is not the end of it;
 *   - and the cut itself is booked, `tripwire_cut` in the local ledger of
 *     moments a collision's person may not have been told — whether or not
 *     the lock let the undo through.
 *
 * A claim that only grew a group already told lost nothing, and leaves its
 * write as it is. `tripwireAskedFiles` keeps the file: it records every file
 * asked at least once and decides nothing. Fail open: the runner's settle
 * swallows a throw.
 */
const releaseCutStop = async (ctx: HookContext, claim: ClaimMade): Promise<void> => {
  const isLiveLost = claim.isLive && (claim.askKey !== null || claim.toldKeys.length > 0);
  if (!isLiveLost && !claim.isLandedWon) {
    return;
  }
  await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
    const unasked =
      claim.askKey === null
        ? fresh
        : { ...fresh, tripwireAskedGroups: (fresh.tripwireAskedGroups ?? []).filter((key) => key !== claim.askKey) };
    const unstopped = claim.isLandedWon
      ? { ...unasked, landedAskedFiles: unasked.landedAskedFiles.filter((file) => file !== claim.file) }
      : unasked;
    const untold = ctx.payload.agent_id === undefined ? withoutCollisionNotices(unstopped, claim.toldKeys) : unstopped;
    return isLiveLost ? withOverdueRest(untold, claim.file, ctx.now()) : untold;
  });
  if (isLiveLost) {
    await recordRestOmission(ctx.config.home, { key: ctx.repoKey, reason: TRIPWIRE_CUT, now: ctx.now() });
  }
};

/** The rest-omission reason a cut tripwire answer is booked under (core state/rest-omissions.ts). */
const TRIPWIRE_CUT = "tripwire_cut";

/**
 * The groups recorded as told — and, when this hook runs inside a SUBAGENT,
 * the new ones queued for the main thread's next prompt, which is where the
 * person's conversation is (hooks/user-prompt-submit.ts drains it). Queued
 * FIRST, then remembered (round 2, L6): the record's cap evicts merely told
 * groups before queued ones, so it has to know the new ones are queued.
 */
const rememberGroups = (
  ctx: HookContext,
  state: SessionState,
  groups: readonly CollisionNotice[],
  told: readonly string[],
): SessionState => {
  const queued = ctx.payload.agent_id === undefined || told.length === 0
    ? state
    : withQueuedCollisionRelays(state, told);
  return withCollisionNotices(queued, groups);
};

/**
 * THE ASK IS COUNTED (07 §3.1), and HERE — not by a later hook. Proof 2
 * reads the `tripwire` channel, and the ask used to live only in this
 * session's state file, which never reaches the hub. Deferring the record
 * to the next hook that appends would lose exactly the asks that mattered:
 * a denied edit fires no PostToolUse, and a session that is simply closed
 * fires nothing at all (the trial: 104 of 127 never closed). A spool append
 * takes no lock and costs microseconds beside the hub call this hook has
 * already made, and a failed one is booked in `.drops`, never dropped
 * silently. Appended AFTER the claim, so a racing sibling that lost the
 * claim records nothing — and the id is deterministic per (session,
 * context), so a replay is the hub's `duplicate`, not a second collision.
 * Only the LIVE half has a teammate context to record against; the landed
 * half is recorded for its authors instead (recordLandedStop).
 */
const recordTripwireAsk = async (
  ctx: HookContext,
  state: SessionState,
  teammate: TripwireSession,
): Promise<void> => {
  await appendRecords(
    ctx.config.home,
    ctx.repoKey,
    ctx.payload.session_id,
    [
      hintDeliveryRecord(
        state.crosscheckSessionId,
        "work_context",
        teammate.workContextId,
        "tripwire",
        {
          developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
          agentKind: ctx.config.agentKind,
          sessionId: state.crosscheckSessionId,
        },
        ctx.now(),
      ),
    ],
    ctx.now(),
  );
};

/**
 * WHETHER THIS STOP MAY TELL ITS AUTHORS AT ALL.
 *
 * Not in `notice` mode: there the reason reaches only the model, no person
 * sees "Mike is told about this stop", and decision 9 — the notice names
 * the reader even behind a presence opt-out — rests on the reader having
 * been told first (decision 11). A stop no person saw tells nobody.
 *
 * Not when the file's repo is not the session's: the hub files a stop under
 * the repo its reader's session reports and refuses any other, so a line
 * printed for one would name a notice that never exists.
 */
const mayTellAuthors = (ctx: HookContext, state: SessionState): boolean =>
  aPersonReads(ctx.env) && ctx.identity.repoId === state.repoId;

/**
 * THE STOP IS RECORDED FOR THE PEOPLE IT NAMES (docs/1.0/landed-changes.md,
 * step 4). After the booking, like the live half's ask: a sibling that lost
 * the booking records nothing. Only the commits the stop names
 * (namedLandedCommits, what the reader sees) and only those whose author the
 * hub's why answer named as told — so the hub can tell nobody the stop did
 * not name, and it checks that once more on ingest.
 *
 * Returns the names the stop may PRINT: those of a record that reached the
 * spool. A refused append (a full spool; counted in `.drops`) records nothing
 * and names nobody, so "Mike is told" is never said of a notice that does
 * not exist. Microseconds, like every spool append; the hub hears it at the
 * reader's next flush.
 */
const recordLandedStop = async (
  ctx: HookContext,
  state: SessionState,
  file: string,
  landed: LandedChanges,
  told: readonly LandedToldAuthor[],
): Promise<readonly string[]> => {
  const authorOf = new Map(told.map((author) => [author.sha, author]));
  const missing = new Set(landed.missing.map((commit) => commit.sha));
  const named = namedLandedCommits(landed).flatMap((commit) => {
    const author = authorOf.get(commit.sha);
    return author === undefined
      ? []
      : [
          {
            name: author.name,
            commit: {
              sha: commit.sha,
              // The local secret scan runs before every upload (DESIGN.md
              // §2.1): a subject it flags goes blank, and the notice then
              // names the commit by its sha alone.
              subject: containsSecret(commit.subject)
                ? ""
                : cutWellFormed(commit.subject, LANDED_STOP_MAX_SUBJECT_CHARS),
              authorEmail: commit.authorEmail,
              authorDeveloperId: author.developerId,
              missing: missing.has(commit.sha),
            },
          },
        ];
  });
  const body = LandedStopSchema.safeParse({
    sessionId: state.crosscheckSessionId,
    repo: ctx.identity.repoId,
    path: file,
    stoppedAt: ctx.now().toISOString(),
    commits: named.map((entry) => entry.commit),
  });
  if (!body.success) {
    return [];
  }
  const producer: Producer = {
    developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: ctx.config.agentKind,
    sessionId: state.crosscheckSessionId,
  };
  const appended = await appendRecords(
    ctx.config.home,
    ctx.repoKey,
    ctx.payload.session_id,
    [landedStopRecord(body.data, producer, ctx.now())],
    ctx.now(),
  );
  if (!appended.persisted) {
    return [];
  }
  // Each person once: two commits by Mike are one "Mike is told", and two
  // people who share a display name are still two.
  const byPerson = new Map(named.map((entry) => [entry.commit.authorDeveloperId, entry.name]));
  return [...byPerson.values()];
};

/**
 * #25: additionalContext carries the SAME factual reason (incl. the
 * get_diagnosis id) to the MODEL — permissionDecisionReason for an "ask"
 * reaches the human only (hooks.md), so before this the model learned
 * nothing. It is emitted in BOTH modes. In `notice` mode (Q2: headless
 * orchestration/CI) the decision fields are omitted entirely, so the tool is
 * briefed but never blocked — the only honest fallback, since headless
 * cannot be auto-detected. The ladder still stops at "ask": ASK_DECISION is
 * this module's one decision literal and `notice` emits no decision at all.
 *
 * A NEW teammate group adds the person's line as `systemMessage` — in BOTH
 * modes, because it blocks nothing and a notice-mode session is the one where
 * no permission prompt ever shows the person the reason — and the relay
 * sentence after the model's copy only, never inside the reason the person
 * reads in the prompt.
 *
 * With NO ask to state — this edit's (file, group) pairs were all asked
 * before, but a group's line could not be claimed then (review L3) — the
 * person gets the line now, and the model gets the same facts with the one
 * request: no decision, nothing blocked.
 */
const askOutput = (ctx: HookContext, reason: string | null, notice: string | null): string => {
  if (reason === null) {
    return notice === null
      ? ""
      : JSON.stringify({
          systemMessage: notice,
          hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `${notice}\n${COLLISION_RELAY_SENTENCE}` },
        });
  }
  const hookSpecificOutput =
    resolveTripwireMode(ctx.env) === TRIPWIRE_MODE_NOTICE
      ? { hookEventName: "PreToolUse", additionalContext: reason }
      : {
          hookEventName: "PreToolUse",
          permissionDecision: ASK_DECISION,
          permissionDecisionReason: reason,
          additionalContext: reason,
        };
  return JSON.stringify(
    notice === null
      ? { hookSpecificOutput }
      : { systemMessage: notice, hookSpecificOutput: withRelaySentence(hookSpecificOutput) },
  );
};

/** The model's copy plus the one request; an output without a model copy is left as it is. */
const withRelaySentence = <T extends { readonly additionalContext?: string }>(output: T): T =>
  output.additionalContext === undefined
    ? output
    : { ...output, additionalContext: `${output.additionalContext}\n${COLLISION_RELAY_SENTENCE}` };
