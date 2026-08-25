/**
 * GET /api/search — WHO and WHEN (roadmap R1).
 *
 * `search_related_work` could only ask about a TOPIC. "What did Ken do in this
 * area in the last two weeks" was not expressible, and the author's name only
 * ever appeared in the result. These are the two filters that make the question
 * askable, and the three properties that make the answer trustworthy:
 *
 *   1. BOTH FILTERS RUN INSIDE EVERY TIER'S SQL. Each tier list is bounded at
 *      TIER_CANDIDATES, so a row filtered out AFTER the bound was a row that
 *      pushed an includable one over the edge — the same defect the hints pool
 *      already learned the hard way ("cannot crowd a teammate's out of the
 *      pool"). The two crowding tests below construct exactly that: 31 rows
 *      that fill the tier and one wanted row ranked 32nd. Post-filtering
 *      returns nothing at all.
 *   2. A NAME THAT DOES NOT RESOLVE IS AN ERROR, NEVER AN EMPTY RESULT. An
 *      empty result to `developer: "Kenn"` reads as "Ken has done nothing",
 *      which is the most expensive false statement this tool can make.
 *      Ambiguity is refused with the candidates named (two people called Ken
 *      is a fact about the hub, not something to guess at).
 *   3. SELF-EXCLUSION IS NEVER LIFTED BY A FILTER. The hints path excludes the
 *      reader inside every tier; a developer filter naming that same reader
 *      must intersect with it, not replace it.
 */
import { describe, expect, test } from "bun:test";

import { MAX_REFUSAL_CHARS } from "../src/services/refusal.ts";
import { searchWorkContexts } from "../src/services/search.ts";
import {
  addTestDeveloperWithSession,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_ADMIN_TOKEN,
  TEST_START_ISO,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

/** 60 days before TEST_START_ISO — outside every window asked for below. */
const OLD_CREATED_ISO = "2026-05-25T09:00:00.000Z";

/** Enough rows to fill a tier list (TIER_CANDIDATES = 30) and one over. */
const CROWD_SIZE = 31;

/**
 * Two paths, asked for together. The exact tier orders by how many of the
 * query's tokens a context owns, so a crowder owning BOTH sorts above the
 * needle owning one — which is how the needle lands at position 32, past the
 * tier bound, and how "filtered after the cap" becomes "returns nothing".
 */
const CROWD_TARGETS = ["src/auth/refresh.ts", "src/auth/rotate.ts"] as const;
const NEEDLE_TARGET = CROWD_TARGETS[0];
const PATH_QUERY = CROWD_TARGETS.join(" ");

/**
 * A title none of the query's words can reach through full-text, so the exact
 * tier is the ONLY tier in play and the crowding is not masked by an FTS hit.
 */
const NEUTRAL_TITLE = "Cache stampede on deploy";

interface SearchView {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly names: readonly string[];
  readonly filters: {
    readonly developer: {
      name: string;
      email: string | null;
      isSelf: boolean;
    } | null;
    readonly since: string | null;
  } | null;
}

const search = async (
  harness: TestHarness,
  apiKey: string,
  params: Record<string, string>,
): Promise<SearchView> => {
  const query = new URLSearchParams(params).toString();
  const response = await harness.app.request(
    `/api/search?${query}`,
    jsonRequest("GET", apiKey),
  );
  const body = (await response.json()) as {
    data?: {
      results: { id: string; developerName: string }[];
      filters?: SearchView["filters"];
    };
    error?: { code: string; message: string };
  };
  return {
    status: response.status,
    code: body.error?.code ?? "",
    message: body.error?.message ?? "",
    ids: (body.data?.results ?? []).map((entry) => entry.id),
    names: (body.data?.results ?? []).map((entry) => entry.developerName),
    filters: body.data?.filters ?? null,
  };
};

interface SeedContext {
  readonly id: string;
  readonly title?: string;
  readonly createdAt?: string;
  readonly targetValues?: readonly string[];
}

const seedContexts = async (
  harness: TestHarness,
  developer: TestDeveloper,
  sessionId: string,
  seeds: readonly SeedContext[],
): Promise<void> => {
  const records = seeds.flatMap((seed) => [
    recordEnvelope(
      "work_context",
      validWorkContextBody({
        id: seed.id,
        sessionId,
        title: seed.title ?? NEUTRAL_TITLE,
        description: undefined,
        createdAt: seed.createdAt ?? TEST_START_ISO,
      }),
      { sessionId },
    ),
    ...(seed.targetValues ?? []).map((value) =>
      recordEnvelope(
        "target",
        { workContextId: seed.id, kind: "file", value },
        { sessionId },
      ),
    ),
  ]);
  const posted = await postRecords(harness, developer, { records });
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`seed failed: ${JSON.stringify(posted.data?.results)}`);
  }
};

