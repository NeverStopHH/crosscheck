/**
 * The passkey ceremonies end to end, the way a browser drives them (1.0 spec
 * 04a §5–§6): log in with the api key, read the CSRF token off the page, ask
 * /ui/webauthn/options with the page's Origin, sign with an authenticator,
 * post the answer to /ui/webauthn/verify.
 *
 * The authenticator is the software one in fixtures/ — the capability 04a
 * §8.1 names as the residue, used here to prove the hub's side holds: the
 * cool-off, the terms binding, another developer's passkey, the CSRF header,
 * the origin and the page's CSP.
 */
import { describe, expect, test } from "bun:test";

import { PASSKEY_COOLOFF_HOURS } from "../src/constants.ts";
import { fenceWaivers, passkeys, pins } from "../src/db/schema.ts";
import { mintEnrolmentCode } from "../src/services/passkeys.ts";
import { requestWaiver } from "../src/services/waiver-requests.ts";
import { readLiveWaiver } from "../src/services/waivers.ts";
import {
  createSoftCredential,
  softAuthenticationResponse,
  softRegistrationResponse,
} from "./fixtures/soft-authenticator.ts";
import type { SoftCredential } from "./fixtures/soft-authenticator.ts";
import {
  TEST_WEBAUTHN_ORIGIN,
  createTestDeveloper,
  createTestHarness,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";
import { fetchCsrfToken, loginUi, uiGet, uiPostForm } from "./ui-helpers.ts";

const REPO = "github.com/acme/api";
const PIN = "pin_fence";
const HOUR = 3_600_000;
const RP_ID = "localhost";

interface Viewer {
  readonly developer: TestDeveloper;
  readonly cookie: string;
  readonly csrf: string;
}

const viewerOf = async (harness: TestHarness, developer: TestDeveloper): Promise<Viewer> => {
  const cookie = await loginUi(harness, developer.apiKey);
  const csrf = await fetchCsrfToken(harness, "/ui/passkeys", cookie);
  return { developer, cookie, csrf };
};

const ceremony = async (
  harness: TestHarness,
  viewer: Viewer,
  path: "options" | "verify",
  body: Record<string, unknown>,
  overrides: { readonly origin?: string; readonly csrf?: string | null } = {},
): Promise<Response> =>
  harness.app.request(`/ui/webauthn/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: viewer.cookie,
      Origin: overrides.origin ?? TEST_WEBAUTHN_ORIGIN,
      ...(overrides.csrf === null ? {} : { "x-crosscheck-csrf": overrides.csrf ?? viewer.csrf }),
    },
    body: JSON.stringify(body),
  });

const dataOf = async <T>(response: Response): Promise<T> =>
  ((await response.json()) as { data: T }).data;

const setup = async () => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  const ken = await createTestDeveloper(harness, "Ken", "ken@example.com");
  await harness.db.insert(pins).values({
    id: PIN,
    repo: REPO,
    surface: "the refresh path keeps working",
    verifiedBy: nick.developerId,
    verifiedAtCommit: "a1b2c3d",
    verifiedAt: new Date(harness.clock.now().getTime() - HOUR),
    checkRecipe: null,
    captureMode: "human",
    createdAt: new Date(harness.clock.now().getTime() - HOUR),
  });
  return { harness, nick, ken };
};

/** Enrol `credential` through the real UI ceremony with an admin-minted code. */
const enrolViaUi = async (
  harness: TestHarness,
  viewer: Viewer,
  credential: SoftCredential,
): Promise<Response> => {
  const { code } = await mintEnrolmentCode({
    db: harness.db,
    developerId: viewer.developer.developerId,
    source: "admin",
    now: harness.clock.now(),
  });
  const fields = { action: "enrol", code, label: "MacBook" };
  const options = await dataOf<{ ceremonyId: string; publicKey: { challenge: string } }>(
    await ceremony(harness, viewer, "options", fields),
  );
  return ceremony(harness, viewer, "verify", {
    ...fields,
    ceremonyId: options.ceremonyId,
    response: softRegistrationResponse({
      credential,
      challenge: options.publicKey.challenge,
      origin: TEST_WEBAUTHN_ORIGIN,
      rpId: RP_ID,
    }),
  });
};

/**
 * A day later. The 12-hour UI session has expired by then — as it would for
 * the person — so the viewer logs in again, exactly as they would.
 */
const pastCoolOff = (harness: TestHarness, developer: TestDeveloper): Promise<Viewer> => {
  harness.clock.advanceSeconds(PASSKEY_COOLOFF_HOURS * 3600 + 1);
  return viewerOf(harness, developer);
};

const pendingRequest = async (harness: TestHarness, requestedBy: string): Promise<string> => {
  const outcome = await requestWaiver({
    db: harness.db,
    repo: REPO,
    pinId: PIN,
    pinVersion: 1,
    requestedBy,
    reason: "Rollout is blocked; the fix lands Monday",
    expiresAt: new Date(harness.clock.now().getTime() + 48 * HOUR),
    now: harness.clock.now(),
  });
  if (!("id" in outcome)) throw new Error(outcome.refusal);
  return outcome.id;
};

/** Run an approval ceremony; `signedExpiresAt` lets a test submit different terms than it signed. */
const approveViaUi = async (
  harness: TestHarness,
  viewer: Viewer,
  credential: SoftCredential,
  requestId: string,
  expiresAt: string,
  signedExpiresAt: string = expiresAt,
): Promise<Response> => {
  const reason = "approved after reading the request";
  const options = await ceremony(harness, viewer, "options", {
    action: "approve",
    subjectId: requestId,
    expiresAt: signedExpiresAt,
    reason,
  });
  if (options.status !== 200) return options;
  const data = await dataOf<{ ceremonyId: string; publicKey: { challenge: string } }>(options);
  return ceremony(harness, viewer, "verify", {
    action: "approve",
    subjectId: requestId,
    expiresAt,
    reason,
    ceremonyId: data.ceremonyId,
    response: softAuthenticationResponse({
      credential,
      challenge: data.publicKey.challenge,
      origin: TEST_WEBAUTHN_ORIGIN,
      rpId: RP_ID,
      signCount: 1,
    }),
  });
};

const live = (harness: TestHarness) =>
  readLiveWaiver({ db: harness.db, repo: REPO, pinId: PIN, pinVersion: 1, now: harness.clock.now() });

describe("enrolling through the page", () => {
  test("an admin code and a registration enrol a passkey that is cooling off", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const viewer = await viewerOf(harness, nick);

    // Act
    const response = await enrolViaUi(harness, viewer, createSoftCredential());

    // Assert
    expect(response.status).toBe(200);
    const rows = await harness.db.select().from(passkeys);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usableFrom.getTime()).toBeGreaterThan(harness.clock.now().getTime());
  });

  test("a ceremony without the CSRF header is refused before anything is minted", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const viewer = await viewerOf(harness, nick);

    // Act
    const response = await ceremony(
      harness,
      viewer,
      "options",
      { action: "enrol", code: "AAAA-AAAA-AAAA-AAAA", label: "MacBook" },
      { csrf: null },
    );

    // Assert
    expect(response.status).toBe(403);
  });

  test("a page opened at an origin the hub does not accept gets no ceremony", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const viewer = await viewerOf(harness, nick);
    const { code } = await mintEnrolmentCode({
      db: harness.db,
      developerId: nick.developerId,
      source: "admin",
      now: harness.clock.now(),
    });

    // Act
    const response = await ceremony(
      harness,
      viewer,
      "options",
      { action: "enrol", code, label: "MacBook" },
      { origin: "https://evil.example" },
    );

    // Assert
    expect(response.status).toBe(422);
  });

  test("a localhost ceremony from a peer that is not this machine is refused", async () => {
    // Arrange — localhost names a different machine for every browser; an
    // agent on the person's other device could serve its own page there.
    for (const peerAddress of ["100.64.0.7", null]) {
      const harness = await createTestHarness({ peerAddress });
      const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
      const viewer = await viewerOf(harness, nick);
      const { code } = await mintEnrolmentCode({
        db: harness.db,
        developerId: nick.developerId,
        source: "admin",
        now: harness.clock.now(),
      });

      // Act
      const response = await ceremony(harness, viewer, "options", { action: "enrol", code, label: "MacBook" });

      // Assert — an unknown peer is not taken for this machine either.
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("origin_not_local");
    }
  });
});

describe("approving through the page", () => {
  test("a verify refused before the signature check spends its ceremony", async () => {
    // Arrange — a key that cannot sign here is refused before verifyAssertion;
    // the same ceremony must not then be finishable with the right key.
    const { harness, nick, ken } = await setup();
    const kensKey = createSoftCredential();
    await enrolViaUi(harness, await viewerOf(harness, ken), kensKey);
    const kenViewer = await pastCoolOff(harness, ken);
    const requestId = await pendingRequest(harness, nick.developerId);
    const until = new Date(harness.clock.now().getTime() + 24 * HOUR).toISOString();
    const fields = { action: "approve", subjectId: requestId, expiresAt: until, reason: "ok" };
    const options = await dataOf<{ ceremonyId: string; publicKey: { challenge: string } }>(
      await ceremony(harness, kenViewer, "options", fields),
    );
    const answerWith = (credential: SoftCredential) =>
      ceremony(harness, kenViewer, "verify", {
        ...fields,
        ceremonyId: options.ceremonyId,
        response: softAuthenticationResponse({
          credential,
          challenge: options.publicKey.challenge,
          origin: TEST_WEBAUTHN_ORIGIN,
          rpId: RP_ID,
          signCount: 1,
        }),
      });

    // Act
    const stranger = await answerWith(createSoftCredential());
    const retry = await answerWith(kensKey);

    // Assert
    expect(stranger.status).toBe(422);
    expect(retry.status).toBe(422);
    expect(((await retry.json()) as { error: { code: string } }).error.code).toBe("unknown_ceremony");
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(0);
  });

  test("PK-3: a usable passkey approves a request and the fence opens with passkey authority", async () => {
    // Arrange
    const { harness, nick, ken } = await setup();
    const kensKey = createSoftCredential();
    await enrolViaUi(harness, await viewerOf(harness, ken), kensKey);
    const kenViewer = await pastCoolOff(harness, ken);
    const requestId = await pendingRequest(harness, nick.developerId);
    const until = new Date(harness.clock.now().getTime() + 24 * HOUR).toISOString();

    // Act
    const response = await approveViaUi(harness, kenViewer, kensKey, requestId, until);

    // Assert
    expect(response.status).toBe(200);
    const waiver = await live(harness);
    expect(waiver?.authority).toBe("passkey");
    expect(waiver?.grantedByName).toBe("Ken");
    expect(waiver?.expiresAt).toBe(until);
  });

  test("PK-7: a passkey still cooling off cannot approve", async () => {
    // Arrange
    const { harness, nick, ken } = await setup();
    const kenViewer = await viewerOf(harness, ken);
    const kensKey = createSoftCredential();
    await enrolViaUi(harness, kenViewer, kensKey);
    const requestId = await pendingRequest(harness, nick.developerId);
    const until = new Date(harness.clock.now().getTime() + 24 * HOUR).toISOString();

    // Act
    const response = await approveViaUi(harness, kenViewer, kensKey, requestId, until);

    // Assert
    expect(response.status).toBe(422);
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(0);
  });

  test("PK-4: terms changed between options and verify open nothing", async () => {
    // Arrange
    const { harness, nick, ken } = await setup();
    const kensKey = createSoftCredential();
    await enrolViaUi(harness, await viewerOf(harness, ken), kensKey);
    const kenViewer = await pastCoolOff(harness, ken);
    const requestId = await pendingRequest(harness, nick.developerId);
    const signed = new Date(harness.clock.now().getTime() + 2 * HOUR).toISOString();
    const submitted = new Date(harness.clock.now().getTime() + 40 * HOUR).toISOString();

    // Act
    const response = await approveViaUi(harness, kenViewer, kensKey, requestId, submitted, signed);

    // Assert
    expect(response.status).toBe(422);
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(0);
  });

  test("PK-9: another developer's passkey cannot approve in my session", async () => {
    // Arrange — Ken's passkey, Nick's session: the credential is not Nick's.
    const { harness, nick, ken } = await setup();
    const kensKey = createSoftCredential();
    const nicksKey = createSoftCredential();
    await enrolViaUi(harness, await viewerOf(harness, ken), kensKey);
    await enrolViaUi(harness, await viewerOf(harness, nick), nicksKey);
    const nickViewer = await pastCoolOff(harness, nick);
    const requestId = await pendingRequest(harness, ken.developerId);
    const until = new Date(harness.clock.now().getTime() + 24 * HOUR).toISOString();

    // Act
    const response = await approveViaUi(harness, nickViewer, kensKey, requestId, until);

    // Assert
    expect(response.status).toBe(422);
    expect(await harness.db.select().from(fenceWaivers)).toHaveLength(0);
  });
});

describe("the pages themselves", () => {
  test("only the passkey pages may run a same-origin script; the rest stay script-free", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const cookie = await loginUi(harness, nick.apiKey);

    // Act
    const waivers = await uiGet(harness, "/ui/waivers", cookie);
    const feed = await uiGet(harness, "/ui/feed", cookie);

    // Assert
    expect(waivers.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(feed.headers.get("Content-Security-Policy")).not.toContain("script-src");
    expect(await waivers.text()).toContain('src="/ui/passkey.js"');
  });

  test("a pending request is on the approval page with its terms", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const cookie = await loginUi(harness, nick.apiKey);
    await pendingRequest(harness, nick.developerId);

    // Act
    const html = await (await uiGet(harness, "/ui/waivers", cookie)).text();

    // Assert
    expect(html).toContain("the refresh path keeps working");
    expect(html).toContain("Rollout is blocked; the fix lands Monday");
    expect(html).toContain('data-ceremony="approve"');
    // Two pins can share a surface sentence; the id is what tells them apart.
    expect(html).toContain(`pin ${PIN}`);
  });

  test("its owner revokes a cooling-off passkey with the plain form", async () => {
    // Arrange
    const { harness, nick } = await setup();
    const viewer = await viewerOf(harness, nick);
    await enrolViaUi(harness, viewer, createSoftCredential());
    const [row] = await harness.db.select().from(passkeys);

    // Act
    const response = await uiPostForm(
      harness,
      `/ui/passkeys/${row?.id ?? ""}/revoke`,
      viewer.cookie,
      { _csrf: viewer.csrf },
    );

    // Assert
    expect(response.status).toBe(303);
    const [after] = await harness.db.select().from(passkeys);
    expect(after?.revokedByKind).toBe("owner");
  });

  test("a hub configured with no origin says so instead of offering a ceremony", async () => {
    // Arrange
    const harness = await createTestHarness({ webauthnOrigins: [] });
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const cookie = await loginUi(harness, nick.apiKey);

    // Act
    const html = await (await uiGet(harness, "/ui/passkeys", cookie)).text();

    // Assert
    expect(html).toContain("CROSSCHECK_WEBAUTHN_ORIGINS");
    expect(html).not.toContain('data-ceremony="enrol"');
  });
});
