/**
 * /ui/approvals + POST /ui/artifacts/:id/(approve|revoke) — task item 6.
 *
 * DESIGN.md §5 semantics under test: artifacts default needs_approval =
 * owner-only until released. The owner is the developer behind the claim's
 * author session. Authorization is HUB-side (another developer with a valid
 * session and a valid CSRF token of their own still cannot approve), CSRF
 * is enforced on every state-changing POST, and approval flips visibility
 * on the work-context page for other developers.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createTestDeveloper,
  createTestHarness,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import { artifacts } from "../src/db/schema.ts";
import {
  fetchCsrfToken,
  loginUi,
  uiGet,
  uiPostForm,
} from "./ui-helpers.ts";

const SECOND_SESSION_ID = "ses_02";
const PENDING_ARTIFACT_ID = "art_pending";
const VISIBLE_ARTIFACT_ID = "art_visible";
// Distinctive marker + XSS probe; deliberately NOT credential-shaped, so the
// repo-wide gitleaks scan needs no allowlist entry for this file.
const SECRET_CONTENT = "SECRET LOG from staging incident <script>alert(2)</script>";
const TEAM_CONTENT = "harmless stack trace at line 42";

interface ApprovalSetup {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly robin: TestDeveloper;
}

/** Nick owns wc_01/clm_01 with one pending and one team-visible artifact. */
const seedArtifacts = async (): Promise<ApprovalSetup> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, nick.apiKey);
  const robin = await addTestDeveloperWithSession(
    harness,
    "Robin",
    "robin@example.com",
    { id: SECOND_SESSION_ID },
  );
  const posted = await postRecords(harness, nick, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("claim", validClaimBody()),
    ],
  });
  if (posted.data?.accepted !== 2) {
    throw new Error("seeding work context + claim failed");
  }
  // No artifact ingest path exists yet (DESIGN.md §5 lists the table only),
  // so the rows are planted directly — sensitivity semantics are the test.
  await harness.db.insert(artifacts).values([
    {
      id: PENDING_ARTIFACT_ID,
      claimId: "clm_01",
      kind: "log",
      content: SECRET_CONTENT,
      sensitivity: "needs_approval",
      approvedBy: null,
      createdAt: harness.clock.now(),
    },
    {
      id: VISIBLE_ARTIFACT_ID,
      claimId: "clm_01",
      kind: "stack_trace",
      content: TEAM_CONTENT,
      sensitivity: "team_visible",
      approvedBy: null,
      createdAt: harness.clock.now(),
    },
  ]);
  return { harness, nick, robin };
};

const approvePath = `/ui/artifacts/${PENDING_ARTIFACT_ID}/approve`;
const revokePath = `/ui/artifacts/${PENDING_ARTIFACT_ID}/revoke`;

describe("ui approvals listing", () => {
  test("the owner sees their pending artifact with an approve control, escaped", async () => {
    const { harness, nick } = await seedArtifacts();
    const cookie = await loginUi(harness, nick.apiKey);

    const html = await (await uiGet(harness, "/ui/approvals", cookie)).text();

    expect(html).toContain(PENDING_ARTIFACT_ID);
    expect(html).toContain(`action="${approvePath}"`);
    // Content preview is escaped — never raw markup.
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    // team_visible artifacts need no approval and do not clutter the queue.
    expect(html).not.toContain(VISIBLE_ARTIFACT_ID);
  });

  test("another developer's approvals page does not list it", async () => {
    const { harness, robin } = await seedArtifacts();
    const cookie = await loginUi(harness, robin.apiKey);

    const html = await (await uiGet(harness, "/ui/approvals", cookie)).text();

    expect(html).not.toContain(PENDING_ARTIFACT_ID);
    expect(html).not.toContain("SECRET LOG");
  });
});

