/**
 * /api/passkeys — what every member may READ about the hub's passkeys
 * (1.0 spec 04a §4.3). Writing happens on the web pages, behind a ceremony.
 *
 *   GET /api/passkeys/announcements  recent enrolments + how many can approve
 *
 * THE ANNOUNCEMENT IS THE CONTROL. The hub cannot tell a passkey on Touch ID
 * from one a program emulates, so an enrolment nobody expected is the one way
 * an agent could plant an authority — and the cool-off only helps if a person
 * sees the enrolment while it lasts. `crosscheck status` and `doctor` read
 * this, so the sentence reaches the person where they already look.
 */
import { Hono } from "hono";

import { PASSKEY_ANNOUNCEMENT_DAYS } from "../constants.ts";
import { ok } from "../http/envelope.ts";
import { developerAuth } from "../middleware/auth.ts";
import { countUsablePasskeys, listRecentEnrolments } from "../services/passkeys.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const MS_PER_DAY = 86_400_000;

export const passkeyRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/announcements", async (c) => {
    const now = deps.now();
    const [enrolments, usablePasskeys] = await Promise.all([
      listRecentEnrolments({
        db: deps.db,
        since: new Date(now.getTime() - PASSKEY_ANNOUNCEMENT_DAYS * MS_PER_DAY),
        now,
      }),
      countUsablePasskeys({ db: deps.db, now }),
    ]);
    return ok(c, { enrolments, usablePasskeys });
  });

  return router;
};
