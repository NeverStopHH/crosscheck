/**
 * FROM A SLICE OF ONE TURN TO A DRAFT ON THE SPOOL — everything the Tier-1
 * summarizer does AFTER a host has produced the text, and nothing it does
 * before.
 *
 * The split is the seam's other half. `model/gates.ts` owns what a model's
 * answer must survive; this owns the run around it — spawn the model on the
 * slice, book the runner's own losses, resolve the session facts the gates
 * ask for, and append the surviving claim to the spool. It was the body of
 * connector-claude's summarizer worker, which was correct while Claude's
 * JSONL transcript was the only slice anyone could produce.
 *
 * SLICE ACQUISITION STAYS WITH THE HOST, and that is the whole reason this
 * function takes `sliceText` rather than a path: Claude reads a JSONL
 * transcript by byte range, Cursor reads whatever its own transcript turns
 * out to be, and ACP will accumulate the wire copy in memory. Three ways to
 * get the text, one thing done with it — the alternative is three workers
 * that each re-derive the gate order, which is the exact drift
 * `model/gates.ts` exists to prevent.
 *
 * PRIVACY: the slice arrives, goes to a locally spawned model's stdin, and is
 * dropped. Nothing here writes it anywhere. The only thing that can leave is
 * a claim that survived the gates, and it leaves as a spool record the next
 * hook flushes.
 *
 * Fail open everywhere: every early return is silent and every failure is
 * BOOKED, so a fire that landed nothing is a number somebody can explain
 * rather than a silence (trial finding #14).
 */
import { DEFAULT_AGENT_KIND } from "../../constants.ts";
import { repoKey } from "../../config/paths.ts";
import type { Env } from "../../config/paths.ts";
import {
  buildEnvelope,
  UNKNOWN_DEVELOPER_ID,
} from "../../capture/records.ts";
import { readDeliveredHintHashes } from "../../hints/delivered-store.ts";
import { appendRecords } from "../../spool/append.ts";
import {
  readSessionState,
  updateSessionState,
} from "../../state/session-state.ts";
import type { SessionState } from "../../state/session-state.ts";
import { gateModelAnswer } from "../../model/gates.ts";
import {
  formatSummarizerFailure,
  resolveSummarizerArgv,
  resolveSummarizerTimeoutMs,
  runSummarizer,
  SUMMARIZER_PROMPT,
} from "../../model/runner.ts";
import { ensureSummarizerCwd } from "../../model/worker-env.ts";
import {
  UNREADABLE_EMPTY,
  UNREADABLE_SHAPE,
  UNREADABLE_TRUNCATED,
  withSummarizerDraft,
  withSummarizerFailure,
  withSummarizerNone,
  withSummarizerRejection,
  withSummarizerUnreadable,
} from "./gate.ts";

export interface DeriveFromSliceInput {
  readonly home: string;
  /** The HOST's session key — whatever this connector keys state by. */
  readonly hostSessionKey: string;
  /** The turn, already rendered and bounded by the host's own reader. */
  readonly sliceText: string;
  readonly env: Env;
}

