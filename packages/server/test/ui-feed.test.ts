/**
 * /ui/feed — the human-facing read surface over the events outbox (task
 * item 3). The page must ride the SAME opt-out-filtered events reader the
 * API uses (services/events.ts), so the pin here reads the UI as another
 * developer and expects an opted-out teammate's rows to be gone — and the
 * subject's own rows to survive on their own screen. Untrusted strings that
 * reach the feed (branch names, repos) must arrive HTML-escaped.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  createTestHarness,
  createTestDeveloper,
  recordEnvelope,
  registerTestSession,
  postRecords,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import {
  loginUi,
  setPresenceOptOutViaApi,
  uiGet,
} from "./ui-helpers.ts";

const seedWorkContextWithClaim = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<void> => {
  const posted = await postRecords(harness, developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("claim", validClaimBody()),
    ],
  });
  if (posted.data?.accepted !== 2) {
    throw new Error("seeding work context + claim failed");
  }
};

describe("ui feed", () => {
  test("shows recent activity newest-first with links to the work-context page", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await seedWorkContextWithClaim(harness, developer);
    const cookie = await loginUi(harness, developer.apiKey);

    const response = await uiGet(harness, "/ui/feed", cookie);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/ui/work-contexts/wc_01"');
    expect(html).toContain("Nick");
    // Newest first: the claim event was appended after the work context.
    const claimIndex = html.indexOf("added a claim");
    const contextIndex = html.indexOf("opened work context");
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(contextIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeLessThan(contextIndex);
  });

  test("refreshes itself with a meta refresh, never with script", async () => {
    const { harness, developer } = await createHarnessWithSession();
    const cookie = await loginUi(harness, developer.apiKey);

    const html = await (await uiGet(harness, "/ui/feed", cookie)).text();

    expect(html).toContain('http-equiv="refresh"');
    expect(html).not.toContain("<script");
  });

  test("an opted-out teammate's rows vanish from another developer's UI feed", async () => {
    const { harness, developer: nick } = await createHarnessWithSession();
    await seedWorkContextWithClaim(harness, nick);
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: "ses_robin" },
    );
    await setPresenceOptOutViaApi(harness, nick.apiKey, true);

    const robinCookie = await loginUi(harness, robin.apiKey);
    const robinView = await (
      await uiGet(harness, "/ui/feed", robinCookie)
    ).text();

    // Zero presence of the opted-out subject: no name, no attributed rows.
    expect(robinView).not.toContain("Nick");
    expect(robinView).not.toContain("wc_01");

    // The subject's own screen is unaffected.
    const nickCookie = await loginUi(harness, nick.apiKey);
    const nickView = await (await uiGet(harness, "/ui/feed", nickCookie)).text();
    expect(nickView).toContain("Nick");
    expect(nickView).toContain('href="/ui/work-contexts/wc_01"');
  });

  test("a hostile branch name reaches the feed HTML-escaped, never as markup", async () => {
    const harness = await createTestHarness();
    const mallory = await createTestDeveloper(
      harness,
      "Mallory",
      "mallory@example.com",
    );
    await registerTestSession(harness, mallory.apiKey, {
      id: "ses_mallory",
      branch: '<img src=x onerror=alert(1)>"><b>',
    });
    const cookie = await loginUi(harness, mallory.apiKey);

    const html = await (await uiGet(harness, "/ui/feed", cookie)).text();

    // The payload text may appear — ESCAPED. What must never appear is a
    // real element or an attribute breakout: "<" and '"' both escaped.
    expect(html).not.toContain("<img");
    expect(html).not.toContain('"><b>');
    expect(html).toContain("&lt;img");
    expect(html).toContain("&quot;&gt;&lt;b&gt;");
  });
});

describe("intent updates on the feed (trial finding #16)", () => {
  test("an intent update reads as 'updated work context' with an intent label and no summary text", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, recordEnvelope("work_context", validWorkContextBody()));
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          intent: {
            summary: "SECRET-SHAPED-SENTINEL the feed must never print",
            provenance: "derived",
            confidence: 0.4,
            capturedAt: "2026-07-24T09:02:00.000Z",
          },
        }),
      ),
    );
    const cookie = await loginUi(harness, developer.apiKey);

    // Act
    const html = await (await uiGet(harness, "/ui/feed", cookie)).text();

    // Assert: the phrase and the field name, never the sentence
    expect(html).toContain("updated work context");
    expect(html).toContain(">intent</span>");
    expect(html).not.toContain("SECRET-SHAPED-SENTINEL");
  });
});
