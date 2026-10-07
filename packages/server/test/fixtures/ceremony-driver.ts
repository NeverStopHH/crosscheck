/**
 * Drives /ui/webauthn the way the passkey page's script does: a signed-in
 * session, its CSRF token as the `x-crosscheck-csrf` header, the page's
 * Origin, then a software authenticator's answer (fixtures/soft-authenticator.ts).
 * Shared by the ceremony suites that came after ui-passkeys.test.ts.
 */
import { PASSKEY_COOLOFF_HOURS } from "../../src/constants.ts";
import { mintEnrolmentCode } from "../../src/services/passkeys.ts";
import { TEST_WEBAUTHN_ORIGIN } from "../helpers.ts";
import type { TestDeveloper, TestHarness } from "../helpers.ts";
import { fetchCsrfToken, loginUi } from "../ui-helpers.ts";
import { softAuthenticationResponse, softRegistrationResponse } from "./soft-authenticator.ts";
import type { SoftCredential } from "./soft-authenticator.ts";

const SECONDS_PER_HOUR = 3600;

export interface Viewer {
  readonly developer: TestDeveloper;
  readonly cookie: string;
  readonly csrf: string;
}

export interface CeremonyOverrides {
  readonly origin?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MintedCeremony {
  readonly ceremonyId: string;
  readonly publicKey: { readonly challenge: string };
}

export const viewerOf = async (harness: TestHarness, developer: TestDeveloper): Promise<Viewer> => {
  const cookie = await loginUi(harness, developer.apiKey);
  const csrf = await fetchCsrfToken(harness, "/ui/passkeys", cookie);
  return { developer, cookie, csrf };
};

export const ceremony = async (
  harness: TestHarness,
  viewer: Viewer,
  path: "options" | "verify",
  body: Record<string, unknown>,
  overrides: CeremonyOverrides = {},
): Promise<Response> =>
  await harness.app.request(`/ui/webauthn/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: viewer.cookie,
      Origin: overrides.origin ?? TEST_WEBAUTHN_ORIGIN,
      "x-crosscheck-csrf": viewer.csrf,
      ...overrides.headers,
    },
    body: JSON.stringify(body),
  });

export const dataOf = async <T>(response: Response): Promise<T> =>
  ((await response.json()) as { data: T }).data;

export const errorCodeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

/** RP ID of an origin, the way the hub derives it. */
const rpIdOf = (origin: string): string => new URL(origin).hostname;

/** Enrol `credential` through the real ceremony with an admin-minted code, at `origin`. */
export const enrolViaUi = async (
  harness: TestHarness,
  viewer: Viewer,
  credential: SoftCredential,
  origin: string = TEST_WEBAUTHN_ORIGIN,
): Promise<Response> => {
  const { code } = await mintEnrolmentCode({
    db: harness.db,
    developerId: viewer.developer.developerId,
    source: "admin",
    now: harness.clock.now(),
  });
  const fields = { action: "enrol", code, label: "MacBook" };
  const options = await dataOf<MintedCeremony>(await ceremony(harness, viewer, "options", fields, { origin }));
  return ceremony(
    harness,
    viewer,
    "verify",
    {
      ...fields,
      ceremonyId: options.ceremonyId,
      response: softRegistrationResponse({
        credential,
        challenge: options.publicKey.challenge,
        origin,
        rpId: rpIdOf(origin),
      }),
    },
    { origin },
  );
};

/** A day later: the cool-off is over, and the 12-hour UI session has expired, so log in again. */
export const pastCoolOff = (harness: TestHarness, developer: TestDeveloper): Promise<Viewer> => {
  harness.clock.advanceSeconds(PASSKEY_COOLOFF_HOURS * SECONDS_PER_HOUR + 1);
  return viewerOf(harness, developer);
};

export interface AssertionStep {
  /** Runs between options and verify: what changes while the person reads the prompt. */
  readonly between?: () => Promise<void>;
  readonly origin?: string;
  /** The authenticator's counter; a second assertion by one credential must count higher. */
  readonly signCount?: number;
}

/** Options for `fields`, then the authenticator's signature over whatever challenge came back. */
export const assertViaUi = async (
  harness: TestHarness,
  viewer: Viewer,
  credential: SoftCredential,
  fields: Record<string, unknown>,
  step: AssertionStep = {},
): Promise<Response> => {
  const origin = step.origin ?? TEST_WEBAUTHN_ORIGIN;
  const options = await ceremony(harness, viewer, "options", fields, { origin });
  if (options.status !== 200) {
    return options;
  }
  const minted = await dataOf<MintedCeremony>(options);
  await step.between?.();
  return ceremony(
    harness,
    viewer,
    "verify",
    {
      ...fields,
      ceremonyId: minted.ceremonyId,
      response: softAuthenticationResponse({
        credential,
        challenge: minted.publicKey.challenge,
        origin,
        rpId: rpIdOf(origin),
        signCount: step.signCount ?? 1,
      }),
    },
    { origin },
  );
};
