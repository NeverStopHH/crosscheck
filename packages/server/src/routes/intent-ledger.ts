/**
 * /api/intent-ledger/positions — how many stored intent versions can answer
 * AT-4 at all (spec 06 §5).
 *
 * BOTH HALVES, ALWAYS. The numerator alone would let a hub that has never
 * positioned anything look exactly like a hub with nothing to position —
 * which is the lesson `state/git-lane-cost.ts` records in its own words: "a
 * lane that never runs looks exactly like a quiet one". So the answer is
 * always the pair, and `crosscheck doctor` prints both.
 *
 * WHY IT NEEDS A SURFACE AT ALL. A ledger row with `seq: null` cannot be
 * compared with anything, so the question the whole spec exists for — was the
 * reason written before the change — is unanswerable for it. That is not a
 * defect a reader can see from the outside: every surface renders the
 * sentence exactly as before and the hub reports healthy. The ratio is the
 * one instrument that makes an unanswerable hub VISIBLE rather than quiet,
 * and AT-10 forbids the silent absence it would otherwise be.
 *
 * COUNTS ONLY — no work context, no session, no sentence. The question here
 * is "can this hub answer the question", which is two integers; every
 * sentence behind a row is one `get_diagnosis` away where a reader asked for
 * it.
 *
 * Read by any member: a qualifier nobody can look behind is a qualifier
 * nobody can check.
 */
import { Hono } from "hono";

import { ok } from "../http/envelope.ts";
import { developerAuth } from "../middleware/auth.ts";
import { countIntentPositions } from "../services/intent-ledger.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const intentLedgerRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  router.get("/positions", developerAuth(deps), async (c) =>
    ok(c, await countIntentPositions(deps.db)),
  );

  return router;
};
