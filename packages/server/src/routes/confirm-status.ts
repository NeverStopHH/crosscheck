/**
 * GET /api/confirm/status — what `crosscheck confirm`, `status` and doctor say
 * about the caller's own confirmations (human provenance §6, §9). The
 * caller's own, from the key; nothing about anybody else.
 *
 *   pending          how many drafts wait for the caller's passkey, by kind;
 *   humanConfirmation where a confirmation is possible on this hub at all;
 *   passkeys         the caller's unrevoked passkeys, and how many of them are
 *                    bound to an RP this hub accepts now. A passkey belongs to
 *                    the RP it was enrolled under; moving a hub to another
 *                    name is an explicit re-enrolment, never a silent move
 *                    (§9), so a mismatch is reported, not worked around;
 *   rpIds            the RP IDs the hub accepts (its hostnames — a reader of
 *                    the hub already knows the address it reached).
 *
 * COUNTS AND WORDS ONLY: no draft's content, which the person reads on the
 * page their agent cannot sign.
 */
import { Hono } from "hono";
import { z } from "zod";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { MAX_CONFIRMATIONS_LISTED, readOwnConfirmations } from "../services/confirmation-records.ts";
import { countPendingByKind } from "../services/human-drafts.ts";
import { confirmabilityOf, rpIdsOf } from "../services/human-provenance.ts";
import { confirmingCredentials } from "../services/passkeys.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const confirmStatusRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  router.get("/status", developerAuth(deps), async (c) => {
    const developerId = c.get("developer").id;
    const [byKind, credentials] = await Promise.all([
      countPendingByKind(deps, developerId),
      confirmingCredentials({ db: deps.db, developerId }),
    ]);
    const rpIds = rpIdsOf(deps.webauthnOrigins);
    const atConfiguredRp = credentials.filter((entry) => rpIds.includes(entry.credential.rpId)).length;
    return ok(c, {
      pending: Object.values(byKind).reduce((sum, count) => sum + count, 0),
      pendingByKind: byKind,
      humanConfirmation: confirmabilityOf(deps.webauthnOrigins),
      passkeys: { total: credentials.length, atConfiguredRp },
      rpIds,
    });
  });

  /**
   * THE CALLER'S OWN CONFIRMATIONS, each with the assertion that made it and
   * what it signed (services/confirmation-records.ts says how to check one
   * without trusting this hub). Newest first, bounded.
   */
  router.get("/confirmations", developerAuth(deps), async (c) => {
    const parsed = LimitSchema.safeParse(c.req.query("limit"));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    return ok(c, {
      confirmations: await readOwnConfirmations(deps.db, c.get("developer").id, parsed.data),
    });
  });

  return router;
};

const DEFAULT_CONFIRMATIONS_LISTED = 20;

const LimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_CONFIRMATIONS_LISTED)
  .default(DEFAULT_CONFIRMATIONS_LISTED);