interface Crowded {
  readonly harness: TestHarness;
  readonly nick: TestDeveloper;
  readonly ken: TestDeveloper;
}

/**
 * Nick fills the exact tier with CROWD_SIZE old two-target contexts; Ken owns
 * ONE fresh single-target context, which therefore ranks last. Every filter
 * test below asks for the needle and gets it only if the filter ran in the
 * tier's own WHERE.
 */
const seedCrowdedTier = async (): Promise<Crowded> => {
  const harness = await createTestHarness();
  const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, nick.apiKey);
  const ken = await addTestDeveloperWithSession(
    harness,
    "Ken",
    "ken@example.com",
    { id: "ses_ken" },
  );
  await seedContexts(
    harness,
    nick,
    VALID_SESSION_BODY.id,
    Array.from({ length: CROWD_SIZE }, (_, index) => ({
      id: `wc_crowd_${String(index)}`,
      createdAt: OLD_CREATED_ISO,
      targetValues: CROWD_TARGETS,
    })),
  );
  await seedContexts(harness, ken, "ses_ken", [
    { id: "wc_needle", targetValues: [NEEDLE_TARGET] },
  ]);
  return { harness, nick, ken };
};

describe("GET /api/search — the developer filter", () => {
  test("narrows the results to that developer's work", async () => {
    // Arrange
    const { harness, nick, ken } = await seedCrowdedTier();

    // Act
    const result = await search(harness, nick.apiKey, {
      query: NEEDLE_TARGET,
      developer: "Ken",
    });

    // Assert: Ken owns exactly one context; Nick's 31 match the same path
    expect(result.status).toBe(200);
    expect(result.ids).toEqual(["wc_needle"]);
    expect([...new Set(result.names)]).toEqual(["Ken"]);
    expect(ken.developerId).not.toBe(nick.developerId);
  });

  test("runs inside each tier, so a row past the tier bound is still found", async () => {
    // Arrange: the needle ranks 32nd of 32 in the exact tier, one past
    // TIER_CANDIDATES. A filter applied to the truncated list finds nothing.
    const { harness, nick } = await seedCrowdedTier();
    const unfiltered = await search(harness, nick.apiKey, { query: PATH_QUERY });
    expect(unfiltered.ids).not.toContain("wc_needle");

    // Act
    const result = await search(harness, nick.apiKey, {
      query: PATH_QUERY,
      developer: "Ken",
    });

    // Assert
    expect(result.ids).toEqual(["wc_needle"]);
  });

  test("resolves an alias email to the developer who owns it", async () => {
    // Arrange: git author emails rarely match the hub email (trial finding #7),
    // so the name a teammate is asked for may be any linked address.
    const { harness, nick, ken } = await seedCrowdedTier();
    const linked = await harness.app.request(
      `/api/developers/${ken.developerId}/emails`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, {
        email: "Ken.Private@Example.com",
      }),
    );
    expect(linked.status).toBe(200);

    // Act
    const result = await search(harness, nick.apiKey, {
      query: NEEDLE_TARGET,
      developer: "ken.private@example.com",
    });

    // Assert
    expect(result.ids).toEqual(["wc_needle"]);
  });

  test("refuses a blank developer instead of quoting an empty term", async () => {
    // Arrange: SearchQuerySchema bounds `developer` with min(1) and never
    // trims, so "   " passes validation, trims to nothing inside
    // resolveDeveloperRef, misses, and comes back through the unknown-name
    // path — whose echo trims again. The reader is then shown a sentence that
    // opens with a quoted nothing and goes looking for a name they never sent.
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const blank = await search(harness, nick.apiKey, {
      query: NEEDLE_TARGET,
      developer: "   ",
    });

    // Assert: its own code and its own sentence, naming what to do instead
    expect(blank.status).toBe(400);
    expect(blank.code).toBe("invalid_developer");
    expect(blank.message).not.toContain('""');
    expect(blank.message).toContain("blank");
    expect(blank.message).toContain("omit");
    expect(blank.ids).toEqual([]);
  });

  test("refuses an ambiguous name with the candidates named", async () => {
    // Arrange: two people called Ken is a fact about this hub. Picking one
    // would attribute half a team's work to the wrong person silently.
    const { harness, nick } = await seedCrowdedTier();
    await addTestDeveloperWithSession(harness, "Ken", "ken.other@example.com", {
      id: "ses_ken2",
    });

    // Act
    const result = await search(harness, nick.apiKey, {
      query: NEEDLE_TARGET,
      developer: "Ken",
    });

    // Assert: 400 naming both addresses, so the caller can ask again exactly
    expect(result.status).toBe(400);
    expect(result.code).toBe("ambiguous_developer");
    expect(result.message).toContain("ken@example.com");
    expect(result.message).toContain("ken.other@example.com");
  });

  test("counts every developer of that name, not the rows it read", async () => {
    // Arrange: the ambiguity probe is a PAGE — resolveDeveloperRef reads
    // AMBIGUITY_PROBE_LIMIT rows so the refusal can name people. If the
    // sentence counts that array, its number is the page size, and a hub with
    // twelve Kims tells the reader there are five. Worse than a short list: a
    // caller looking for the sixth Kim is told by name that they do not exist,
    // and the sentence's own next step ("ask again with the exact address")
    // asserts an address the sentence has just denied.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    const KIMS = 12;
    for (const index of Array.from({ length: KIMS }, (_, at) => at)) {
      await addTestDeveloperWithSession(
        harness,
        "Kim",
        `kim${String(index).padStart(2, "0")}@example.com`,
        { id: `ses_kim${String(index)}` },
      );
    }

    // Act
    const result = await search(harness, nick.apiKey, {
      query: "",
      developer: "Kim",
    });

    // Assert: the true count, and a remainder counted from it — the list is
    // budgeted in characters and may be cut, the COUNT never is
    expect(result.status).toBe(400);
    expect(result.code).toBe("ambiguous_developer");
    expect(result.message).toContain(`${String(KIMS)} developers here`);
    expect(result.message).toContain("kim00@example.com");
    expect(result.message).toMatch(/and (\d+) more/);
    const listed = [...result.message.matchAll(/kim\d\d@example\.com/g)].length;
    const more = Number(/and (\d+) more/.exec(result.message)?.[1] ?? "0");
    expect(listed + more).toBe(KIMS);
  });

  test("names one address whole even when every address is long", async () => {
    // Arrange: e541ed0 closed this dead end for NAMES — a suggestion list that
    // named nobody became a list of shortened names — on the stated grounds
    // that a name is for RECOGNITION and survives losing its tail while an
    // address is for RETYPING and a cut one is a different, wrong address. The
    // consequence was left standing on the address path: three Alexes at a
    // company with 69-character addresses got "3 of them, none short enough to
    // name here" beside "Ask again with the exact address", which is a
    // sentence with no next action anywhere in it.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await registerTestSession(harness, nick.apiKey);
    const LONG_ADDRESSES = [
      "alexandra.kowalczyk@engineering-platform.acme-corporation.example.com",
      "alexander.petrov.jr@engineering-platform.acme-corporation.example.com",
      "alexis.moreau.iii@engineering-platform.acme-corporation.example.com",
    ] as const;
    for (const email of LONG_ADDRESSES) {
      await addTestDeveloperWithSession(harness, "Alex", email, {
        id: `ses_${email.split("@")[0] ?? ""}`,
      });
    }

    // ...and the same shape under the most echo pressure the route can put on
    // it: the term a caller types IS the shared name, so a long shared name is
    // the only way to force the echo to shrink on this path.
    const LONG_SHARED_NAME =
      "Alex (platform, please use the address the directory lists)".padEnd(
        120,
        "x",
      );
    for (const email of LONG_ADDRESSES) {
      await addTestDeveloperWithSession(
        harness,
        LONG_SHARED_NAME,
        `long.${email}`,
        { id: `ses_long_${email.split("@")[0] ?? ""}` },
      );
    }

    // Act
    const short = await search(harness, nick.apiKey, {
      query: "",
      developer: "Alex",
    });
    const wide = await search(harness, nick.apiKey, {
      query: "",
      developer: LONG_SHARED_NAME,
    });

    // Assert: one address arrives whole — the rationale clause is what pays
    // for it, and a reader holding an address does not need to be told why
    // guessing is worse
    for (const result of [short, wide]) {
      expect(result.status).toBe(400);
      expect(result.message).not.toContain("none short enough");
      // The page is ordered by address, so the one it can name is the first
      // alphabetically — a deterministic sentence per hub, not a per-row race.
      expect(result.message).toContain(
        [...LONG_ADDRESSES].sort()[0] ?? "",
      );
      expect(result.message).toContain("3 developers here");
      expect(result.message).toContain("Ask again with the exact address");
      expect(result.message.normalize("NFKC").length).toBeLessThanOrEqual(
        MAX_REFUSAL_CHARS,
      );
    }
  });

  test("answers an unknown name with an error naming the closest developers", async () => {
    // Arrange: the whole point. An empty result to a misspelt name reads as
    // "Ken has done nothing", and a model will act on that.
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const result = await search(harness, nick.apiKey, {
      query: NEEDLE_TARGET,
      developer: "Kenn",
    });

    // Assert
    expect(result.status).toBe(400);
    expect(result.code).toBe("unknown_developer");
    expect(result.message).toContain("Ken");
    expect(result.ids).toEqual([]);
  });

  test("keeps both refusals inside the length a connector will quote", async () => {
    // Arrange: every connector caps a hub message at MAX_HUB_MESSAGE_CHARS
    // (200, connector-core/src/constants.ts) and quotes the rest away. A
    // refusal listing five long addresses would arrive with its actionable
    // half missing — the exact failure these sentences exist to prevent. Five
    // same-named developers, each with a long address: more than the list can
    // hold, so the sentence has to cut the list and keep the count.
    const { harness, nick } = await seedCrowdedTier();
    for (const index of [2, 3, 4, 5]) {
      await addTestDeveloperWithSession(
        harness,
        "Ken",
        `ken.number.${String(index)}.with.a.long.address@example.com`,
        { id: `ses_ken${String(index)}` },
      );
    }

    // Act
    const ambiguous = await search(harness, nick.apiKey, {
      query: "",
      developer: "Ken",
    });
    const unknown = await search(harness, nick.apiKey, {
      query: "",
      developer: "Kenn",
    });

    // Assert: still says how many there really are, still actionable — the
    // list is cut to the character budget, the COUNT never is
    expect(ambiguous.message).toContain("5 developers");
    expect(ambiguous.message).toContain("and 4 more");
    expect(ambiguous.message).toContain("ken.number.2");
    expect(ambiguous.message.length).toBeLessThanOrEqual(200);
    expect(unknown.message).toContain("Ken");
    expect(unknown.message.length).toBeLessThanOrEqual(200);
  });

  test("says which filters it applied, and that one of them is me", async () => {
    // Arrange: the renderer must be able to state the filters without guessing
    // — the same rule the vector tier follows (the hub REPORTS what it ran).
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const mine = await search(harness, nick.apiKey, {
      query: "",
      developer: "nick@example.com",
    });
    const theirs = await search(harness, nick.apiKey, {
      query: "",
      developer: "Ken",
    });

    // Assert: no address on either, because neither display name is shared on
    // this hub — the test below is the one that seeds a second Ken
    expect(mine.filters?.developer).toEqual({
      name: "Nick",
      email: null,
      isSelf: true,
    });
    expect(theirs.filters?.developer).toEqual({
      name: "Ken",
      email: null,
      isSelf: false,
    });
    expect(mine.filters?.since).toBeNull();
  });

  test("reports the address when two developers share the display name", async () => {
    // Arrange: the caller who did what the ambiguity refusal told them to do —
    // retyped the exact address — gets an answer the renderer can only label
    // with the display name, which is the one thing that does not identify the
    // person. The hub already knows whether the name is shared; the renderer
    // would have to guess.
    const { harness, nick } = await seedCrowdedTier();
    await addTestDeveloperWithSession(harness, "Ken", "ken.ohara@example.com", {
      id: "ses_ohara",
    });

    // Act
    const shared = await search(harness, nick.apiKey, {
      query: "",
      developer: "ken.ohara@example.com",
    });
    const unique = await search(harness, nick.apiKey, {
      query: "",
      developer: "Nick",
    });

    // Assert: the address rides along exactly when the name is not enough —
    // it is a teammate's address, so it is sent when it is needed and not
    // otherwise
    expect(shared.status).toBe(200);
    expect(shared.filters?.developer).toEqual({
      name: "Ken",
      email: "ken.ohara@example.com",
      isSelf: false,
    });
    expect(unique.filters?.developer).toEqual({
      name: "Nick",
      email: null,
      isSelf: true,
    });
  });

  test("an empty query with a developer filter lists that person's recent work", async () => {
    // Arrange: "what is Ken up to" — the recency tier takes the same scope
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const result = await search(harness, nick.apiKey, {
      query: "",
      developer: "Ken",
    });

    // Assert
    expect(result.ids).toEqual(["wc_needle"]);
  });
});

