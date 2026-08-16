/**
 * /ui/members — hub members with presence state (task item 5).
 *
 * Opt-out semantics on this page: an opted-out developer remains a MEMBER —
 * membership is not surveillance — but their live presence/activity is
 * hidden from every other viewer's page. Their own view of themselves keeps
 * both the presence and a note that they are hidden from teammates.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
} from "./helpers.ts";
import {
  loginUi,
  setPresenceOptOutViaApi,
  uiGet,
} from "./ui-helpers.ts";

/**
 * The <li> holding a member's row, isolated so per-row assertions hold:
 * the split prefix (page chrome shows the VIEWER's name) is dropped, and
 * each chunk is cut at its closing tag so a later row or the footer text
 * cannot bleed into the assertion.
 */
const memberRowFor = (html: string, name: string): string => {
  const row = html
    .split('<li class="member"')
    .slice(1)
    .map((chunk) => chunk.split("</li>")[0] ?? chunk)
    .find((chunk) => chunk.includes(name));
  if (row === undefined) {
    throw new Error(`no member row for ${name}`);
  }
  return row;
};

describe("ui member list", () => {
  test("lists every member and shows presence for active sessions", async () => {
    const { harness, developer: nick } = await createHarnessWithSession();
    await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", {
      id: "ses_robin",
    });
    const cookie = await loginUi(harness, nick.apiKey);

    const html = await (await uiGet(harness, "/ui/members", cookie)).text();

    expect(memberRowFor(html, "Nick")).toContain("active");
    expect(memberRowFor(html, "Robin")).toContain("active");
  });

  test("presence disappears when the heartbeat goes stale, membership stays", async () => {
    const { harness, developer: nick } = await createHarnessWithSession();
    const cookie = await loginUi(harness, nick.apiKey);
    harness.clock.advanceSeconds(120);

    const html = await (await uiGet(harness, "/ui/members", cookie)).text();

    const row = memberRowFor(html, "Nick");
    expect(row).not.toContain("active");
  });

  test("an opted-out member shows as a member, never with presence, to others", async () => {
    const { harness, developer: nick } = await createHarnessWithSession();
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: "ses_robin" },
    );
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);
    const nickCookie = await loginUi(harness, nick.apiKey);

    const html = await (await uiGet(harness, "/ui/members", nickCookie)).text();

    const robinRow = memberRowFor(html, "Robin");
    expect(robinRow).not.toContain("active");
    // Nick's own row is untouched by Robin's setting.
    expect(memberRowFor(html, "Nick")).toContain("active");
  });

  test("the opted-out member sees their own presence and their opt-out state", async () => {
    const { harness } = await createHarnessWithSession();
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: "ses_robin" },
    );
    await setPresenceOptOutViaApi(harness, robin.apiKey, true);
    const robinCookie = await loginUi(harness, robin.apiKey);

    const html = await (
      await uiGet(harness, "/ui/members", robinCookie)
    ).text();

    const ownRow = memberRowFor(html, "Robin");
    expect(ownRow).toContain("active");
    expect(ownRow).toContain("presence hidden from teammates");
  });
});
