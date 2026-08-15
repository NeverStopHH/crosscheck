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
 */
import { describe, expect, test } from "bun:test";

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
