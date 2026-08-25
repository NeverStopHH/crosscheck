/**
 * `selectAndRenderHint` (DESIGN-agent-agnostic.md §1.3) — the
 * UserPromptSubmit recipe as an extracted function: meaning floor → session
 * state (seen-set + cap) → ONE bounded hub call → `selectHint` → drift label
 * → `renderClaimHint`/`renderPointerHint` → record the delivery, THEN return
 * the text.
 *
 * EXTRACTED FROM `connector-claude/src/hooks/user-prompt-submit.ts` for
 * Block 5, not invented: the hook calls this now, and the ACP proxy's
 * per-prompt path calls the same function — one implementation of the whole
 * asymmetry pipeline (§4: evidence-backed substance, pointers for the rest,
 * silence on every doubt), so a selector or renderer change can never drift
 * between connectors.
 *
 * PRIVACY (Block 4's pin extends here): the prompt is an EPHEMERAL search
 * query. It is sliced for the hub call and never stored, spooled, or logged —
 * nothing in this module writes it anywhere. And it is SECRET-GATED before
 * the one hub call: `containsSecret` on the whole prompt, a hit means the
 * attempt is dropped — the query is the one place this text goes on the
 * wire, and the wire-level pin lives in connector-cursor/test/privacy.test.ts.
 *
 * ORDER AT THE END IS THE CONTRACT: telemetry spool append, then session
 * state (seen-set + echo hash), then the caller emits. A crash — or a
 * caller's budget race resolving against a late hint — between state write
 * and emission costs one hint slot, the honest direction; the reverse order
 * could deliver the same hint twice, which is the noise §10 risk 1 forbids.
 * The delivery id is deterministic per (session, ref), so a replayed spool
 * re-sends the same primary key and the hub answers `duplicate` — never a
 * second telemetry row (the loads/resumes idempotency pin).
 */
import {
  HINT_MIN_TOKEN_CHARS,
  MAX_HINTS_PER_SESSION,
  MAX_SEARCH_QUERY_CHARS,
} from "../constants.ts";
import { containsSecret } from "../capture/secret-scan.ts";
import { hintDeliveryRecord, UNKNOWN_DEVELOPER_ID } from "../capture/records.ts";
import type { HintRefKind, Producer } from "../capture/records.ts";
import { resolveCommitDrift } from "../git/commit-drift.ts";
import type { CommitDrift } from "../git/commit-drift.ts";
import { getHintCandidates } from "../http/hub.ts";
import type { HubContext } from "../http/hub.ts";
import { recordDeliveredHintHash } from "../hints/delivered-store.ts";
import { hintBodyHash } from "../hints/echo.ts";
import { renderClaimHint, renderPointerHint } from "../hints/render.ts";
import { selectHint } from "../hints/select.ts";
import type { HintSelection } from "../hints/select.ts";
import { appendRecords } from "../spool/append.ts";
import {
  readSessionState,
  updateSessionState,
  withDeliveredHint,
} from "../state/session-state.ts";
import type { SessionState } from "../state/session-state.ts";

/** The same meaning floor the hub applies — zero HTTP for an empty question. */
const hasSearchableWord = (prompt: string): boolean =>
  prompt
    .split(/[^\p{L}\p{N}]+/u)
    .some((token) => token.length >= HINT_MIN_TOKEN_CHARS);

export interface SelectAndRenderHintInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  /** The host's own id for the session — the state file key. */
  readonly hostSessionKey: string;
  readonly repoId: string;
  /** Drift resolves against this checkout; a slow git loses the label only. */
  readonly repoRoot: string;
  readonly agentKind: string;
  /** EPHEMERAL query — sliced for the hub call, never stored (see header). */
  readonly prompt: string;
  readonly now: Date;
}

interface Delivery {
  readonly refKind: HintRefKind;
  readonly refId: string;
  readonly bodyHash: string | null;
  readonly text: string;
}

const renderSelection = async (
  repoRoot: string,
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
      : await resolveCommitDrift(repoRoot, context.baseCommit);
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
      // #19: present only for a targets-only pointer, absent for the
      // claim-count one — the renderer branches on it, still no body either way.
      ...(selection.matchedTarget === undefined
        ? {}
        : { matchedTarget: selection.matchedTarget }),
      drift,
      now,
    }),
  };
};

