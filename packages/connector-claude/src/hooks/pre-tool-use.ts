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
 * Everything reused, nothing re-invented: the hot-file denylist and the
 * repo-relative path logic are PostToolUse's own (capture/denylist.ts,
 * hooks/post-tool-use.ts), the self/own-worktree exclusion is the hub's
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
 */
import { isDenied, resolveDenylist } from "@crosscheck/connector-core/capture/denylist.ts";
import { extractFilePaths, isEditTool } from "../capture/tool-events.ts";
import { getTripwireSessions } from "@crosscheck/connector-core/http/hub.ts";
import type { TripwireSession } from "@crosscheck/connector-core/http/hub.ts";
import type { CoverageRecord } from "@crosscheck/connector-core/http/coverage.ts";
import {
  UNKNOWN_DEVELOPER_ID,
  hintDeliveryRecord,
} from "@crosscheck/connector-core/capture/records.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import { renderEditWarning } from "@crosscheck/connector-core/hints/render.ts";
import {
  openToolWindow,
  readSessionState,
  updateSessionState,
  withKnownWorktreeRoot,
  withLandedAsked,
  withLandedClean,
  withTripwireAsked,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { toolWindowKey } from "@crosscheck/connector-core/state/tool-window-key.ts";
import { resolveTouchedRoots } from "@crosscheck/connector-core/capture/touched-root.ts";
import { toRepoRelative } from "@crosscheck/connector-core/capture/target-paths.ts";
import { resolveTripwireMode } from "@crosscheck/connector-core/config/tripwire.ts";
import { findLandedChanges, worthStopping } from "@crosscheck/connector-core/landed-changes/probe.ts";
import type { LandedChanges } from "@crosscheck/connector-core/landed-changes/probe.ts";
import { resolveTimeZone } from "@crosscheck/connector-core/landed-changes/working-days.ts";
import { LANDED_PROBE_BUDGET_MS, TRIPWIRE_MODE_NOTICE } from "@crosscheck/connector-core/constants.ts";
import { landedWhyFor } from "./landed-why.ts";
import { requestLandingFetchFor } from "./landing-fetch.ts";
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

const askBeforeEdit = async (ctx: HookContext, budget: HookBudget): Promise<string> => {
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    return "";
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
    return "";
  }
  const { file } = edited;
  // Hot files drown real overlap signal — the same denylist capture applies.
  const patterns = resolveDenylist(ctx.config.denylist ?? undefined);
  if (isDenied(file, patterns)) {
    return "";
  }
  // One stop per file per session FOR EACH REASON: noise budget (§10 risk
  // 1), and neither answer changes within a session. A file already stopped
  // for both reasons costs nothing; one stopped for one reason only asks the
  // other question.
  const asked = {
    live: state.tripwireAskedFiles.includes(file),
    landed: state.landedAskedFiles.includes(file),
  };
  if (asked.live && asked.landed) {
    return "";
  }
  const found = await findReasons(ctx, edited, asked, state.landedCleanKeys);
  if (found.cleanKey !== null && !state.landedCleanKeys.includes(found.cleanKey)) {
    await rememberClean(ctx, found.cleanKey);
  }
  if (found.teammate === null && found.landed === null) {
    return "";
  }
  const won = await claimReasons(ctx, file, found);
  if (won.teammate === null && won.landed === null) {
    return "";
  }
  // The ask reason states what a teammate is doing and what landed; the
  // record states how far the archive the live claim came from reaches
  // (03 §5.1). It annotates only on a positively observed gap, so an
  // un-upgraded hub leaves the live lines byte-identical to what they were.
  // The why is asked only now: there IS a stop, and it is booked, so a slow
  // hub can cost the why and never the stop (hooks/landed-why.ts).
  const why = won.landed === null ? [] : await landedWhyFor(ctx, budget, file, won.landed);
  const reason = renderEditWarning({
    live: won.teammate,
    landed: won.landed,
    file,
    now: ctx.now(),
    ...(found.coverage === undefined ? {} : { coverage: found.coverage }),
    why,
  });
  if (won.teammate !== null) {
    await recordTripwireAsk(ctx, state, won.teammate);
  }
  return askOutput(ctx, reason);
};

export const handlePreToolUse = async (ctx: HookContext, budget: HookBudget): Promise<string> => {
  if (!isEditTool(ctx.payload.tool_name)) {
    return "";
  }
  // An edit also asks for the background fetch of the landing branches
  // (hooks/landing-fetch.ts): an agent can work for an hour on one prompt,
  // and the stop only sees what the clone has fetched. Beside the stop, not
  // before it — the fetch serves the NEXT edit and must cost this one nothing.
  const [output] = await Promise.all([askBeforeEdit(ctx, budget), requestLandingFetchFor(ctx)]);
  return output;
};