describe("ui work-context artifact visibility", () => {
  test("unapproved needs_approval content is owner-only; team_visible shows to all", async () => {
    const { harness, nick, robin } = await seedArtifacts();

    const robinHtml = await (
      await uiGet(
        harness,
        "/ui/work-contexts/wc_01",
        await loginUi(harness, robin.apiKey),
      )
    ).text();
    expect(robinHtml).toContain(TEAM_CONTENT);
    expect(robinHtml).not.toContain("SECRET LOG");

    const nickHtml = await (
      await uiGet(
        harness,
        "/ui/work-contexts/wc_01",
        await loginUi(harness, nick.apiKey),
      )
    ).text();
    expect(nickHtml).toContain("SECRET LOG");
    expect(nickHtml).toContain("awaiting approval");
  });
});

describe("ui approve/revoke", () => {
  test("approving without a CSRF token is refused and changes nothing", async () => {
    const { harness, nick, robin } = await seedArtifacts();
    const nickCookie = await loginUi(harness, nick.apiKey);

    const response = await uiPostForm(harness, approvePath, nickCookie, {});

    expect(response.status).toBe(403);
    const robinHtml = await (
      await uiGet(
        harness,
        "/ui/work-contexts/wc_01",
        await loginUi(harness, robin.apiKey),
      )
    ).text();
    expect(robinHtml).not.toContain("SECRET LOG");
  });

  test("another developer cannot approve it, even with their own valid CSRF", async () => {
    const { harness, robin } = await seedArtifacts();
    const robinCookie = await loginUi(harness, robin.apiKey);
    const robinCsrf = await fetchCsrfToken(harness, "/ui/feed", robinCookie);

    const response = await uiPostForm(harness, approvePath, robinCookie, {
      _csrf: robinCsrf,
    });

    // 404, not 403: a non-owner learns nothing about the artifact's existence.
    expect(response.status).toBe(404);
    const robinHtml = await (
      await uiGet(harness, "/ui/work-contexts/wc_01", robinCookie)
    ).text();
    expect(robinHtml).not.toContain("SECRET LOG");
  });

  test("a stolen CSRF token from another session is refused", async () => {
    const { harness, nick, robin } = await seedArtifacts();
    const nickCookie = await loginUi(harness, nick.apiKey);
    const robinCookie = await loginUi(harness, robin.apiKey);
    const nickCsrf = await fetchCsrfToken(harness, "/ui/feed", nickCookie);

    // Robin replays Nick's token with Robin's own session cookie.
    const response = await uiPostForm(harness, approvePath, robinCookie, {
      _csrf: nickCsrf,
    });

    expect(response.status).toBe(403);
  });

  test("the owner approves, everyone sees it; revoke hides it again", async () => {
    const { harness, nick, robin } = await seedArtifacts();
    const nickCookie = await loginUi(harness, nick.apiKey);
    const robinCookie = await loginUi(harness, robin.apiKey);
    const csrf = await fetchCsrfToken(harness, "/ui/approvals", nickCookie);

    const approve = await uiPostForm(harness, approvePath, nickCookie, {
      _csrf: csrf,
    });
    expect(approve.status).toBe(303);
    expect(approve.headers.get("Location")).toBe("/ui/approvals");

    const robinSees = await (
      await uiGet(harness, "/ui/work-contexts/wc_01", robinCookie)
    ).text();
    expect(robinSees).toContain("SECRET LOG");
    // Escaped even when visible.
    expect(robinSees).not.toContain("<script");

    // The queue now offers revoke instead of approve.
    const queue = await (
      await uiGet(harness, "/ui/approvals", nickCookie)
    ).text();
    expect(queue).toContain(`action="${revokePath}"`);

    const revoke = await uiPostForm(harness, revokePath, nickCookie, {
      _csrf: csrf,
    });
    expect(revoke.status).toBe(303);

    const robinAfterRevoke = await (
      await uiGet(harness, "/ui/work-contexts/wc_01", robinCookie)
    ).text();
    expect(robinAfterRevoke).not.toContain("SECRET LOG");
  });

  test("approving a nonexistent artifact 404s", async () => {
    const { harness, nick } = await seedArtifacts();
    const cookie = await loginUi(harness, nick.apiKey);
    const csrf = await fetchCsrfToken(harness, "/ui/feed", cookie);

    const response = await uiPostForm(
      harness,
      "/ui/artifacts/art_missing/approve",
      cookie,
      { _csrf: csrf },
    );

    expect(response.status).toBe(404);
  });
});
