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
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  TEST_ADMIN_TOKEN,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";
import { DEVELOPERS_MAX_LISTED } from "../src/constants.ts";
import { developerEmails } from "../src/db/schema.ts";
import {
  MAX_EMAILS_PER_DEVELOPER,
  readDeveloperPage,
} from "../src/services/developers.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/**
 * The single line a document devotes to a subject, addressed by a phrase
 * inside it — so an assertion cannot pass on prose elsewhere in the file that
 * happens to carry the same words. DESIGN.md writes one risk per line, and
 * §10 numbers them, so a line IS the unit here.
 */
const lineContaining = (document: string, marker: string): string => {
  const line = document.split("\n").find((text) => text.includes(marker));
  if (line === undefined) {
    throw new Error(`no line in the document contains: ${marker}`);
  }
  return line;
};

interface ListedEmail {
  readonly email: string;
  readonly isPrimary: boolean;
}

interface ListedDeveloper {
  readonly id: string;
  readonly name: string;
  readonly emails: readonly ListedEmail[];
  readonly emailsTruncated: boolean;
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

  // Walked across the cap rather than asserted once past it. `truncated` is a
  // one-comparison contract, so the only place an error can live is the
  // comparison itself, and a test that only ever sees cap+1 pins the flag
  // being TRUE while leaving the operator `>` free: `>=` reports a complete
  // 200-developer team as cut short, which sends an admin looking for a
  // developer among invisible rows that do not exist and back to creating a
  // second account for someone who already has one. Three points, one hub —
  // seeded once and grown across the boundary, so the walk costs what a
  // single cap+1 test used to.
  test("the cut is decided at the cap itself, not one either side of it", async () => {
    const harness = await createTestHarness();
    let seeded = 0;
    const growTo = async (total: number): Promise<void> => {
      while (seeded < total) {
        await createTestDeveloper(
          harness,
          `Dev ${String(seeded)}`,
          `dev${String(seeded)}@example.test`,
        );
        seeded += 1;
      }
    };

    await growTo(DEVELOPERS_MAX_LISTED - 1);
    const belowCap = await listDevelopers(harness);
    await growTo(DEVELOPERS_MAX_LISTED);
    const atCap = await listDevelopers(harness);
    await growTo(DEVELOPERS_MAX_LISTED + 1);
    const pastCap = await listDevelopers(harness);

    expect(belowCap.developers).toHaveLength(DEVELOPERS_MAX_LISTED - 1);
    expect(belowCap.truncated).toBe(false);
    // The load-bearing point: a page that is exactly full is COMPLETE, and
    // saying otherwise is as dishonest as the silence the flag exists to end.
    expect(atCap.developers).toHaveLength(DEVELOPERS_MAX_LISTED);
    expect(atCap.truncated).toBe(false);
    expect(pastCap.developers).toHaveLength(DEVELOPERS_MAX_LISTED);
    expect(pastCap.truncated).toBe(true);
  });

  // The one property of this listing that the listing itself cannot show. The
  // page is sliced to the cap in memory, so a read of the WHOLE developers
  // table and a read of cap+1 rows answer identically — same 200 developers,
  // same `truncated`, no field that counts rows — and the cap's stated reason
  // for existing ("the read stays bounded by a constant like every other
  // listing here") is therefore provable only against the read itself. Asserted
  // with more developers in the hub than the bound allows, because a bound is
  // only observable when something is on the far side of it.
  test("the read stops one row past the cap however big the team is", async () => {
    const harness = await createTestHarness();
    for (let nth = 0; nth < DEVELOPERS_MAX_LISTED + 2; nth += 1) {
      await createTestDeveloper(
        harness,
        `Dev ${String(nth)}`,
        `dev${String(nth)}@example.test`,
      );
    }

    const rows = await readDeveloperPage(harness.db);

    // Exactly, not at-most: one row over the cap is what tells a full page
    // from a cut one, and no row beyond that is ever looked at again.
    expect(rows).toHaveLength(DEVELOPERS_MAX_LISTED + 1);
  });