interface Reasons {
  readonly teammate: TripwireSession | null;
  readonly landed: LandedChanges | null;
}

interface FoundReasons extends Reasons {
  readonly coverage?: CoverageRecord;
  /** The probe answered "nothing" under this key (landed-changes/probe.ts). */
  readonly cleanKey: string | null;
}

const NO_REASONS: Reasons = { teammate: null, landed: null };

/**
 * Asks only the questions this session has not been stopped for yet, in
 * parallel, and neither waits on the other: the hub call is bounded by its
 * own timeout, the landed probe by its own deadline — never longer than one
 * hub call, so the live ask keeps the budget it always had — and a failure
 * of either is silence for that half only.
 */
const findReasons = async (
  ctx: HookContext,
  edited: EditedFile,
  asked: { readonly live: boolean; readonly landed: boolean },
  knownCleanKeys: readonly string[],
): Promise<FoundReasons> => {
  const [result, probed] = await Promise.all([
    asked.live ? null : getTripwireSessions(ctx.hub, ctx.identity.repoId, edited.file),
    asked.landed
      ? null
      : findLandedChanges({
          root: edited.root,
          file: edited.file,
          now: ctx.now(),
          timeZone: resolveTimeZone(ctx.env),
          budgetMs: Math.min(LANDED_PROBE_BUDGET_MS, ctx.config.timeoutMs),
          knownCleanKeys,
        }),
  ]);
  const hub = result?.ok === true ? result.data : null;
  return {
    teammate: hub?.sessions[0] ?? null,
    landed: worthStopping(probed),
    cleanKey: probed?.cleanKey ?? null,
    ...(hub === null ? {} : { coverage: hub.coverage }),
  };
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

/**
 * The markers are CLAIMED atomically — check-and-set under the state lock,
 * on the freshest state: a sibling PreToolUse racing this one finds a marker
 * already present and drops that reason, and a slower PostToolUse writing
 * after us can no longer erase it (test/state-race.test.ts). Claimed BEFORE
 * emitting, same honest direction as the hint delivery: a crash between the
 * two costs one ask, never a nag loop. Returns only the reasons THIS call
 * won — the only ones it may state.
 */
const claimReasons = async (ctx: HookContext, file: string, found: Reasons): Promise<Reasons> => {
  // A holder rather than a plain `let`, so the assignment inside the
  // callback is visible after it.
  const won: { value: Reasons } = { value: NO_REASONS };
  const isWritten = await updateSessionState(ctx.config.home, ctx.payload.session_id, (fresh) => {
    const teammate =
      found.teammate !== null && !fresh.tripwireAskedFiles.includes(file) ? found.teammate : null;
    const landed = found.landed !== null && !fresh.landedAskedFiles.includes(file) ? found.landed : null;
    won.value = { teammate, landed };
    if (teammate === null && landed === null) {
      return null;
    }
    const withLive = teammate === null ? fresh : withTripwireAsked(fresh, file);
    return landed === null ? withLive : withLandedAsked(withLive, file);
  });
  return isWritten ? won.value : NO_REASONS;
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
 * Only the LIVE half has a teammate context to record against; a stop for
 * a landed change alone records nothing here yet.
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
 * #25: additionalContext carries the SAME factual reason (incl. the
 * get_diagnosis id) to the MODEL — permissionDecisionReason for an "ask"
 * reaches the human only (hooks.md), so before this the model learned
 * nothing. It is emitted in BOTH modes. In `notice` mode (Q2: headless
 * orchestration/CI) the decision fields are omitted entirely, so the tool is
 * briefed but never blocked — the only honest fallback, since headless
 * cannot be auto-detected. The ladder still stops at "ask": ASK_DECISION is
 * this module's one decision literal and `notice` emits no decision at all.
 */
const askOutput = (ctx: HookContext, reason: string): string => {
  const hookSpecificOutput =
    resolveTripwireMode(ctx.env) === TRIPWIRE_MODE_NOTICE
      ? { hookEventName: "PreToolUse", additionalContext: reason }
      : {
          hookEventName: "PreToolUse",
          permissionDecision: ASK_DECISION,
          permissionDecisionReason: reason,
          additionalContext: reason,
        };
  return JSON.stringify({ hookSpecificOutput });
};
