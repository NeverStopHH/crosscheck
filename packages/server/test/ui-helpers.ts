/**
 * Shared plumbing for the /ui request-level tests: login via the real form
 * exchange, cookie carriage, and CSRF-token extraction from rendered HTML.
 * Everything goes through `harness.app.request` — the same in-process hub the
 * API tests drive, so nothing here can pass while the served UI fails.
 */
import { jsonRequest } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

export const UI_SESSION_COOKIE = "crosscheck_ui_session";

/** First Set-Cookie value for the session cookie, or null when absent. */
export const sessionCookieFrom = (response: Response): string | null => {
  const setCookies = response.headers.getSetCookie();
  for (const cookie of setCookies) {
    if (cookie.startsWith(`${UI_SESSION_COOKIE}=`)) {
      return cookie;
    }
  }
  return null;
};

/** The bare `name=value` pair a browser would send back. */
export const cookiePairFrom = (setCookie: string): string => {
  const pair = setCookie.split(";")[0];
  if (pair === undefined) {
    throw new Error(`unparseable Set-Cookie: ${setCookie}`);
  }
  return pair;
};

export const postLoginForm = async (
  harness: TestHarness,
  apiKey: string,
): Promise<Response> =>
  harness.app.request("/ui/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ apiKey }).toString(),
  });

/** Full login flow; returns the `name=value` cookie pair for later requests. */
export const loginUi = async (
  harness: TestHarness,
  apiKey: string,
): Promise<string> => {
  const response = await postLoginForm(harness, apiKey);
  if (response.status !== 303) {
    throw new Error(`ui login failed with status ${response.status}`);
  }
  const setCookie = sessionCookieFrom(response);
  if (setCookie === null) {
    throw new Error("ui login set no session cookie");
  }
  return cookiePairFrom(setCookie);
};

export const uiGet = async (
  harness: TestHarness,
  path: string,
  cookiePair: string | null,
): Promise<Response> =>
  harness.app.request(path, {
    method: "GET",
    headers: cookiePair === null ? {} : { Cookie: cookiePair },
  });

export const uiPostForm = async (
  harness: TestHarness,
  path: string,
  cookiePair: string | null,
  fields: Record<string, string>,
): Promise<Response> =>
  harness.app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookiePair === null ? {} : { Cookie: cookiePair }),
    },
    body: new URLSearchParams(fields).toString(),
  });

const CSRF_INPUT_PATTERN = /name="_csrf" value="([^"]+)"/;

/** CSRF token as rendered into any authed page's forms. */
export const csrfTokenFrom = (html: string): string => {
  const match = CSRF_INPUT_PATTERN.exec(html);
  if (match?.[1] === undefined) {
    throw new Error("no _csrf input found in page HTML");
  }
  return match[1];
};

/** GET a page and pull the CSRF token out of it in one step. */
export const fetchCsrfToken = async (
  harness: TestHarness,
  path: string,
  cookiePair: string,
): Promise<string> => {
  const response = await uiGet(harness, path, cookiePair);
  if (response.status !== 200) {
    throw new Error(`fetching ${path} for csrf failed: ${response.status}`);
  }
  return csrfTokenFrom(await response.text());
};

/** Toggle presence opt-out through the real API, as the developer. */
export const setPresenceOptOutViaApi = async (
  harness: TestHarness,
  apiKey: string,
  optOut: boolean,
): Promise<void> => {
  const response = await harness.app.request(
    "/api/settings/presence",
    jsonRequest("PUT", apiKey, { optOut }),
  );
  if (response.status !== 200) {
    throw new Error(`presence toggle failed with status ${response.status}`);
  }
};
