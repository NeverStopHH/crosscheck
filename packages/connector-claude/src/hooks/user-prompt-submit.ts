/**
 * UserPromptSubmit — the injection pipeline's fast path (DESIGN.md §4).
 *
 * Inside the developer's keystroke: ONE bounded hub call (lexical candidates),
 * one bounded git call (drift), at most ONE hint, and silence on every doubt.
 * The 800 ms total budget is enforced by the runner's race
 * (USER_PROMPT_SUBMIT_BUDGET_RATIO), measured in test/hint-hook-latency.test.ts.
 *
 * ORDER AT THE END IS THE CONTRACT: telemetry spool append, then session
 * state (seen-set + echo hash), then emit. A crash between state write and
 * emit costs one hint slot — the honest direction; the reverse order could
 * deliver the same hint twice, which is the noise §10 risk 1 forbids.
 *
 * ASYNC SECOND CHANCE (§4's optional vector-tier redelivery) is a deliberate
 * deferral — reasoning at the header of packages/server/src/services/hints.ts,
 * which is the endpoint that would have to hold the pending state.
 */
import {
  HINT_MIN_TOKEN_CHARS,
  MAX_HINTS_PER_SESSION,
  MAX_SEARCH_QUERY_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import { hintDeliveryRecord, UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import type { HintRefKind, Producer } from "@crosscheck/connector-core/capture/records.ts";
import { resolveCommitDrift } from "@crosscheck/connector-core/git/commit-drift.ts";
import type { CommitDrift } from "@crosscheck/connector-core/git/commit-drift.ts";
import { getHintCandidates } from "@crosscheck/connector-core/http/hub.ts";
import { recordDeliveredHintHash } from "@crosscheck/connector-core/hints/delivered-store.ts";
import { hintBodyHash } from "@crosscheck/connector-core/hints/echo.ts";
import { renderClaimHint, renderPointerHint } from "@crosscheck/connector-core/hints/render.ts";
import { selectHint } from "@crosscheck/connector-core/hints/select.ts";
import type { HintSelection } from "@crosscheck/connector-core/hints/select.ts";
import { appendRecords } from "@crosscheck/connector-core/spool/append.ts";
import {
  readSessionState,
  updateSessionState,
  withDeliveredHint,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { HookContext } from "./runner.ts";

/** The same meaning floor the hub applies — zero HTTP for an empty question. */
const hasSearchableWord = (prompt: string): boolean =>
  prompt
    .split(/[^\p{L}\p{N}]+/u)
    .some((token) => token.length >= HINT_MIN_TOKEN_CHARS);

interface Delivery {
  readonly refKind: HintRefKind;
  readonly refId: string;
  readonly bodyHash: string | null;
  readonly text: string;
}

const renderSelection = async (
  ctx: HookContext,
  selection: HintSelection,
  now: Date,
): Promise<Delivery | null> => {
  if (selection.kind === "silence") {
    return null;
  }
  const context = selection.context.workContext;
  // Drift is a nice-to-have label: a slow or ignorant git loses it, never the
  // hint. Bounded by DRIFT_GIT_TIMEOUT_MS inside resolveCommitDrift.
  const drift: CommitDrift | null =
    context.baseCommit === undefined || context.baseCommit.length === 0
      ? null
      : await resolveCommitDrift(ctx.identity.root, context.baseCommit);
  if (selection.kind === "claim") {
    return {
      refKind: "claim",
      refId: selection.claim.id,
      bodyHash: hintBodyHash(selection.claim.body),
      text: renderClaimHint({ claim: selection.claim, context, drift, now }),
    };
  }
  return {
    refKind: "work_context",
    refId: context.id,
    bodyHash: null,
    text: renderPointerHint({
      context,
      claimCount: selection.claimCount,
      drift,
      now,
    }),
  };
};

/** False when the seen-set could not be updated — then nothing may be emitted. */
const recordDelivery = async (
  ctx: HookContext,
  state: SessionState,
  delivery: Delivery,
  now: Date,
): Promise<boolean> => {
  const producer: Producer = {
    developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: ctx.config.agentKind,
    sessionId: state.crosscheckSessionId,
  };
  // A local append, microseconds; the next hook's flush ships it, and a dead
  // hub leaves it spooled like any other record (idempotent by delivery id).
  await appendRecords(
    ctx.config.home,
    ctx.repoKey,
    ctx.payload.session_id,
    [
      hintDeliveryRecord(
        state.crosscheckSessionId,
        delivery.refKind,
        delivery.refId,
        producer,
        now,
      ),
    ],
    now,
  );
  // Freshest state, under the state lock: a previous turn's PostToolUse still
  // flushing must not have this write erase its markers, nor erase this ref
  // with its own stale snapshot (state/session-state.ts, updateSessionState).
  const remembered = await updateSessionState(
    ctx.config.home,
    ctx.payload.session_id,
    (fresh) => withDeliveredHint(fresh, delivery.refId, delivery.bodyHash),
  );
  // Substance hashes also persist per repo (hints/delivered-store.ts): the
  // echo-loop exclusion carries no session qualifier, and session state dies
  // at SessionEnd. Best-effort — the session-state copy above already covers
  // this session, so a busy lock here must not cost the hint.
  if (remembered && delivery.bodyHash !== null) {
    await recordDeliveredHintHash(
      ctx.config.home,
      ctx.repoKey,
      delivery.bodyHash,
    );
  }
  return remembered;
};

export const handleUserPromptSubmit = async (
  ctx: HookContext,
): Promise<string> => {
  const prompt = ctx.payload.prompt ?? "";
  if (!hasSearchableWord(prompt)) {
    return "";
  }
  // No state file means SessionStart never ran here: no session to attribute
  // a delivery to and no seen-set to hold the cap — silence, not recovery.
  // (PostToolUse owns mid-session recovery; a hint is never worth a register.)
  const state = await readSessionState(ctx.config.home, ctx.payload.session_id);
  if (state === null) {
    return "";
  }
  if (state.deliveredHintRefs.length >= MAX_HINTS_PER_SESSION) {
    return "";
  }
  const result = await getHintCandidates(ctx.hub, {
    query: prompt.slice(0, MAX_SEARCH_QUERY_CHARS),
    repo: ctx.identity.repoId,
  });
  if (!result.ok) {
    return "";
  }
  const selection = selectHint({
    // Briefing solved pointers join the seen-set — the same tree must not be
    // re-pointed — but NOT deliveredCount: they were the briefing's budget,
    // and spending prompt-hint slots on them would starve real hints. A
    // solved tree's evidence-backed claims stay deliverable as substance
    // (the seen-set suppresses pointers to a seen context, never unseen
    // claims inside it — hints/select.ts).
    candidates: result.data,
    seenRefIds: [...state.deliveredHintRefs, ...state.briefingSolvedRefs],
    deliveredCount: state.deliveredHintRefs.length,
    selfDeveloperId: state.developerId,
  });
  const now = ctx.now();
  const delivery = await renderSelection(ctx, selection, now);
  if (delivery === null || delivery.text.length === 0) {
    return "";
  }
  // Unremembered means unemitted — the honest direction: a state write that
  // fails (no file, busy lock) costs one hint slot, never a repeat delivery.
  const remembered = await recordDelivery(ctx, state, delivery, now);
  if (!remembered) {
    return "";
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: delivery.text,
    },
  });
};
