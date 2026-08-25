/**
 * GET /api/solved-matches — solved trees sharing a strong target with work
 * currently active on this repo (VISION.md §1). One more parallel GET inside
 * the connector's SessionStart fetch block; `repo` is the usual relevance
 * filter, never a boundary (DESIGN.md §2.1).
 *
 * With `?fingerprint=`, the SAME route answers a different question: which
 * solved trees carry THIS exact failure. With `?counts=1` it answers a third
 * — how many of the pointers this reader was already shown they actually
 * pulled (services/solved-counts.ts), the precision loop `status` and
 * `doctor` print. One route because it is one answer
 * shape — the caller renders both through the same line — and because a
 * second route would be a second place for the mute filter and the
 * substance rule to drift apart.
 */
import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { SolvedMatchQuerySchema } from "../http/schemas.ts";
import { developerAuth } from "../middleware/auth.ts";
import { countSolvedDeliveries } from "../services/solved-counts.ts";
import {
  listSolvedByFingerprint,
  listSolvedMatches,
} from "../services/solved-matches.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const solvedMatchesRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = SolvedMatchQuerySchema.safeParse({
      repo: c.req.query("repo"),
      fingerprint: c.req.query("fingerprint"),
      counts: c.req.query("counts"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const developerId = c.get("developer").id;
    // `?counts=1` is a different question about the same ledger — "were the
    // pointers we already showed read?" — and the listing is SKIPPED for it
    // on purpose: `crosscheck status` and `doctor` ask this on a human's
    // keystroke and should cost one bounded indexed query, not a whole
    // matching pass whose answer they would throw away.
    if (parsed.data.counts === "1") {
      const counts = await countSolvedDeliveries(
        deps,
        developerId,
        parsed.data.repo,
      );
      return ok(c, { matches: [], counts });
    }
    // `repo` stays REQUIRED on the probe even though nothing filters on it:
    // it is what the caller's renderer compares each row's own repo against
    // to decide whether to say where the answer lives, and a caller that
    // cannot name its repo cannot render the answer honestly either.
    const matches =
      parsed.data.fingerprint === undefined
        ? await listSolvedMatches(deps, developerId, parsed.data.repo)
        : await listSolvedByFingerprint(
            deps,
            developerId,
            parsed.data.fingerprint,
          );
    return ok(c, { matches });
  });

  return router;
};
