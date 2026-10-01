/**
 * /api/fence-waivers — the RECORD of who opened a human-verified fence
 * (1.0 spec 04 §3.6), and no longer a way to open one (04a §2):
 *
 *   POST /api/fence-waivers            refused: a person approves with a passkey
 *   POST /api/fence-waivers/:id/revoke refused: same
 *   GET  /api/fence-waivers?repo=&pin= what the record says, authority included
 *
 * WHY THE WRITES WERE TAKEN AWAY. Until 04a both writes took `developerAuth`
 * plus a body that said it saw a controlling terminal. The bearer key behind
 * `developerAuth` sits in plaintext in `~/.crosscheck/config.json`, readable
 * by every agent on the developer's machine, and the presence field is just
 * more bytes the same agent can send — so an agent could lift a protected
 * conflict on a human-declared invariant, principle 4's exact failure. That
 * gate was a DETECTION (04 §10 D8). Now an api key can only ASK
 * (`/api/waiver-requests`), and a grant or revocation needs a WebAuthn
 * assertion with user verification from the web UI, where the terms are
 * shown and signed (services/waiver-requests.ts, services/webauthn.ts).
 *
 * The routes stay, refusing, rather than disappearing: a 404 would send a
 * script written against the old recipe looking for another way in, and the
 * refusal sentence tells it where requests go instead.
 */
import { Hono } from "hono";
import { z } from "zod";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import { listWaivers } from "../services/waivers.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const ListQuerySchema = z.object({
  repo: z.string().min(1),
  pin: z.string().min(1).optional(),
});

/**
 * WHAT AN API KEY HEARS WHEN IT TRIES TO OPEN OR CLOSE A FENCE (04a §6).
 *
 * One sentence that says where to go instead, because the caller is most
 * likely a script or an agent following a pre-04a recipe, and a bare 403
 * would send it looking for a different way in.
 */
const PASSKEY_REQUIRED_SENTENCE =
  "a fence opens and closes only with a person's passkey — ask with POST /api/waiver-requests (crosscheck pin waive), and a person approves it at /ui/waivers";

export const fenceWaiverRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  // THE WRITE HALF IS GONE FROM THE API KEY (04a §2). Authenticated first, so
  // a stranger still gets the 401 every other route gives; then refused
  // before the body is read, so nothing a body says — the old presence
  // literal included — can reach a decision. The passkey path writes through
  // services/waiver-requests.ts from the web UI, never through here.
  router.post("/", developerAuth(deps), (c) =>
    fail(c, 403, "passkey_required", PASSKEY_REQUIRED_SENTENCE),
  );

  router.post("/:id/revoke", developerAuth(deps), (c) =>
    fail(c, 403, "passkey_required", PASSKEY_REQUIRED_SENTENCE),
  );

  router.get("/", developerAuth(deps), async (c) => {
    const parsed = ListQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    // READ IS OPEN TO ANY MEMBER — the asymmetry team-settings already uses.
    // Everybody affected by an open fence has to be able to see that it is
    // open, and by whom.
    return ok(c, {
      waivers: await listWaivers({
        db: deps.db,
        repo: parsed.data.repo,
        pinId: parsed.data.pin ?? null,
        now: deps.now(),
      }),
    });
  });

  return router;
};