  // `truncated` covers the developer axis only, and the emails have a cap of
  // their own. A developer can hold more rows than the cap — `addDeveloperEmail`
  // reads the capped list and then inserts outside a transaction, so concurrent
  // links race past it — and the state is what matters here, not the race, so
  // it is constructed directly rather than rolled for. What the listing did
  // with it was report ten addresses and `truncated: false`: an admin auditing
  // who is linked to what saw a smaller set than the one absence matching acts
  // on, since that join reads developer_emails unbounded, and re-adding an
  // address they could not see answered "this developer's email list is full".
  test("a developer with more addresses than the cap is not shown as complete", async () => {
    const harness = await createTestHarness();
    const ken = await createTestDeveloper(harness, "Ken", "ken@work.test");
    const hidden = ["hidden1@ex.test", "hidden2@ex.test", "hidden3@ex.test"];
    for (let nth = 0; nth < MAX_EMAILS_PER_DEVELOPER - 1; nth += 1) {
      expect(await addEmail(harness, ken.developerId, `alias${String(nth)}@ex.test`)).toBe(200);
    }
    await harness.db.insert(developerEmails).values(
      hidden.map((email) => ({
        email,
        developerId: ken.developerId,
        isPrimary: false,
        createdAt: harness.clock.now(),
      })),
    );

    const listing = await listDevelopers(harness);
    const found = listing.developers.find((d) => d.id === ken.developerId);

    // The page itself IS complete — one developer, nothing cut — so the
    // developer-axis flag cannot be the one that carries this.
    expect(listing.truncated).toBe(false);
    expect(found?.emails).toHaveLength(MAX_EMAILS_PER_DEVELOPER);
    // Gone from the answer, not merely counted: these addresses reach no admin
    // surface — GET /api/developers/<id>/emails caps at ten as well — while
    // absence matching keeps attributing their commits. The flag is the only
    // thing that tells an admin the set they are auditing is not the set the
    // hub acts on.
    const shown = found?.emails.map((email) => email.email) ?? [];
    for (const address of hidden) {
      expect(shown).not.toContain(address);
    }
    expect(found?.emailsTruncated).toBe(true);
  });

  test("a developer inside the email cap is not accused of hiding addresses", async () => {
    const harness = await createTestHarness();
    const ken = await createTestDeveloper(harness, "Ken", "ken@work.test");
    for (let nth = 0; nth < MAX_EMAILS_PER_DEVELOPER - 1; nth += 1) {
      expect(await addEmail(harness, ken.developerId, `alias${String(nth)}@ex.test`)).toBe(200);
    }

    const listing = await listDevelopers(harness);
    const found = listing.developers.find((d) => d.id === ken.developerId);

    // Exactly at the cap and honest about it: the signal has to be able to say
    // "these are all of them", or an admin learns to ignore it.
    expect(found?.emails).toHaveLength(MAX_EMAILS_PER_DEVELOPER);
    expect(found?.emailsTruncated).toBe(false);
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

/**
 * A listing of the team IS a new disclosure of personal data, and DESIGN.md
 * §10 risk 3 is where this project enumerates every one of them — the
 * paragraph a works council, a DPIA or a customer security review reads to
 * find out what addresses the hub emits. It ends with the rule this surface
 * arrives under: "A future surface that wants to widen this — a directory, a
 * picker, question targeting — is adding a new disclosure and owes its own
 * line here." An endpoint that hands out every teammate's addresses while
 * that paragraph still says no endpoint lists the team does not just leave a
 * document stale; it makes the honest answer to an external question wrong.
 */
describe("the disclosure the listing adds", () => {
  test("the privacy boundary and the admin walkthrough both name the listing", async () => {
    const harness = await createTestHarness();
    const ken = await createTestDeveloper(harness, "Ken", "ken@work.test");
    expect(await addEmail(harness, ken.developerId, "ken@personal.test")).toBe(200);

    const response = await harness.app.request(
      "/api/developers",
      jsonRequest("GET", TEST_ADMIN_TOKEN),
    );
    const raw = await response.text();

    // Measured first, so the documentation assertions below are owed rather
    // than assumed: this is the response an operator would be answering
    // questions about. If the listing ever stops carrying addresses, this
    // half goes red and the paragraph is free to shrink again.
    expect(response.status).toBe(200);
    expect(raw).toContain("ken@work.test");
    expect(raw).toContain("ken@personal.test");

    const design = await readFile(join(REPO_ROOT, "docs", "DESIGN.md"), "utf8");
    // Marker chosen to survive the edit it demands: it names the subject of
    // the sentence, not the claim under test, so a stale document is caught
    // by the assertion below rather than by the lookup failing to find it.
    const boundary = lineContaining(design, "Teammate email addresses");
    expect(boundary).not.toContain('there is no "who works here" endpoint');
    expect(boundary).toContain("GET /api/developers");

    // The same disclosure, from the operator's side: the walkthrough teaches
    // POST /api/developers and POST /api/developers/<id>/emails and never
    // said how to get <id> back, which is the whole reason the listing was
    // built. A boundary nobody can find in the instructions is not one.
    const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toContain("curl -s http://localhost:7100/api/developers");
  });
});
