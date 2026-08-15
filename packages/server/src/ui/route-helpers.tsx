/** @jsxImportSource hono/jsx */
/**
 * Helpers shared by the two /ui route modules (routes/ui.tsx auth shell,
 * routes/ui-pages.tsx page handlers): the viewer chrome with its
 * session-bound CSRF token, the CSRF check every state-changing POST runs,
 * and the HTML error responses.
 */
import type { Context } from "hono";

import { csrfTokenFor, isCsrfValid } from "./session.ts";
import { Layout } from "./layout.tsx";
import type { ViewerChrome } from "./layout.tsx";
import type { AppDeps, AppEnv } from "../types.ts";

export const viewerChrome = (
  c: Context<AppEnv>,
  deps: AppDeps,
): ViewerChrome => ({
  name: c.get("developer").name,
  csrfToken: csrfTokenFor(deps.uiSessionSecret, c.get("uiSessionToken")),
});

/** All POSTs except login verify the session-bound CSRF token (item 6). */
export const isPostedCsrfValid = async (
  c: Context<AppEnv>,
  deps: AppDeps,
): Promise<boolean> => {
  const body = await c.req.parseBody();
  const presented = body["_csrf"];
  return (
    typeof presented === "string" &&
    isCsrfValid(deps.uiSessionSecret, c.get("uiSessionToken"), presented)
  );
};

export const forbidden = (
  c: Context<AppEnv>,
  message: string,
): Response | Promise<Response> =>
  c.html(
    <Layout title="Forbidden">
      <div class="card">
        <h1>Forbidden</h1>
        <p class="error">{message}</p>
      </div>
    </Layout>,
    403,
  );

export const notFoundPage = (
  c: Context<AppEnv>,
): Response | Promise<Response> =>
  c.html(
    <Layout title="Not found">
      <div class="card">
        <h1>Not found</h1>
        <p class="notice">Nothing this hub can show lives at that address.</p>
      </div>
    </Layout>,
    404,
  );
