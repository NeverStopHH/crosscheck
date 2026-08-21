/**
 * `endSessionFlow` (DESIGN-agent-agnostic.md §1.3) — the session-end recipe
 * as an extracted function:
 *
 *   flush (budgeted) → count undelivered → pending-end marker → delete state
 *   → `end` only when nothing is left on disk (else the marker defers it to
 *   `reap`'s DeferredEnder).
 *
 * EXTRACTED FROM `connector-claude/src/hooks/session-end.ts`, not invented —
 * the hook calls this now. The ordering arguments travel with the code:
 *
 *   - flush BEFORE ending: ingest rejects records whose producer session has
 *     ended, and this flush sends them under THIS session's id;
 *   - the marker is written BEFORE the `end` call, not instead of it: a
 *     marker left by a call that DID land costs one idempotent retry; a lost
 *     call costs a session that stays open with nobody left to close it;
 *   - state is deleted BEFORE the hub call, unconditionally: a state file
 *     that outlives its session makes a spool permanently unreapable, and
 *     reap reads the marker only once the state is gone.
 */
import {
  intentPromptPathForSlug,
  removeFile,
  sessionSlug,
  spoolPendingEndPath,
  writePrivateFile,
} from "../config/paths.ts";
import { endSession } from "../http/hub.ts";
import type { HubContext } from "../http/client.ts";
import { readSessionSpool } from "../spool/files.ts";
import { flushSpool } from "../spool/flush.ts";
import { deleteSessionState } from "../state/session-state.ts";

export interface EndSessionFlowInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  readonly hostSessionKey: string;
  readonly crosscheckSessionId: string;
  readonly developerId: string | null;
  /** Wall-clock room the caller can spare for the drain; ≤0 skips it. */
  readonly flushBudgetMs: number;
  readonly now: () => Date;
}

export interface EndSessionFlowResult {
  /** Own records still on disk after the drain — >0 defers the `end`. */
  readonly undelivered: number;
  /** True when the hub acknowledged the `end` (marker removed again). */
  readonly ended: boolean;
}

export const endSessionFlow = async (
  input: EndSessionFlowInput,
): Promise<EndSessionFlowResult> => {
  const slug = sessionSlug(input.hostSessionKey);

  await flushSpool(
    input.hub,
    {
      sessionId: input.crosscheckSessionId,
      developerId: input.developerId,
    },
    input.flushBudgetMs,
  );

  // Per SESSION, not per repo: another session's backlog says nothing about
  // whether this one's work has arrived.
  const undelivered = (
    await readSessionSpool(input.home, input.repoKey, slug)
  ).lines.length;
  await writePrivateFile(
    spoolPendingEndPath(input.home, input.repoKey, slug),
    `${JSON.stringify({
      crosscheckSessionId: input.crosscheckSessionId,
      at: input.now().toISOString(),
    })}\n`,
  );
  await deleteSessionState(input.home, input.hostSessionKey);
  // A first prompt parked for the derived-intent worker that never ran (a
  // spawn that failed, a session ending inside the worker's deadline) must
  // not outlive the session: best-effort, like the state delete above.
  await removeFile(intentPromptPathForSlug(input.home, slug));

  if (undelivered > 0) {
    // Telling the hub "done" now would publish a finished session while
    // records it produced are still on disk. The marker hands the end to
    // reap's DeferredEnder; the records stay deliverable either way.
    return { undelivered, ended: false };
  }
  const result = await endSession(input.hub, input.crosscheckSessionId);
  if (result.ok) {
    await removeFile(spoolPendingEndPath(input.home, input.repoKey, slug));
  }
  return { undelivered, ended: result.ok };
};