describe("GET /api/search — the since filter", () => {
  test("keeps work last active before the window out of the results", async () => {
    // Arrange
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const result = await search(harness, nick.apiKey, {
      query: NEEDLE_TARGET,
      since: "14d",
    });

    // Assert: the 31 crowders are 60 days old, the needle is fresh
    expect(result.ids).toEqual(["wc_needle"]);
  });

  test("runs inside each tier, so a row past the tier bound survives the window", async () => {
    // Arrange: same construction as the developer filter — the needle is 32nd
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const result = await search(harness, nick.apiKey, {
      query: PATH_QUERY,
      since: "72h",
    });

    // Assert
    expect(result.ids).toEqual(["wc_needle"]);
  });

  test("takes an ISO date as well as a relative window", async () => {
    // Arrange
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const result = await search(harness, nick.apiKey, {
      query: NEEDLE_TARGET,
      since: "2026-07-01",
    });

    // Assert
    expect(result.ids).toEqual(["wc_needle"]);
  });

  test("echoes the resolved instant so the renderer can name the window", async () => {
    // Arrange
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const result = await search(harness, nick.apiKey, {
      query: "",
      since: "14d",
    });

    // Assert: 14 days before the harness clock, to the millisecond
    expect(result.filters?.since).toBe("2026-07-10T09:00:00.000Z");
  });

  test("refuses a window it cannot parse and names the forms it takes", async () => {
    // Arrange
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const result = await search(harness, nick.apiKey, {
      query: "",
      since: "last fortnight",
    });

    // Assert
    expect(result.status).toBe(400);
    expect(result.code).toBe("invalid_since");
    expect(result.message).toContain("14d");
  });

  test("refuses a window past the cap rather than silently shrinking it", async () => {
    // Arrange: a clamped lookback would answer a NARROWER question than the
    // one asked, and nothing in the result would say so.
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const result = await search(harness, nick.apiKey, {
      query: "",
      since: "400d",
    });

    // Assert
    expect(result.status).toBe(400);
    expect(result.code).toBe("invalid_since");
    expect(result.message).toContain("365");
  });

  test("takes a date exactly one year back, which is what the cap says", async () => {
    // Arrange: the cap compares an instant to an instant, and Date.parse
    // resolves a date-only term to midnight UTC — so `2025-07-24` asked at
    // 09:00 on 2026-07-24 is 365 days AND NINE HOURS back and was refused by
    // a sentence saying the limit is 365 days. The relative spelling of the
    // same window, `365d`, was accepted. Jira's JQL documents exactly this
    // granularity mismatch and answers it with startOfDay().
    const { harness, nick } = await seedCrowdedTier();
    // TEST_START_ISO is 2026-07-24T09:00:00.000Z.
    const ONE_YEAR_BACK = "2025-07-24";
    const ONE_DAY_FURTHER = "2025-07-23";

    // Act
    const atTheCap = await search(harness, nick.apiKey, {
      query: "",
      since: ONE_YEAR_BACK,
    });
    const pastTheCap = await search(harness, nick.apiKey, {
      query: "",
      since: ONE_DAY_FURTHER,
    });
    const relative = await search(harness, nick.apiKey, {
      query: "",
      since: "365d",
    });

    // Assert: a date-only term is compared at day granularity, so the two
    // spellings of "the last year" agree — and the day past it still refuses,
    // because the cap is a real bound and not a rounding
    expect(atTheCap.status).toBe(200);
    expect(atTheCap.filters?.since).toBe("2025-07-24T00:00:00.000Z");
    expect(relative.status).toBe(200);
    expect(pastTheCap.status).toBe(400);
    expect(pastTheCap.code).toBe("invalid_since");
  });

  test("counts the context's own last change, not the claims filed into it", async () => {
    // Arrange: THE SEMANTICS, pinned rather than assumed. work_contexts
    // .updated_at moves when the context itself changes — title, description,
    // intent, status (services/record-handlers.ts) — and a claim filed into
    // it does not touch the row. So `since` measures the same instant every
    // surface renders as the row's age and time decay is computed from, and a
    // hit under a 14-day window can never print "40d ago". The cost is this
    // test's subject: a long-running context whose only fresh activity is
    // claims stays outside the window. Deliberate, because including it while
    // the same answer printed its stale age would be the dishonest half.
    const { harness, ken } = await seedCrowdedTier();
    await seedContexts(harness, ken, "ses_ken", [
      {
        id: "wc_stale",
        createdAt: OLD_CREATED_ISO,
        targetValues: [NEEDLE_TARGET],
      },
    ]);
    const filed = await postRecords(harness, ken, {
      records: [
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_fresh",
            workContextId: "wc_stale",
            authorSessionId: "ses_ken",
            createdAt: TEST_START_ISO,
          }),
          { sessionId: "ses_ken" },
        ),
      ],
    });
    // The claim really landed — otherwise this test would pass for the wrong
    // reason, which is the failure mode a negative assertion invites.
    expect(filed.data?.rejected ?? 1).toBe(0);

    // Act
    const windowed = await search(harness, ken.apiKey, {
      query: NEEDLE_TARGET,
      developer: "Ken",
      since: "14d",
    });
    const unwindowed = await search(harness, ken.apiKey, {
      query: NEEDLE_TARGET,
      developer: "Ken",
    });

    // Assert: found without the window, dropped by it, because the context
    // row itself was last touched 60 days ago — while the context Ken really
    // did change inside the window is still there, so this is the window
    // working, not the filter failing
    expect(unwindowed.ids).toContain("wc_stale");
    expect(windowed.ids).not.toContain("wc_stale");
    expect(windowed.ids).toContain("wc_needle");
  });

  test("refuses a window in the future instead of answering nothing", async () => {
    // Arrange
    const { harness, nick } = await seedCrowdedTier();

    // Act
    const result = await search(harness, nick.apiKey, {
      query: "",
      since: "2027-01-01",
    });

    // Assert
    expect(result.status).toBe(400);
    expect(result.code).toBe("invalid_since");
  });
});

