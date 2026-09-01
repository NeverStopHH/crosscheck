/**
 * An account you cannot find again is an account you cannot administer. The
 * hub returns a developer id EXACTLY ONCE — at creation — and every admin
 * surface that follows takes that id as a path parameter, so losing it locks
 * the account out of alias linking (trial finding #7) for good. Nothing listed
 * developers: the web UI holds the ids (services/members.ts) and renders none
 * of them, and the only other way back was reading the hub's own database out
 * from under a running single-connection PGlite.
 *
 * The invariant this file circles: EVERY DEVELOPER THE HUB KNOWS IS REACHABLE
 * FROM THE ADMIN LISTING, WITH THE EMAILS THAT DECIDE WHOSE COMMITS ARE WHOSE
 * — and when the listing cannot show them all it says so, because a page that
 * stops at the cap and stays quiet reads as "that is everyone".
 */
import { describe, expect, test } from "bun:test";

import {
  TEST_ADMIN_TOKEN,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";
import { DEVELOPERS_MAX_LISTED } from "../src/constants.ts";

interface ListedEmail {
  readonly email: string;
  readonly isPrimary: boolean;
}

interface ListedDeveloper {
  readonly id: string;
  readonly name: string;
  readonly emails: readonly ListedEmail[];
}

interface Listing {
  readonly status: number;
  readonly developers: readonly ListedDeveloper[];
  readonly truncated: boolean;
}

const listDevelopers = async (
  harness: TestHarness,
  token: string = TEST_ADMIN_TOKEN,
): Promise<Listing> => {
  const response = await harness.app.request(
    "/api/developers",
    jsonRequest("GET", token),
  );
  if (response.status !== 200) {
    return { status: response.status, developers: [], truncated: false };
  }
  const body = (await response.json()) as {
    data: { developers: ListedDeveloper[]; truncated: boolean };
  };
  return {
    status: response.status,
    developers: body.data.developers,
    truncated: body.data.truncated,
  };
};

const addEmail = async (
  harness: TestHarness,
  developerId: string,
  email: string,
): Promise<number> => {
  const response = await harness.app.request(
    `/api/developers/${encodeURIComponent(developerId)}/emails`,
    jsonRequest("POST", TEST_ADMIN_TOKEN, { email }),
  );
  return response.status;
};

describe("admin developer listing", () => {
  test("an id handed out once at creation is recoverable from the listing", async () => {
    const harness = await createTestHarness();
    const ken = await createTestDeveloper(harness, "Ken", "ken@example.test");

    const listing = await listDevelopers(harness);

    expect(listing.status).toBe(200);
    const found = listing.developers.find((d) => d.id === ken.developerId);
    expect(found).toBeDefined();
    expect(found?.name).toBe("Ken");
  });

  test("the listing carries every linked email, so a missing alias is visible", async () => {
    const harness = await createTestHarness();
    const ken = await createTestDeveloper(harness, "Ken", "ken@work.test");
    expect(await addEmail(harness, ken.developerId, "ken@personal.test")).toBe(200);

    const listing = await listDevelopers(harness);
    const found = listing.developers.find((d) => d.id === ken.developerId);

    expect(found?.emails.map((e) => e.email).toSorted()).toEqual([
      "ken@personal.test",
      "ken@work.test",
    ]);
    expect(found?.emails.filter((e) => e.isPrimary)).toHaveLength(1);
  });

  test("no api key is ever exposed by the listing", async () => {
    const harness = await createTestHarness();
    await createTestDeveloper(harness, "Ken", "ken@example.test");

    const response = await harness.app.request(
      "/api/developers",
      jsonRequest("GET", TEST_ADMIN_TOKEN),
    );
    const raw = await response.text();

    // Asserted BEFORE the body check on purpose: a 404 carries no key either,
    // so without this line the test would pass against a hub that has no
    // listing at all.
    expect(response.status).toBe(200);
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("keyHash");
  });

  test("a caller without the admin token learns nothing", async () => {
    const harness = await createTestHarness();
    await createTestDeveloper(harness, "Ken", "ken@example.test");

    const wrongToken = await listDevelopers(harness, "not-the-admin-token");
    const admin = await listDevelopers(harness);

    expect(wrongToken.status).toBe(401);
    expect(wrongToken.developers).toHaveLength(0);
    // Both halves, or the test passes on a hub that simply has no listing:
    // requireAdmin already answers 401 for a route that does not exist.
    expect(admin.status).toBe(200);
    expect(admin.developers).toHaveLength(1);
  });

  test("a listing that stops at the cap says so instead of reading as complete", async () => {
    const harness = await createTestHarness();
    for (let nth = 0; nth <= DEVELOPERS_MAX_LISTED; nth += 1) {
      await createTestDeveloper(
        harness,
        `Dev ${String(nth)}`,
        `dev${String(nth)}@example.test`,
      );
    }

    const listing = await listDevelopers(harness);

    expect(listing.developers).toHaveLength(DEVELOPERS_MAX_LISTED);
    expect(listing.truncated).toBe(true);
  });

  test("a listing that fits reports itself as complete", async () => {
    const harness = await createTestHarness();
    await createTestDeveloper(harness, "Ken", "ken@example.test");

    const listing = await listDevelopers(harness);

    // Status first: a hub with no listing returns truncated:false from the
    // helper's error path, which would make this pass while proving nothing.
    expect(listing.status).toBe(200);
    expect(listing.truncated).toBe(false);
  });
});
