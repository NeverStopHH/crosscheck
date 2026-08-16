/**
 * /ui auth: API key → signed HttpOnly session cookie (task item 2).
 *
 * The developer identity in the cookie is the READER for every visibility
 * rule, so this file pins the exchange itself: a bad key mints no session, a
 * missing/tampered/expired cookie bounces to the login page, the API key is
 * never echoed after login, and every /ui response carries the strict CSP
 * (task item 1 — no external assets, no inline JS).
 */
import { describe, expect, test } from "bun:test";

import {
  createTestDeveloper,
  createTestHarness,
} from "./helpers.ts";
import {
  UI_SESSION_COOKIE,
  cookiePairFrom,
  fetchCsrfToken,
  loginUi,
  postLoginForm,
  sessionCookieFrom,
  uiGet,
  uiPostForm,
} from "./ui-helpers.ts";

const UI_SESSION_TTL_SECONDS = 12 * 60 * 60;

const EXPECTED_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

describe("ui login page", () => {
  test("serves the login form without auth, under the strict CSP", async () => {
    const harness = await createTestHarness();

    const response = await uiGet(harness, "/ui/login", null);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe(EXPECTED_CSP);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toContain('action="/ui/login"');
    expect(html).toContain('name="apiKey"');
    expect(html).toContain('type="password"');
    // Zero JS: the page must carry no script element at all.
    expect(html).not.toContain("<script");
  });

  test("serves the package stylesheet so the CSP needs no inline styles", async () => {
    const harness = await createTestHarness();

    const response = await uiGet(harness, "/ui/styles.css", null);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/css");
  });
});

describe("ui login exchange", () => {
  test("valid key sets a bounded HttpOnly SameSite=Strict cookie and redirects to the feed", async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    const response = await postLoginForm(harness, nick.apiKey);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/ui/feed");
    const setCookie = sessionCookieFrom(response);
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/ui");
    expect(setCookie).toContain(`Max-Age=${String(UI_SESSION_TTL_SECONDS)}`);
    // The cookie is a signed session, never the API key itself.
    expect(setCookie).not.toContain(nick.apiKey);
  });

  test("bad key gets 401 and no session cookie", async () => {
    const harness = await createTestHarness();
    await createTestDeveloper(harness, "Nick", "nick@example.com");

    const response = await postLoginForm(harness, "not-a-real-key");

    expect(response.status).toBe(401);
    expect(sessionCookieFrom(response)).toBeNull();
    const html = await response.text();
    // The generic failure message names no developer and echoes no key.
    expect(html).not.toContain("not-a-real-key");
  });

  test("missing key field gets 400 without a session cookie", async () => {
    const harness = await createTestHarness();

    const response = await uiPostForm(harness, "/ui/login", null, {});

    expect(response.status).toBe(400);
    expect(sessionCookieFrom(response)).toBeNull();
  });

  test("the API key is never echoed on any page after login", async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const cookie = await loginUi(harness, nick.apiKey);

    for (const path of ["/ui/feed", "/ui/members", "/ui/approvals"]) {
      const response = await uiGet(harness, path, cookie);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(nick.apiKey);
    }
  });
});

describe("ui session enforcement", () => {
  test("no cookie redirects every page to the login form", async () => {
    const harness = await createTestHarness();

    for (const path of ["/ui", "/ui/feed", "/ui/members", "/ui/approvals"]) {
      const response = await uiGet(harness, path, null);
      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe("/ui/login");
    }
  });

  test("a tampered cookie is a redirect, not a session", async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const cookie = await loginUi(harness, nick.apiKey);
    const tampered = `${cookie.slice(0, -4)}beef`;

    const response = await uiGet(harness, "/ui/feed", tampered);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/ui/login");
  });

  test("a forged cookie signed with nothing is rejected", async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const forged = `${UI_SESSION_COOKIE}=${nick.developerId}.9999999999999.deadbeef`;

    const response = await uiGet(harness, "/ui/feed", forged);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/ui/login");
  });

  test("the session expires after its bounded lifetime", async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const cookie = await loginUi(harness, nick.apiKey);

    harness.clock.advanceSeconds(UI_SESSION_TTL_SECONDS - 60);
    expect((await uiGet(harness, "/ui/feed", cookie)).status).toBe(200);

    harness.clock.advanceSeconds(120);
    const expired = await uiGet(harness, "/ui/feed", cookie);
    expect(expired.status).toBe(303);
    expect(expired.headers.get("Location")).toBe("/ui/login");
  });

  test("logout clears the cookie and the old cookie stops working", async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const cookie = await loginUi(harness, nick.apiKey);
    const csrf = await fetchCsrfToken(harness, "/ui/feed", cookie);

    const logout = await uiPostForm(harness, "/ui/logout", cookie, {
      _csrf: csrf,
    });

    expect(logout.status).toBe(303);
    expect(logout.headers.get("Location")).toBe("/ui/login");
    const cleared = sessionCookieFrom(logout);
    expect(cleared).not.toBeNull();
    expect(cleared).toContain("Max-Age=0");
    expect(cookiePairFrom(cleared ?? "")).toBe(`${UI_SESSION_COOKIE}=`);
  });
});

describe("ui response headers", () => {
  test("every authed page carries CSP, nosniff, no-referrer and no-store", async () => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const cookie = await loginUi(harness, nick.apiKey);

    for (const path of ["/ui/feed", "/ui/members", "/ui/approvals"]) {
      const response = await uiGet(harness, path, cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Security-Policy")).toBe(
        EXPECTED_CSP,
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("redirects carry the security headers too", async () => {
    const harness = await createTestHarness();

    const response = await uiGet(harness, "/ui/feed", null);

    expect(response.status).toBe(303);
    expect(response.headers.get("Content-Security-Policy")).toBe(EXPECTED_CSP);
  });
});
