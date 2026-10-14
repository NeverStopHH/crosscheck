/**
 * /ui/approvals and the artifact release ceremony — task item 6, and review
 * M2.
 *
 * DESIGN.md §5 semantics under test: artifacts default needs_approval =
 * owner-only until released. The owner is the developer behind the claim's
 * author session. Authorization is HUB-side (another developer with a usable
 * passkey of their own still cannot name the artifact), and approval flips
 * visibility on the work-context page for other developers.
 *
 * RELEASE IS A PASSKEY CEREMONY. Any API key opens a /ui session, so an agent
 * holding the key could release its person's artifact with one form post.
 * Approve and revoke now run through /ui/webauthn with the 24-hour cool-off,
 * and POST /ui/artifacts/:id/(approve|revoke) only refuses.
 */
import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  TEST_ADMIN_TOKEN,
  addTestDeveloperWithSession,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness, TestHarnessOptions } from "./helpers.ts";
import { artifacts } from "../src/db/schema.ts";
import { setArtifactApproval } from "../src/services/artifacts.ts";
import { performOnArtifact } from "../src/routes/ui-ceremony-artifacts.ts";
import type { ArtifactFields } from "../src/routes/ui-ceremony-artifacts.ts";
import type { AppDeps } from "../src/types.ts";
import {
  assertViaUi,
  ceremony,
  dataOf,
  enrolViaUi,
  errorCodeOf,
  pastCoolOff,
  viewerOf,
} from "./fixtures/ceremony-driver.ts";
import { createSoftCredential } from "./fixtures/soft-authenticator.ts";
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
const seedArtifacts = async (options: TestHarnessOptions = {}): Promise<ApprovalSetup> => {
  const harness = await createTestHarness(options);
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
    expect(html).toContain('data-ceremony="approve_artifact"');
    expect(html).toContain(`name="subjectId" value="${PENDING_ARTIFACT_ID}"`);
    // Content preview is escaped — never raw markup. (The page's one script
    // tag is the hub's own passkey.js, a ceremony page since review M2.)
    expect(html).not.toContain("<script>alert");
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

/** Whether Robin, a teammate, can read the pending artifact's content on its tree page. */
const robinCanRead = async (harness: TestHarness, robin: TestDeveloper): Promise<boolean> => {
  const html = await (
    await uiGet(harness, "/ui/work-contexts/wc_01", await loginUi(harness, robin.apiKey))
  ).text();
  // Escaped even when visible.
  expect(html).not.toContain("<script");
  return html.includes("SECRET LOG");
};

/** Nick, with a passkey enrolled and past its cool-off, signed in again a day later. */
const nickWithUsablePasskey = async (setup: ApprovalSetup) => {
  const credential = createSoftCredential();
  await enrolViaUi(setup.harness, await viewerOf(setup.harness, setup.nick), credential);
  return { credential, viewer: await pastCoolOff(setup.harness, setup.nick) };
};

const releaseFields = { action: "approve_artifact", subjectId: PENDING_ARTIFACT_ID };
const withdrawFields = { action: "revoke_artifact", subjectId: PENDING_ARTIFACT_ID };

describe("releasing an artifact takes a passkey (review M2)", () => {
  test("a session opened with the API key cannot release it with a form post, CSRF and all", async () => {
    // Arrange — exactly what an agent holding the key can do: log in, read the token, post
    const setup = await seedArtifacts();
    const cookie = await loginUi(setup.harness, setup.nick.apiKey);
    const csrf = await fetchCsrfToken(setup.harness, "/ui/feed", cookie);

    // Act
    const approve = await uiPostForm(setup.harness, approvePath, cookie, { _csrf: csrf });

    // Assert
    expect(approve.status).toBe(403);
    expect(await approve.text()).toContain("takes your passkey now");
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
  });

  test("the owner releases it with a usable passkey, and revoking with the passkey hides it again", async () => {
    // Arrange
    const setup = await seedArtifacts();
    const nick = await nickWithUsablePasskey(setup);

    // Act + Assert: release
    const released = await assertViaUi(setup.harness, nick.viewer, nick.credential, releaseFields);
    expect(released.status).toBe(200);
    expect((await dataOf<{ message: string }>(released)).message).toContain("Released");
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(true);

    // The queue now offers the plain revoke form instead of the release.
    const queue = await (await uiGet(setup.harness, "/ui/approvals", nick.viewer.cookie)).text();
    expect(queue).toContain(`action="${revokePath}"`);

    // Act + Assert: withdraw with the optional ceremony, still accepted
    const withdrawn = await assertViaUi(setup.harness, nick.viewer, nick.credential, withdrawFields, { signCount: 2 });
    expect(withdrawn.status).toBe(200);
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
  });

  test("a passkey still cooling off releases nothing", async () => {
    // Arrange — enrolled a minute ago; the person's day has not passed
    const setup = await seedArtifacts();
    const viewer = await viewerOf(setup.harness, setup.nick);
    const credential = createSoftCredential();
    await enrolViaUi(setup.harness, viewer, credential);

    // Act
    const response = await assertViaUi(setup.harness, viewer, credential, releaseFields);

    // Assert
    expect(response.status).toBe(422);
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
  });

  test("another developer's ceremony cannot name the artifact, with a usable passkey of their own", async () => {
    // Arrange
    const setup = await seedArtifacts();
    const robinsKey = createSoftCredential();
    await enrolViaUi(setup.harness, await viewerOf(setup.harness, setup.robin), robinsKey);
    const robin = await pastCoolOff(setup.harness, setup.robin);

    // Act
    const response = await ceremony(setup.harness, robin, "options", releaseFields);

    // Assert — the same answer as an id that does not exist
    expect(response.status).toBe(422);
    expect(await errorCodeOf(response)).toBe("unknown_artifact");
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
  });

  test("the signature covers the content shown: content changed before verify releases nothing", async () => {
    // Arrange
    const setup = await seedArtifacts();
    const nick = await nickWithUsablePasskey(setup);
    const swapContent = async (): Promise<void> => {
      await setup.harness.db
        .update(artifacts)
        .set({ content: "SECRET LOG, a different one, written after the page was shown" })
        .where(eq(artifacts.id, PENDING_ARTIFACT_ID));
    };

    // Act
    const response = await assertViaUi(setup.harness, nick.viewer, nick.credential, releaseFields, {
      between: swapContent,
    });

    // Assert
    expect(response.status).toBe(422);
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
  });

  test("the release UPDATE writes only the content that was signed (review L1)", async () => {
    // Arrange — content with non-ASCII bytes, so the SQL digest must agree with
    // the JS one byte for byte (UTF-8, hex)
    const setup = await seedArtifacts();
    const content = "SECRET LOG — naïve Ünïcode ✓";
    await setup.harness.db.update(artifacts).set({ content }).where(eq(artifacts.id, PENDING_ARTIFACT_ID));
    const signed = createHash("sha256").update(content).digest("hex");
    const other = createHash("sha256").update("the content the page showed").digest("hex");
    const { nick } = setup;

    // Act
    const mismatched = await setArtifactApproval(setup.harness.db, nick.developerId, PENDING_ARTIFACT_ID, true, other);
    const visibleAfterMismatch = await robinCanRead(setup.harness, setup.robin);
    const matched = await setArtifactApproval(setup.harness.db, nick.developerId, PENDING_ARTIFACT_ID, true, signed);

    // Assert
    expect(mismatched).toBe("not_found");
    expect(visibleAfterMismatch).toBe(false);
    expect(matched).toBe("updated");
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(true);
  });

  test("a verified release hands the signed digest to its write: other signed terms release nothing", async () => {
    // Arrange — the ceremony's last step, as verify calls it once the signature held
    const setup = await seedArtifacts();
    const deps = { db: setup.harness.db } as unknown as AppDeps;
    const signedOver = { contentDigest: createHash("sha256").update("what the page showed").digest("hex") };

    // Act
    const outcome = await performOnArtifact(deps, setup.nick.developerId, releaseFields as ArtifactFields, signedOver);

    // Assert
    expect(outcome).toEqual({ ceremonyRefusal: "unknown_artifact" });
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
  });

  test("a nonexistent artifact is refused as unknown", async () => {
    // Arrange
    const setup = await seedArtifacts();
    const nick = await nickWithUsablePasskey(setup);

    // Act
    const response = await ceremony(setup.harness, nick.viewer, "options", {
      action: "approve_artifact",
      subjectId: "art_missing",
    });

    // Assert
    expect(response.status).toBe(422);
    expect(await errorCodeOf(response)).toBe("unknown_artifact");
  });

  test("the approvals page is a ceremony page: the passkey CSP and its one script", async () => {
    // Arrange
    const setup = await seedArtifacts();
    const cookie = await loginUi(setup.harness, setup.nick.apiKey);

    // Act
    const response = await uiGet(setup.harness, "/ui/approvals", cookie);
    const html = await response.text();

    // Assert
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(html).toContain('src="/ui/passkey.js"');
    expect(html).toContain('data-ceremony="approve_artifact"');
  });

  test("a hub with no passkey origin says so, offers no ceremony, and still refuses the form", async () => {
    // Arrange — what the waiver page does on such a hub, mirrored
    const setup = await seedArtifacts({ webauthnOrigins: [] });
    const cookie = await loginUi(setup.harness, setup.nick.apiKey);
    const csrf = await fetchCsrfToken(setup.harness, "/ui/feed", cookie);

    // Act
    const html = await (await uiGet(setup.harness, "/ui/approvals", cookie)).text();
    const posted = await uiPostForm(setup.harness, approvePath, cookie, { _csrf: csrf });

    // Assert
    expect(html).toContain("CROSSCHECK_WEBAUTHN_ORIGINS");
    expect(html).not.toContain('src="/ui/passkey.js"');
    expect(posted.status).toBe(403);
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
  });
});

/** A release made outside the ceremony, as a 0.10 form post by an agent would have left it. */
const releasedTheOldWay = async (setup: ApprovalSetup): Promise<void> => {
  await setup.harness.db
    .update(artifacts)
    .set({ approvedBy: setup.nick.developerId })
    .where(eq(artifacts.id, PENDING_ARTIFACT_ID));
};

describe("withdrawing a release takes no passkey (review of the hub hardening, M3)", () => {
  test("the owner withdraws with a plain form post, holding no passkey at all", async () => {
    // Arrange
    const setup = await seedArtifacts();
    await releasedTheOldWay(setup);
    const cookie = await loginUi(setup.harness, setup.nick.apiKey);
    const csrf = await fetchCsrfToken(setup.harness, "/ui/approvals", cookie);
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(true);

    // Act
    const response = await uiPostForm(setup.harness, revokePath, cookie, { _csrf: csrf });

    // Assert
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/ui/approvals");
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
  });

  test("without the session's CSRF token the form withdraws nothing", async () => {
    // Arrange
    const setup = await seedArtifacts();
    await releasedTheOldWay(setup);
    const cookie = await loginUi(setup.harness, setup.nick.apiKey);

    // Act
    const response = await uiPostForm(setup.harness, revokePath, cookie, {});

    // Assert
    expect(response.status).toBe(403);
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(true);
  });

  test("a teammate's form cannot withdraw it, even with their own valid CSRF: the UPDATE checks the owner", async () => {
    // Arrange
    const setup = await seedArtifacts();
    await releasedTheOldWay(setup);
    const robinCookie = await loginUi(setup.harness, setup.robin.apiKey);
    const robinCsrf = await fetchCsrfToken(setup.harness, "/ui/feed", robinCookie);

    // Act
    const response = await uiPostForm(setup.harness, revokePath, robinCookie, { _csrf: robinCsrf });

    // Assert — 404, the same answer as an id that does not exist
    expect(response.status).toBe(404);
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(true);
  });

  test("the release UPDATE itself refuses a non-owner, whatever the caller checked before it", async () => {
    // Arrange
    const setup = await seedArtifacts();

    // Act
    const outcome = await setArtifactApproval(setup.harness.db, setup.robin.developerId, PENDING_ARTIFACT_ID, true);

    // Assert
    expect(outcome).toBe("not_found");
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
  });

  test("the operator re-hides any release with the admin token; a developer's key is refused", async () => {
    // Arrange
    const setup = await seedArtifacts();
    await releasedTheOldWay(setup);
    const path = `/api/artifacts/${PENDING_ARTIFACT_ID}/withdraw`;

    // Act
    const byKey = await setup.harness.app.request(path, jsonRequest("POST", setup.nick.apiKey, {}));
    const stillVisible = await robinCanRead(setup.harness, setup.robin);
    const byAdmin = await setup.harness.app.request(path, jsonRequest("POST", TEST_ADMIN_TOKEN, {}));
    const missing = await setup.harness.app.request(
      "/api/artifacts/art_missing/withdraw",
      jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
    );

    // Assert
    expect(byKey.status).toBe(401);
    expect(stillVisible).toBe(true);
    expect(byAdmin.status).toBe(200);
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
    expect(missing.status).toBe(404);
  });

  test("a hub with no passkey origin still lets the owner withdraw", async () => {
    // Arrange
    const setup = await seedArtifacts({ webauthnOrigins: [] });
    await releasedTheOldWay(setup);
    const cookie = await loginUi(setup.harness, setup.nick.apiKey);
    const csrf = await fetchCsrfToken(setup.harness, "/ui/approvals", cookie);

    // Act
    const response = await uiPostForm(setup.harness, revokePath, cookie, { _csrf: csrf });

    // Assert
    expect(response.status).toBe(303);
    expect(await robinCanRead(setup.harness, setup.robin)).toBe(false);
  });
});
