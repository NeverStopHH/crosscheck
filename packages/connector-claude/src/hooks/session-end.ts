import {
  removeFile,
  sessionSlug,
  spoolPendingEndPath,
  writePrivateFile,
} from "../config/paths.ts";
import { endSession } from "../http/hub.ts";
import { readSessionSpool } from "../spool/files.ts";
import { flushSpool } from "../spool/flush.ts";
import {
  crosscheckSessionIdFor,
  deleteSessionState,
  readSessionState,
} from "../state/session-state.ts";
import type { HookBudget, HookContext } from "./runner.ts";

interface SessionIdentity {
  readonly crosscheckSessionId: string;
  readonly developerId: string | null;
}

/**
 * Records this session produced that are still on disk. Per SESSION, not per
 * repo: another session's backlog says nothing about whether this one's work
 * has arrived.
 */
const undeliveredOwnRecords = async (
  ctx: HookContext,
  slug: string,
): Promise<number> =>
  (await readSessionSpool(ctx.config.home, ctx.repoKey, slug)).lines.length;

/**
 * Records that this session still has to be ended, and by whom — `reap` picks
 * it up from here (spool/reap.ts).
 *
 * Written BEFORE the `end` call, not instead of it. The call is the last thing
 * a SessionEnd does and the likeliest thing for the budget to cut in half. A
 * marker left behind by a call that DID land costs a retry of an idempotent
 * request (server/src/services/sessions.ts ends twice without complaint), and
 * later SessionStarts stop retrying either way: the end succeeds, or the marker
 * expires with MAX_SPOOL_AGE_DAYS. A lost call costs a session that stays open
 * with nobody left to close it.
 */
const recordPendingEnd = async (
  ctx: HookContext,
  slug: string,
  identity: SessionIdentity,
): Promise<void> => {
  await writePrivateFile(
    spoolPendingEndPath(ctx.config.home, ctx.repoKey, slug),
    `${JSON.stringify({
      crosscheckSessionId: identity.crosscheckSessionId,
      at: ctx.now().toISOString(),
    })}\n`,
  );
};

/**
 * Flush BEFORE ending: ingest rejects records whose producer session has ended,
 * and this flush sends them under THIS session's id.
 *
 * The drain gets `spareMs` only — what is left after reserving one request
 * timeout for the `end` call. With the whole budget it took the hook: measured
 * through the binary with a 600-record backlog and a 350 ms hub, SessionEnd ran
 * 831 ms, sent no `end`, and never reached `deleteSessionState` — which also
 * left that spool unreapable, since reap reads a state file as a live writer.
 */
export const handleSessionEnd = async (
  ctx: HookContext,
  budget: HookBudget,
): Promise<string> => {
  const stored = await readSessionState(ctx.config.home, ctx.payload.session_id);
  const identity: SessionIdentity = {
    crosscheckSessionId:
      stored?.crosscheckSessionId ??
      crosscheckSessionIdFor(ctx.payload.session_id),
    developerId: stored?.developerId ?? ctx.config.developerId,
  };
  const slug = sessionSlug(ctx.payload.session_id);

  await flushSpool(
    ctx.hub,
    {
      sessionId: identity.crosscheckSessionId,
      developerId: identity.developerId,
    },
    budget.spareMs(),
  );

  const undelivered = await undeliveredOwnRecords(ctx, slug);
  await recordPendingEnd(ctx, slug, identity);
  // Before the hub call, and unconditionally: a state file that outlives its
  // session is what makes a spool permanently unreapable, and reap reads the
  // marker written above only once this is gone.
  await deleteSessionState(ctx.config.home, ctx.payload.session_id);

  if (undelivered > 0) {
    // Telling the hub "done" now would publish a finished session while records
    // it produced are still on disk, and a teammate reading the hub would see a
    // session whose work never arrives. Presence hides it on its own TTL
    // meanwhile; the records stay deliverable either way, because a later
    // session's flush re-stamps them with its own id (spool/flush.ts).
    return "";
  }
  const result = await endSession(ctx.hub, identity.crosscheckSessionId);
  if (result.ok) {
    await removeFile(spoolPendingEndPath(ctx.config.home, ctx.repoKey, slug));
  }
  return "";
};