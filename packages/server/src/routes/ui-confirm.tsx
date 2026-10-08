/** @jsxImportSource hono/jsx */
/**
 * The confirmation half of the web UI (human provenance §6), mounted by
 * routes/ui-passkeys.tsx BEHIND the session middleware, beside the ceremony
 * endpoints whose `confirm_batch` action finishes what this starts:
 *
 *   GET  /ui/confirm         the pending drafts, with their context
 *   POST /ui/confirm/batch   freeze the person's decisions into a batch
 *
 * The batch route is a JSON fetch with the session-bound CSRF header, like the
 * ceremony endpoints. It writes nothing to the database: a formed batch lives
 * in hub memory, bound to this browser session, until a passkey confirms it.
 */
import { Hono } from "hono";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { BATCH_SENTENCE, BatchBodySchema } from "../services/confirmation-batch.ts";
import type { BatchStore } from "../services/confirmation-batch.ts";
import { CONFIRM_PAGE_SCOPE, readConfirmPage } from "../services/confirm-page.ts";
import { getDeveloperSettings } from "../services/developer-settings.ts";
import { confirmingCredentials } from "../services/passkeys.ts";
import { UI_PASSKEY_CSP } from "../ui/constants.ts";
import { ConfirmPage } from "../ui/pages/confirm.tsx";
import { viewerChrome } from "../ui/route-helpers.tsx";
import type { AppDeps, AppEnv } from "../types.ts";
import { ceremonyOwnerOf, isCeremonyCsrfValid } from "./ui-ceremony.ts";

export const uiConfirmRoutes = (deps: AppDeps, batches: BatchStore): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  const hasOrigin = deps.webauthnOrigins.length > 0;

  router.get("/confirm", async (c) => {
    c.header("Content-Security-Policy", UI_PASSKEY_CSP);
    const developerId = c.get("developer").id;
    const [page, credentials, settings] = await Promise.all([
      readConfirmPage(deps, developerId),
      confirmingCredentials({ db: deps.db, developerId }),
      getDeveloperSettings(deps.db, developerId, deps.now()),
    ]);
    return c.html(
      <ConfirmPage
        viewer={viewerChrome(c, deps)}
        fingerprint={page.fingerprint}
        drafts={page.drafts}
        hasOrigin={hasOrigin}
        hasConfirmingPasskey={credentials.length > 0}
        keyedOptOutAt={settings.presenceOptOutChange?.at ?? null}
      />,
    );
  });

  router.post("/confirm/batch", async (c) => {
    if (!isCeremonyCsrfValid(c, deps)) {
      return fail(c, 403, "csrf_invalid", "invalid or missing CSRF token — reload the page");
    }
    const parsed = BatchBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    // The page's own scope: a batch it forms covers the kinds it shows, and only those.
    const batch = await batches.form(deps, ceremonyOwnerOf(c), parsed.data, CONFIRM_PAGE_SCOPE);
    if ("refusal" in batch) {
      return fail(c, 422, batch.refusal, BATCH_SENTENCE[batch.refusal]);
    }
    const count = (decision: string): number => batch.items.filter((item) => item.decision === decision).length;
    return ok(c, {
      batchId: batch.id,
      digest: batch.digest,
      confirm: count("confirm"),
      discard: count("discard"),
      keep: count("keep"),
    });
  });

  return router;
};