/**
 * A refusal that arrives truncated is a refusal that cannot be acted on, and
 * this route is the one that refuses most: two developer shapes and four
 * window shapes. Every connector quotes a hub message at
 * MAX_HUB_MESSAGE_CHARS (200) and drops the rest, so the budget belongs to the
 * WHOLE sentence — not to the list inside it, which is the half that was
 * budgeted first and the half a caller cannot inflate.
 */
describe("GET /api/search — every refusal arrives whole", () => {
  /** The route's own bound on the term, so the widest echo a caller can force. */
  const WIDEST_TERM = "the person who last touched the refresh path".padEnd(
    320,
    "x",
  );

  /**
   * A display name long enough to blow the echo, and reachable: the create
   * route bounds a name below (`min(1)`) and not above, so how long a name
   * this hub holds is the org's choice, not this route's.
   */
  const WIDEST_NAME = "Ken Weber (backend, on leave until September)".padEnd(
    300,
    "x",
  );

  const worstCaseHub = async (): Promise<{
    harness: TestHarness;
    nick: TestDeveloper;
  }> => {
    const seeded = await seedCrowdedTier();
    for (const index of [2, 3, 4, 5]) {
      await addTestDeveloperWithSession(
        seeded.harness,
        "Ken",
        `ken.number.${String(index)}.with.a.long.address@example.com`,
        { id: `ses_ken${String(index)}` },
      );
    }
    // People whose shared name is itself long — the ambiguity refusal echoes
    // the term, so this is the widest one a caller can actually reach. MORE
    // OF THEM THAN THE PROBE READS (AMBIGUITY_PROBE_LIMIT is 5), because a
    // fixture seeded to exactly the page size makes the count assertion below
    // true by construction and hides the defect where the sentence counts the
    // page instead of the hub.
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await addTestDeveloperWithSession(
        seeded.harness,
        WIDEST_NAME,
        `long.name.${String(index)}.with.a.long.address@example.com`,
        { id: `ses_long${String(index)}` },
      );
    }
    return seeded;
  };

  test("no refusal this route can send is longer than a connector quotes", async () => {
    // Arrange: the worst case of each shape — five same-named developers with
    // long addresses, and a 320-character term for the two that echo it.
    const { harness, nick } = await worstCaseHub();

    // Act
    const refusals = [];
    for (const params of [
      { developer: "Ken" },
      { developer: WIDEST_TERM },
      { developer: WIDEST_NAME },
      { developer: "   " },
      { since: "last fortnight" },
      { since: "0d" },
      { since: "400d" },
      { since: "2027-01-01" },
      { since: "   " },
    ]) {
      refusals.push({
        params,
        result: await search(harness, nick.apiKey, { query: "", ...params }),
      });
    }

    // Assert: every one of them refused, and every one of them fits — MEASURED
    // AS THE READER COUNTS. The connector normalizes to NFKC before comparing
    // against its own 200, and NFKC never shrinks: the ellipsis this route
    // inserts when it cuts an echo is one character here and three there, which
    // is enough on its own to push a 200-character sentence to 202 and arrive
    // cut. Counting raw code units is counting in a unit nobody downstream uses.
    for (const { params, result } of refusals) {
      expect({ params, status: result.status }).toEqual({
        params,
        status: 400,
      });
      const asRead = result.message.normalize("NFKC").length;
      expect({ params, chars: asRead, fits: asRead <= MAX_REFUSAL_CHARS }).toEqual(
        { params, chars: asRead, fits: true },
      );
    }
  });

  /**
   * The same bound, against text that EXPANDS.
   *
   * Two untrusted strings reach these sentences — the caller's own term and
   * teammate display names, which the create route bounds below and not above —
   * and NFKC folds several single characters into many: U+FDFA is one code point
   * and eighteen characters once normalized, ﬁ is two, ½ is three. A hub that
   * budgets before that fold sends a sentence it believes is 176 characters and
   * the reader sees 856 of them, cut at 200 with every address and the whole
   * next step past the cut.
   */
  test("a refusal fits after the expansion the reader's cut happens on", async () => {
    // Arrange: a name that is one ligature per character, shared by three
    // people, on a hub of its own so the suggestion order elsewhere is
    // untouched.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const LIGATURE_NAME = "\uFDFA".repeat(40);
    for (const index of [1, 2, 3]) {
      await createTestDeveloper(
        harness,
        LIGATURE_NAME,
        `ligature.${String(index)}@example.com`,
      );
    }

    // Act: ambiguity echoes the name and lists addresses; the unknown path
    // echoes a term that expands and offers those names back.
    const ambiguous = await search(harness, nick.apiKey, {
      query: "",
      developer: LIGATURE_NAME,
    });
    const unknown = await search(harness, nick.apiKey, {
      query: "",
      developer: `${"\uFDFA".repeat(80)}zz`,
    });

    // Assert: both refuse, both fit as read, and the half that carries the next
    // action is still there after the reader's cut
    for (const result of [ambiguous, unknown]) {
      expect(result.status).toBe(400);
      const asRead = result.message.normalize("NFKC");
      expect(asRead.length).toBeLessThanOrEqual(MAX_REFUSAL_CHARS);
      expect(asRead.slice(0, MAX_REFUSAL_CHARS)).toContain("Ask again");
    }
  });

  test("the actionable half survives even when the echo is cut", async () => {
    // Arrange: when a refusal has to lose characters it loses the CALLER'S OWN
    // term first. The caller already knows what they typed; what they do not
    // know is how this hub spells the name, and that is the half that makes
    // the sentence a next step rather than a complaint.
    const { harness, nick } = await worstCaseHub();

    // Act
    const ambiguous = await search(harness, nick.apiKey, {
      query: "",
      developer: WIDEST_NAME,
    });
    const unknown = await search(harness, nick.apiKey, {
      query: "",
      developer: WIDEST_TERM,
    });

    // Assert: the count is never abbreviated, an address arrives WHOLE (a cut
    // address is a different, wrong address), the suggestions still name
    // somebody rather than counting them, and the echo says it was cut
    expect(ambiguous.message).toContain("8 developers");
    expect(ambiguous.message).toContain(
      "long.name.1.with.a.long.address@example.com",
    );
    expect(unknown.message).toContain("Closest known names: ");
    expect(unknown.message).not.toContain("none short enough");
    for (const message of [ambiguous.message, unknown.message]) {
      expect(message).toContain("…");
      expect(message.length).toBeLessThanOrEqual(MAX_REFUSAL_CHARS);
    }
  });
});

describe("the search service composes the filters with self-exclusion", () => {
  test("a developer filter naming the caller cannot lift self-exclusion", async () => {
    // Arrange: the hints endpoint excludes the reader inside every tier
    // (SearchScope). If a developer filter REPLACED that exclusion instead of
    // intersecting with it, a candidates query carrying `developer: me` would
    // hand the reader their own contexts back as teammate hints.
    const { harness, ken } = await seedCrowdedTier();

    // Act
    const own = await searchWorkContexts(
      { db: harness.db, now: harness.clock.now, embedder: null },
      {
        query: NEEDLE_TARGET,
        limit: 10,
        developerId: ken.developerId,
        excludeDeveloperId: ken.developerId,
      },
    );
    const asked = await searchWorkContexts(
      { db: harness.db, now: harness.clock.now, embedder: null },
      { query: NEEDLE_TARGET, limit: 10, developerId: ken.developerId },
    );

    // Assert: intersection, not replacement — and the filter itself works
    expect(own.results).toEqual([]);
    expect(asked.results.map((entry) => entry.id)).toEqual(["wc_needle"]);
  });
});
