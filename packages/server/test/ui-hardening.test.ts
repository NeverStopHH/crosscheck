/**
 * Hardening for the two web-security gaps the adversarial review found on the
 * /ui surface. Both LOW, both real, both driven through the same in-process
 * hub every other UI test uses.
 *
 *  1. LOGIN CSRF. POST /ui/login carries no session-bound CSRF token — it
 *     cannot, there is no session yet — and originally honored a cross-site
 *     POST, letting an attacker auto-submit their OWN key from evil.example
 *     and land the victim's browser in the ATTACKER's session. Fetch-metadata
 *     (`Sec-Fetch-Site`) is the dependency-free guard: a genuine same-origin
 *     form submit is tagged `same-origin`; a cross-site / same-site submit is
 *     refused; an ABSENT header (non-browser clients, the CLI, curl) stays
 *     allowed, because CSRF is a browser-only threat. The existing
 *     ui-auth.test.ts login cases send no such header and pin that allow-path.
 *
 *  2. UNHANDLED 500 ON A MALFORMED BODY. `c.req.parseBody()` throws
 *     ERR_FORMDATA_PARSE_ERROR on a `multipart/form-data` body with no
 *     boundary. On the PUBLIC login route that is an unauthenticated 500 from
 *     one crafted Content-Type header; every form POST must instead degrade to
 *     its own validation (login 400, CSRF-checked POSTs 403), never an
 *     unhandled exception.
 *
 *  3. SECURE FLAG BEHIND A TLS-TERMINATING PROXY. The hub keyed the cookie's
 *     `Secure` flag on its OWN request protocol only, so the common proxied
 *     deployment (Caddy/nginx/Tailscale terminating TLS, hub on plain http
 *     behind it) shipped the session cookie without `Secure` over an origin
 *     the browser reached via https. `X-Forwarded-Proto: https` must add the
 *     flag; a plain-HTTP LAN install without a proxy must stay non-Secure so
 *     its login keeps working.
 *
 *  4. EMPTY SIGNING SECRET. `CROSSCHECK_UI_SECRET=` (empty) flowed through
 *     `?? generateApiKey()` untouched (empty string is not nullish) and was
 *     used verbatim as the session HMAC key. A signing secret must fail fast
 *     at startup, not silently sign with "".
 */
import { describe, expect, test } from "bun:test";

import { createDb, createServer } from "../src/index.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";
import { loginUi, sessionCookieFrom } from "./ui-helpers.ts";

const postLogin = async (
  harness: TestHarness,
  apiKey: string,
  headers: Record<string, string>,
): Promise<Response> =>
  harness.app.request("/ui/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ apiKey }).toString(),
  });

const postMalformedMultipart = async (
  harness: TestHarness,
  path: string,
  headers: Record<string, string>,
): Promise<Response> =>
  // multipart/form-data with no boundary — parseBody throws on this.
  harness.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data", ...headers },
    body: "x",
  });

describe("ui login CSRF (fetch-metadata guard)", () => {
  test("a cross-site or same-site login POST is refused and sets no cookie; same-origin still logs in", async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    const crossSite = await postLogin(harness, nick.apiKey, {
      "Sec-Fetch-Site": "cross-site",
    });
    expect(crossSite.status).toBe(403);
    expect(sessionCookieFrom(crossSite)).toBeNull();

    const sameSite = await postLogin(harness, nick.apiKey, {
      "Sec-Fetch-Site": "same-site",
    });
    expect(sameSite.status).toBe(403);
    expect(sessionCookieFrom(sameSite)).toBeNull();

    // Positive control: a genuine same-origin form submit is unaffected.
    const sameOrigin = await postLogin(harness, nick.apiKey, {
      "Sec-Fetch-Site": "same-origin",
    });
    expect(sameOrigin.status).toBe(303);
    expect(sessionCookieFrom(sameOrigin)).not.toBeNull();
  });
});

describe("ui form POSTs never 500 on a malformed body", () => {
  test("POST /ui/login with an unparseable multipart body is a clean 400, not a 500", async () => {
    const harness = await createTestHarness();
    await createTestDeveloper(harness, "Nick", "nick@example.com");

    const response = await postMalformedMultipart(harness, "/ui/login", {});

    expect(response.status).toBe(400);
    expect(sessionCookieFrom(response)).toBeNull();
  });

  test("POST /ui/logout with an unparseable multipart body is a clean 403, not a 500", async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const cookie = await loginUi(harness, nick.apiKey);

    const response = await postMalformedMultipart(harness, "/ui/logout", {
      Cookie: cookie,
    });

    expect(response.status).toBe(403);
  });
});

describe("ui session cookie Secure flag (proxied TLS)", () => {
  test("X-Forwarded-Proto https adds Secure; plain LAN http without a proxy stays non-Secure", async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    const proxied = await postLogin(harness, nick.apiKey, {
      "X-Forwarded-Proto": "https",
    });
    expect(proxied.status).toBe(303);
    expect(sessionCookieFrom(proxied)).toContain("; Secure");

    // Chained proxies send a list; the first (client-facing) hop decides.
    const chained = await postLogin(harness, nick.apiKey, {
      "X-Forwarded-Proto": "https, http",
    });
    expect(sessionCookieFrom(chained)).toContain("; Secure");

    // Positive control: the plain-HTTP LAN install (no proxy, no header)
    // must keep logging in — a Secure cookie there would never come back.
    const plain = await postLogin(harness, nick.apiKey, {});
    expect(plain.status).toBe(303);
    expect(sessionCookieFrom(plain)).not.toContain("; Secure");

    // An http proto from the proxy is not an https transport either.
    const plainProxied = await postLogin(harness, nick.apiKey, {
      "X-Forwarded-Proto": "http",
    });
    expect(sessionCookieFrom(plainProxied)).not.toContain("; Secure");
  });
});

describe("ui session signing secret must not be empty", () => {
  test("createServer refuses an empty or whitespace-only uiSessionSecret", async () => {
    const db = await createDb();

    expect(() => createServer({ db, uiSessionSecret: "" })).toThrow(/non-empty/);
    expect(() => createServer({ db, uiSessionSecret: "   " })).toThrow(/non-empty/);
  });
});
