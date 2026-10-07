/**
 * THE MARKER OF ONE LIFE'S END (config/paths.ts spoolPendingEndPath), in one
 * shape for both writers: SessionEnd, when its end is deferred or not yet sent
 * (flows/end-session.ts), and session-reap, when it deletes the state of a
 * host session that died without one (state/session-reap.ts, review-2 round 8,
 * M3). Reap's DeferredEnder reads it to end the life (spool/reap.ts); a work
 * context still on disk for the life reads its title and status from it once
 * the state is gone (spool/owed-work-context.ts readLifeState).
 */
import type { SeqField } from "@crosscheck/schema";

import { writePrivateFile } from "../config/paths.ts";

/** What the state says the life's work context is, kept on its marker once the state is gone. */
export interface WorkContextStanding {
  readonly workContextTitle: string | null;
  readonly workContextStatus: string | null;
}

export interface EndMarker {
  readonly sessionId: string;
  readonly at: Date;
  /**
   * The end's position: the one SessionEnd allocated, or for a life
   * session-reap closes the one past its counter (review-2 round 9, M1 + M2).
   * A resume onto the life restores its epoch and next position from it.
   */
  readonly seq?: SeqField;
  readonly standing: WorkContextStanding;
}

export const writeEndMarker = (path: string, marker: EndMarker): Promise<void> =>
  writePrivateFile(
    path,
    `${JSON.stringify({
      crosscheckSessionId: marker.sessionId,
      at: marker.at.toISOString(),
      // THE MARKER IS THE ONLY CARRIER LEFT. reap's DeferredEnder runs in a
      // later process with no state file to consult — so a deferred end
      // without this is permanently unsequenced, and nothing would say why.
      ...(marker.seq === undefined ? {} : { seq: marker.seq }),
      // ...and the last title and status the life's state held: a work
      // context still on disk for it goes with these, not the ones it was
      // spooled with (spool/owed-work-context.ts readLifeState, review-2 round
      // 7, found by the spool simulation).
      ...(marker.standing.workContextTitle === null ? {} : { workContextTitle: marker.standing.workContextTitle }),
      ...(marker.standing.workContextStatus === null ? {} : { workContextStatus: marker.standing.workContextStatus }),
    })}\n`,
  );