/** False when the seen-set could not be updated — then nothing may be emitted. */
const recordDelivery = async (
  input: SelectAndRenderHintInput,
  state: SessionState,
  delivery: Delivery,
): Promise<boolean> => {
  const producer: Producer = {
    developerId: state.developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: input.agentKind,
    sessionId: state.crosscheckSessionId,
  };
  // A local append, microseconds; the next flush ships it, and a dead hub
  // leaves it spooled like any other record (idempotent by delivery id).
  await appendRecords(
    input.home,
    input.repoKey,
    input.hostSessionKey,
    [
      hintDeliveryRecord(
        state.crosscheckSessionId,
        delivery.refKind,
        delivery.refId,
        producer,
        input.now,
      ),
    ],
    input.now,
  );
  // Freshest state, under the state lock — and FIRST WRITER WINS, decided on
  // that fresh state: two hook processes can race ONE failure (the cursor
  // dual-signal case fires postToolUse and postToolUseFailure concurrently),
  // and both pass the lockless pre-checks in selectAndRenderHint before
  // either records. The transform is therefore a check-AND-set, the
  // tripwire's own shape: a ref already present, or a cap already reached by
  // a racing sibling, DECLINES the write — and unremembered means unemitted,
  // so the loser is silence, never a second copy of the same teammate
  // finding in one turn (§10 risk 1). The loser's spool append above carries
  // the winner's deterministic delivery id, so the hub absorbs it as a
  // duplicate — never a second telemetry row.
  const remembered = await updateSessionState(
    input.home,
    input.hostSessionKey,
    (fresh) =>
      fresh.deliveredHintRefs.includes(delivery.refId) ||
      fresh.deliveredHintRefs.length >= MAX_HINTS_PER_SESSION
        ? null
        : withDeliveredHint(fresh, delivery.refId, delivery.bodyHash),
  );
  // Substance hashes also persist per repo (hints/delivered-store.ts): the
  // echo-loop exclusion carries no session qualifier, and session state dies
  // at session end. Best-effort — the session-state copy above already covers
  // this session, so a busy lock here must not cost the hint.
  if (remembered && delivery.bodyHash !== null) {
    await recordDeliveredHintHash(input.home, input.repoKey, delivery.bodyHash);
  }
  return remembered;
};

/**
 * The whole prompt-time pipeline; returns the rendered hint or "" (silence).
 * Every branch that cannot prove a hint is worth injecting returns "".
 */
export const selectAndRenderHint = async (
  input: SelectAndRenderHintInput,
): Promise<string> => {
  if (!hasSearchableWord(input.prompt)) {
    return "";
  }
  // SECRET GATE — the capture scan's sibling, on the QUERY. The prompt goes
  // on the wire as a GET string (into a shared hub's request path and access
  // logs), and on the Cursor connector it is captured tool output — a failing
  // `curl -H "Authorization: …"`, a dumped DSN, a printed JWT — exactly the
  // text class capture/secret-scan.ts refuses to spool. Same rule here: a
  // hit means drop the whole attempt, never redact-and-send. Defense in
  // depth for the prompt-text connectors too (a pasted credential).
  if (containsSecret(input.prompt)) {
    return "";
  }
  // No state file means no session was registered here: no session to
  // attribute a delivery to and no seen-set to hold the cap — silence, not
  // recovery (a hint is never worth a register).
  const state = await readSessionState(input.home, input.hostSessionKey);
  if (state === null) {
    return "";
  }
  if (state.deliveredHintRefs.length >= MAX_HINTS_PER_SESSION) {
    return "";
  }
  const result = await getHintCandidates(input.hub, {
    query: input.prompt.slice(0, MAX_SEARCH_QUERY_CHARS),
    repo: input.repoId,
  });
  if (!result.ok) {
    return "";
  }
  // #20 observability: book that the hub returned candidates for THIS repo, so
  // `doctor` can tell "no hint ever fired because nothing matched" apart from
  // "a match was possible but the selector chose silence". Only on a non-empty
  // result — the common no-match prompt writes nothing (a monotonic counter,
  // one bounded write inside the 800 ms budget).
  if (result.data.length > 0) {
    await updateSessionState(input.home, input.hostSessionKey, (fresh) => ({
      ...fresh,
      hintCandidatesSeen: fresh.hintCandidatesSeen + result.data.length,
    }));
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
  const delivery = await renderSelection(input.repoRoot, selection, input.now);
  if (delivery === null || delivery.text.length === 0) {
    return "";
  }
  // Unremembered means unemitted — the honest direction: a state write that
  // fails (no file, busy lock) costs one hint slot, never a repeat delivery.
  const remembered = await recordDelivery(input, state, delivery);
  if (!remembered) {
    return "";
  }
  return delivery.text;
};