export const deriveFromSlice = async (
  input: DeriveFromSliceInput,
): Promise<void> => {
  const { home, hostSessionKey, env } = input;
  const result = await runSummarizer(
    resolveSummarizerArgv(env),
    input.sliceText,
    resolveSummarizerTimeoutMs(env),
    env,
    // From the neutral directory, never the repo root the hook fired in
    // (trial finding #14: no project CLAUDE.md rides into the fire).
    { cwd: await ensureSummarizerCwd(home) },
  );
  if (!result.ok) {
    // Failure telemetry (trial finding #14): the runner's own losses —
    // missing binary, non-zero exit, deadline — are booked with their
    // reason (exit code / timeout / the first STDOUT line, sanitized and
    // bounded; stderr is never read), so the fires-minus-outcomes
    // remainder is no longer a number nobody can explain.
    await updateSessionState(home, hostSessionKey, (fresh) =>
      withSummarizerFailure(fresh, formatSummarizerFailure(result)),
    );
    return;
  }
  // FRESH state for the gates that need session facts, resolved by the
  // pipeline itself so the read stays exactly where it was: hints may have
  // been delivered while the model ran, and a session that ended meanwhile
  // has nothing to attribute to — its state file is gone and the draft dies
  // with it (honest). Held in a box so the outcome branches below can still
  // see what the callback read.
  const held: { current: SessionState | null } = { current: null };
  const now = new Date();
  const outcome = await gateModelAnswer({
    stdout: result.stdout,
    prompt: SUMMARIZER_PROMPT,
    now,
    resolveContext: async () => {
      const fresh = await readSessionState(home, hostSessionKey);
      if (fresh === null) {
        return null;
      }
      held.current = fresh;
      // The echo-loop exclusion's inputs (§3, judge-mandated, no session
      // qualifier): a body a teammate hint delivered — this session (state)
      // OR any earlier one in this repo (the per-repo store).
      const persistedHashes = await readDeliveredHintHashes(
        home,
        repoKey(fresh.hubUrl, fresh.repoId),
      );
      return {
        workContextId: fresh.workContextId,
        authorSessionId: fresh.crosscheckSessionId,
        deliveredHintHashes: [...fresh.deliveredHintHashes, ...persistedHashes],
      };
    },
  });

  // Outcome telemetry (trial finding #12's measuring stick). `abandoned` is
  // the ended session: its state file is gone, so there is nothing left to
  // book anything in and nothing to attribute a draft to.
  if (outcome.kind === "abandoned") {
    return;
  }
  // An answer the model GAVE that this contract could not read. It used to
  // return silently here and live only as the fires-minus-outcomes
  // remainder, which was survivable while the binary was always a Claude
  // whose output shape the prompts were tuned on. With
  // CROSSCHECK_SUMMARIZER_CMD pointing somewhere else it is the LIKELIEST
  // outcome, so it is booked with its own reason and doctor gives it its own
  // remedy (gate.ts withSummarizerUnreadable says why it is neither a runner
  // failure nor a NONE).
  if (outcome.kind === "unparseable") {
    // The CUT outranks the shape. A truncated answer is unparseable almost by
    // construction, so asking "was it JSON?" of a fragment we chose to stop
    // reading answers a question nobody asked and hides the one fact that
    // explains the outcome (runner.ts SummarizerSuccess.truncated).
    const reason = result.truncated
      ? UNREADABLE_TRUNCATED
      : outcome.why === "empty"
        ? UNREADABLE_EMPTY
        : UNREADABLE_SHAPE;
    await updateSessionState(home, hostSessionKey, (fresh) =>
      withSummarizerUnreadable(fresh, reason),
    );
    return;
  }
  if (outcome.kind === "none") {
    await updateSessionState(home, hostSessionKey, withSummarizerNone);
    return;
  }
  // Every refusal is BOOKED (audit rows M16 / A3-4): each was a silent
  // `return`, so a fire whose well-formed answer nobody kept looked exactly
  // like a runner that never spoke — and the quota was spent either way.
  if (outcome.kind === "rejected") {
    const reason = outcome.reason;
    await updateSessionState(home, hostSessionKey, (fresh) =>
      withSummarizerRejection(fresh, reason),
    );
    return;
  }

  // Unreachable by construction — a `claim` outcome means resolveContext
  // returned a context, which is where held.current is set — and kept
  // because the alternative is a non-null assertion on the one path that
  // writes to the spool.
  const attribution = held.current;
  if (attribution === null) {
    return;
  }
  await appendRecords(
    home,
    repoKey(attribution.hubUrl, attribution.repoId),
    hostSessionKey,
    [
      buildEnvelope(
        "claim",
        outcome.claim,
        {
          developerId: attribution.developerId ?? UNKNOWN_DEVELOPER_ID,
          agentKind: env["CROSSCHECK_AGENT_KIND"] ?? DEFAULT_AGENT_KIND,
          sessionId: attribution.crosscheckSessionId,
        },
        now,
      ),
    ],
    now,
  );
  // Booked AFTER the spool append: "draft produced" means the draft exists
  // on disk, not that the model merely offered one (telemetry honesty).
  await updateSessionState(home, hostSessionKey, withSummarizerDraft);
};
