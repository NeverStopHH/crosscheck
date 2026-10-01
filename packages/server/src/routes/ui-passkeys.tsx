/** @jsxImportSource hono/jsx */
/**
 * The passkey half of the web UI (1.0 spec 04a), mounted by ui.tsx BEHIND the
 * session middleware:
 *
 *   GET  /ui/passkey.js           the one script (ui/passkey-script.ts)
 *   GET  /ui/passkeys             your passkeys; enrol; add a device; revoke
 *   POST /ui/passkeys/:id/revoke  revoke during the cool-off, plain form
 *   GET  /ui/waivers              requests to answer, fences to amend or close
 *   POST /ui/webauthn/options     mint a ceremony   (routes/ui-ceremony.ts)
 *   POST /ui/webauthn/verify      finish one        (routes/ui-ceremony.ts)
 *
 * The two pages swap the UI's CSP for `UI_PASSKEY_CSP`, which admits the
 * same-origin script and fetch WebAuthn needs; every other page keeps the
 * JS-free one. One WebAuthn instance per mounted router: its pending
 * ceremonies live in that closure, like the session secret lives in deps.
 */
import { Hono } from "hono";

import { listPasskeys, revokePasskey, usableCredentials } from "../services/passkeys.ts";
import { listRequests } from "../services/waiver-requests.ts";
import { listOpenFences } from "../services/waivers.ts";
import { createWebAuthn } from "../services/webauthn.ts";
import { UI_PASSKEY_CSP } from "../ui/constants.ts";
import { PasskeysPage } from "../ui/pages/passkeys.tsx";
import { WaiversPage } from "../ui/pages/waivers.tsx";
import { PASSKEY_SCRIPT } from "../ui/passkey-script.ts";
import { forbidden, isPostedCsrfValid, viewerChrome } from "../ui/route-helpers.tsx";
import type { AppDeps, AppEnv } from "../types.ts";
import { ceremonyOptions, ceremonyVerify } from "./ui-ceremony.ts";

const PASSKEYS_PATH = "/ui/passkeys";

/** What the cool-off revoke form says when it cannot do what was asked. */
const OWNER_REVOKE_SENTENCE = {
  unknown_passkey: "You have no passkey with that id.",
  already_revoked: "That passkey has already been revoked.",
  passkey_required:
    "That passkey is past its first day; revoke it with another passkey, or ask the admin.",
} as const;

export const uiPasskeyRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  const webauthn = createWebAuthn({
    origins: deps.webauthnOrigins,
    nowMs: () => deps.now().getTime(),
  });
  const hasOrigin = deps.webauthnOrigins.length > 0;

  router.get("/passkey.js", (c) =>
    c.body(PASSKEY_SCRIPT, 200, { "Content-Type": "text/javascript; charset=utf-8" }),
  );

  router.get("/passkeys", async (c) => {
    c.header("Content-Security-Policy", UI_PASSKEY_CSP);
    const developerId = c.get("developer").id;
    const now = deps.now();
    const [passkeys, usable] = await Promise.all([
      listPasskeys({ db: deps.db, developerId, now }),
      usableCredentials({ db: deps.db, developerId, now }),
    ]);
    return c.html(
      <PasskeysPage
        viewer={viewerChrome(c, deps)}
        passkeys={passkeys}
        hasOrigin={hasOrigin}
        canAuthoriseAnother={usable.length > 0}
      />,
    );
  });

  router.post("/passkeys/:id/revoke", async (c) => {
    if (!(await isPostedCsrfValid(c, deps))) {
      return forbidden(c, "Invalid or missing CSRF token.");
    }
    const outcome = await revokePasskey({
      db: deps.db,
      passkeyId: c.req.param("id"),
      by: { kind: "owner", developerId: c.get("developer").id },
      now: deps.now(),
    });
    return "refusal" in outcome
      ? forbidden(c, OWNER_REVOKE_SENTENCE[outcome.refusal])
      : c.redirect(PASSKEYS_PATH, 303);
  });

  router.get("/waivers", async (c) => {
    c.header("Content-Security-Policy", UI_PASSKEY_CSP);
    const now = deps.now();
    const [requests, fences, usable] = await Promise.all([
      listRequests({ db: deps.db, repo: null, now }),
      listOpenFences({ db: deps.db, now }),
      usableCredentials({ db: deps.db, developerId: c.get("developer").id, now }),
    ]);
    return c.html(
      <WaiversPage
        viewer={viewerChrome(c, deps)}
        requests={requests.filter((request) => request.status === "pending")}
        fences={fences}
        hasOrigin={hasOrigin}
        hasUsablePasskey={usable.length > 0}
      />,
    );
  });

  router.post("/webauthn/options", (c) => ceremonyOptions(c, deps, webauthn));
  router.post("/webauthn/verify", (c) => ceremonyVerify(c, deps, webauthn));

  return router;
};
