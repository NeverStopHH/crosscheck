/**
 * /api/hub-status — what the hub is still doing on its own (review round 4,
 * M2), read by `crosscheck doctor`.
 *
 * `searchDocsPending`: work contexts whose search doc predates the current
 * rule and still folds a draft in (services/stale-docs.ts). Until the
 * start-up doc upgrade has rebuilt one, search finds that context by its
 * claims only, so a teammate whose search comes back thin can see why — and
 * that it is temporary. 0 on a hub with nothing left to rebuild.
 *
 * `transport`: two facts about how the hub is reachable, each a doctor WARN
 * with its fix (hub hardening, review M7 and H6):
 *   - `listensOnEveryInterface`: CROSSCHECK_LISTEN is unset on a data dir
 *     older than the setting, so the hub kept 0.10's every-interface listen
 *     (http/listen.ts). Not the address list itself: a member learns that
 *     something must change, never the hub's addresses;
 *   - `localhostBesideHttps`: CROSSCHECK_WEBAUTHN_ORIGINS lists a localhost
 *     origin that such a hub refuses anyway (routes/ui-ceremony.ts).
 *
 * COUNTS AND FLAGS ONLY, read by any member: no context, no developer, nothing
 * behind a number that a search would not show the same reader.
 */
import { Hono } from "hono";

import { ok } from "../http/envelope.ts";
import { developerAuth } from "../middleware/auth.ts";
import { countPendingDocs } from "../services/stale-docs.ts";
import { hasLocalhostBesideHttps } from "../services/webauthn.ts";
import type { AppDeps, AppEnv } from "../types.ts";

export const hubStatusRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  router.get("/", developerAuth(deps), async (c) =>
    ok(c, {
      searchDocsPending: await countPendingDocs(deps.db),
      transport: {
        listensOnEveryInterface: deps.listen === "legacy_all_interfaces",
        localhostBesideHttps: hasLocalhostBesideHttps(deps.webauthnOrigins),
      },
    }),
  );

  return router;
};
