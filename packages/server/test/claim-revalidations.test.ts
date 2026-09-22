/**
 * THE DOWNGRADE-ONLY UPSERT — the one rule without which AT-2's teeth are an
 * agent's to pull out (1.0 spec 02 §3.3).
 *
 * The substance gate reads `claimValidity()`, whose `stale` comes from this
 * row, and the only producer is a connector-computed report POSTed under
 * `developerAuth` — a bearer key that sits in plaintext in
 * ~/.crosscheck/config.json where any agent on the machine can read it. So
 * without this rule the agent that wrote a claim can assert `unchanged` about
 * its own claim, overwrite a `changed` reading and keep a stale root cause in
 * teammates' prompts. Legal directions still work; one direction does not.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { CLAIM_REVALIDATION_RETENTION_DAYS } from "../src/constants.ts";
import {
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const MS_PER_DAY = 86_400_000;

interface Reported {
  readonly status: number;
  readonly recorded: number;
  readonly refusedDowngrades: number;
  readonly pruned: number;
}

const report = async (
  harness: TestHarness,
  developer: TestDeveloper,
  entries: readonly Record<string, unknown>[],
  totals: { revalidated: number; total: number } = {
    revalidated: entries.length,
    total: entries.length,
  },
): Promise<Reported> => {
  const response = await harness.app.request(
    "/api/claim-revalidations",
    jsonRequest("POST", developer.apiKey, { repo: REPO, entries, ...totals }),
  );
  if (response.status !== 200) {
    return {
      status: response.status,
      recorded: 0,
      refusedDowngrades: 0,
      pruned: 0,
    };
  }
  const body = (await response.json()) as {
    data: { recorded: number; refusedDowngrades: number; pruned: number };
  };
  return { status: response.status, ...body.data };
};

const entry = (
  result: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  claimId: "clm_01",
  result,
  basis: "context_targets",
  refCommit: "ff00aa11",
  touchingCommits: result === "changed" ? ["deadbee", "cafe123"] : [],
  touchingTotal: result === "changed" ? 2 : 0,
  ...overrides,
});

const readRow = async (
  harness: TestHarness,
  claimId = "clm_01",
): Promise<{ result: string; touching: readonly string[] } | undefined> => {
  const rows = (await harness.db.execute(
    sql`SELECT result, touching_commits FROM claim_revalidations WHERE claim_id = ${claimId}`,
  )) as unknown as {
    readonly rows: readonly {
      readonly result: string;
      readonly touching_commits: readonly string[];
    }[];
  };
  const row = rows.rows[0];
  return row === undefined
    ? undefined
    : { result: row.result, touching: row.touching_commits };
};

const seed = async (): Promise<{
  harness: TestHarness;
  developer: TestDeveloper;
}> => {
  const { harness, developer } = await createHarnessWithSession();
  await postRecords(harness, developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("claim", validClaimBody()),
    ],
  });
  return { harness, developer };
};

describe("claim revalidations", () => {
  test("a stored changed survives a later unchanged report", async () => {
    // Arrange
    const { harness, developer } = await seed();
    expect((await report(harness, developer, [entry("changed")])).recorded).toBe(
      1,
    );

    // Act
    const second = await report(harness, developer, [entry("unchanged")]);

    // Assert: recorded as a no-op and COUNTED — never silent.
    expect(second.status).toBe(200);
    expect(second.recorded).toBe(0);
    expect(second.refusedDowngrades).toBe(1);
    expect(await readRow(harness)).toEqual({
      result: "changed",
      touching: ["deadbee", "cafe123"],
    });
  });

  test("the legal directions still land", async () => {
    // Arrange: unknown -> changed, and unchanged -> changed.
    const { harness, developer } = await seed();

    // Act + Assert: unknown -> changed
    await report(harness, developer, [entry("unknown")]);
    expect((await readRow(harness))?.result).toBe("unknown");
    await report(harness, developer, [entry("changed")]);
    expect((await readRow(harness))?.result).toBe("changed");

    // Act + Assert: unchanged -> changed, on a second claim
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ id: "clm_02", body: "second" })),
    );
    await report(harness, developer, [entry("unchanged", { claimId: "clm_02" })]);
    expect((await readRow(harness, "clm_02"))?.result).toBe("unchanged");
    await report(harness, developer, [entry("changed", { claimId: "clm_02" })]);
    expect((await readRow(harness, "clm_02"))?.result).toBe("changed");
  });

  test("unknown over unknown is not a refused downgrade", async () => {
    // Arrange: a no-op that changes nothing must not be reported as a
    // REFUSAL — doctor prints that count, and a number that fires on every
    // honest re-report is one nobody reads.
    const { harness, developer } = await seed();
    await report(harness, developer, [entry("unknown")]);

    // Act
    const second = await report(harness, developer, [entry("unknown")]);

    // Assert
    expect(second.refusedDowngrades).toBe(0);
    expect(second.recorded).toBe(1);
  });

  test("a downgrade that names no commit is refused at the wire", async () => {
    // CCB-3's own failure condition: a downgrade "says `changed` naming
    // nothing". The wire guarded only the opposite direction — a non-changed
    // result carrying commits — so half the invariant was written down and
    // half was not.
    //
    // The downgrade-only rule is what makes it permanent rather than a
    // mislabel: once `changed` is stored, `setWhere` refuses every honest
    // `unchanged` forever, so one evidence-free POST removes a claim from the
    // unsolicited substance lane for good. The route is developerAuth and the
    // key sits in plaintext in ~/.crosscheck/config.json — the adversary the
    // downgrade-only rule was built around, arriving from the other side.
    const { harness, developer } = await seed();

    const response = await harness.app.request(
      "/api/claim-revalidations",
      jsonRequest("POST", developer.apiKey, {
        repo: REPO,
        entries: [
          { ...entry("changed"), touchingCommits: [], touchingTotal: 0 },
        ],
        revalidated: 1,
        total: 1,
      }),
    );

    expect(response.status).toBe(400);
    // Nothing stored, so the honest reporter is not locked out.
    expect(await readRow(harness)).toBeUndefined();
  });

  test("a downgrade that names a commit is accepted", async () => {
    // The control. A rule that refused every `changed` would pass the case
    // above while breaking the feature it guards.
    const { harness, developer } = await seed();
    const outcome = await report(harness, developer, [entry("changed")]);

    expect(outcome.recorded).toBe(1);
    expect((await readRow(harness))?.result).toBe("changed");
  });

  test("a reading that carries no downgrade is pruned past retention", async () => {
    // Arrange: "we looked and nothing had moved" is exactly the kind of
    // evidence that should expire — it asserts nothing about the code today.
    const { harness, developer } = await seed();
    await report(harness, developer, [entry("unchanged")]);
    harness.clock.advanceSeconds(
      ((CLAIM_REVALIDATION_RETENTION_DAYS + 1) * MS_PER_DAY) / 1000,
    );
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ id: "clm_03", body: "third" })),
    );

    // Act: any later report prunes, the shape ingestCommitEvidence uses.
    await report(harness, developer, [entry("unknown", { claimId: "clm_03" })]);

    // Assert
    expect(await readRow(harness)).toBeUndefined();
  });

  test("a measured downgrade outlives retention while its claim exists", async () => {
    // THE CASE THIS FILE USED TO ASSERT THE OTHER WAY, and it was the defect.
    // It seeded a `changed` row, advanced past the cutoff and demanded the row
    // be gone — under the comment "a verdict must not outlive the evidence it
    // came from". The row IS the evidence. Deleting it returns the claim to
    // `unknown`, which §5's gate admits to the unsolicited substance lane, so
    // the deletion STRENGTHENS the claim's standing: principle 5 inverted and
    // principle 6 broken, on a timer, whatever the code actually did.
    //
    // It was also the opening for a one-request walk-back. The prune ran
    // FIRST, so the downgrade-only rule — which fires only on a CONFLICT —
    // never fired once the row had aged, and a claim's own author could post
    // `unchanged` and read back `current` with `refusedDowngrades: 0`.
    const { harness, developer } = await seed();
    await report(harness, developer, [entry("changed")]);
    harness.clock.advanceSeconds(
      ((CLAIM_REVALIDATION_RETENTION_DAYS + 1) * MS_PER_DAY) / 1000,
    );
    await postRecords(
      harness,
      developer,
      recordEnvelope("claim", validClaimBody({ id: "clm_03", body: "third" })),
    );

    // Act: a later report, which is what used to prune it away.
    await report(harness, developer, [entry("unknown", { claimId: "clm_03" })]);

    // Assert: still there, and still `changed`.
    expect((await readRow(harness))?.result).toBe("changed");

    // And the walk-back that prune used to enable is refused, loudly.
    const outcome = await report(harness, developer, [entry("unchanged")]);
    expect(outcome.refusedDowngrades).toBe(1);
    expect((await readRow(harness))?.result).toBe("changed");
  });

  test("a report without a bearer key is refused", async () => {
    // Arrange
    const { harness } = await seed();

    // Act
    const response = await harness.app.request(
      "/api/claim-revalidations",
      jsonRequest("POST", null, {
        repo: REPO,
        entries: [entry("changed")],
        revalidated: 1,
        total: 1,
      }),
    );

    // Assert
    expect(response.status).toBe(401);
  });

  test("a claim this hub does not have is refused, not silently stored", async () => {
    // Arrange
    const { harness, developer } = await seed();

    // Act
    const outcome = await report(harness, developer, [
      entry("changed", { claimId: "clm_missing" }),
    ]);

    // Assert
    expect(outcome.status).toBe(400);
  });

  test("a prose-shaped commit never reaches the row", async () => {
    // Arrange: nothing flag- or prose-shaped may reach git or SQL.
    const { harness, developer } = await seed();

    // Act
    const outcome = await report(harness, developer, [
      entry("changed", { touchingCommits: ["--upload-pack=nope"] }),
    ]);

    // Assert
    expect(outcome.status).toBe(400);
  });

  test("the answer carries each named claim's derived validity, refusals included", async () => {
    // Arrange: the reader who triggered the check renders the verdict on THIS
    // pull, so the hub hands back the state it derived from the write it just
    // accepted — through claimValidity(), the one authority, rather than
    // leaving the connector to map a drift result to a state itself. A
    // REFUSED `unchanged` comes back as `stale`: the truth about the claim,
    // not about the request.
    const { harness, developer } = await seed();
    await report(harness, developer, [entry("changed")]);

    // Act
    const response = await harness.app.request(
      "/api/claim-revalidations",
      jsonRequest("POST", developer.apiKey, {
        repo: REPO,
        entries: [entry("unchanged")],
        revalidated: 1,
        total: 1,
      }),
    );
    const body = (await response.json()) as {
      data: {
        refusedDowngrades: number;
        validities?: Record<
          string,
          { state: string; touchingCommits: string[]; commitBinding: string }
        >;
      };
    };

    // Assert
    expect(body.data.refusedDowngrades).toBe(1);
    expect(body.data.validities?.["clm_01"]).toMatchObject({
      state: "stale",
      touchingCommits: ["deadbee", "cafe123"],
      commitBinding: "session_base",
    });
  });

  test("the tree names the repository its commits belong to", async () => {
    // Arrange: get_diagnosis serves any tree on the hub, and a claim's
    // binding is a commit in ONE repository's history. The reader has to be
    // able to tell a foreign tree before it asks its own git about it.
    const { harness, developer } = await seed();

    // Act
    const response = await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", developer.apiKey),
    );
    const body = (await response.json()) as { data: { repo?: string } };

    // Assert
    expect(body.data.repo).toBe(REPO);
  });
});

/**
 * THE SUMMARY DOCTOR READS (spec 02 §8.5, §8.9) — counts, and where they
 * come from.
 *
 * The temptation is a `GROUP BY commit_binding`: one query, no join, and a
 * SECOND definition of currency written in SQL beside the one in
 * `claimValidity()`. That is AT-2's second "fails if" arriving through a
 * health endpoint, so these cases assert the counts against states only the
 * derivation produces — a `supersedes` edge has no column to group by, and a
 * revalidated claim's `stale` lives in a different table from its binding.
 */
describe("the claim-validity summary", () => {
  const readSummary = async (
    harness: TestHarness,
    developer: TestDeveloper,
    repo = REPO,
  ): Promise<{
    status: number;
    counted: number;
    total: number;
    unbound: number;
    neverRevalidated: number;
    states: Record<string, number>;
  }> => {
    const response = await harness.app.request(
      `/api/claim-revalidations/summary?repo=${encodeURIComponent(repo)}`,
      jsonRequest("GET", developer.apiKey),
    );
    if (response.status !== 200) {
      return {
        status: response.status,
        counted: 0,
        total: 0,
        unbound: 0,
        neverRevalidated: 0,
        states: {},
      };
    }
    const body = (await response.json()) as {
      data: {
        counted: number;
        total: number;
        unbound: number;
        neverRevalidated: number;
        states: Record<string, number>;
      };
    };
    return { status: response.status, ...body.data };
  };

  test("every count comes from the derivation, not from a column", async () => {
    // Arrange: three claims on one session, so all three share a binding —
    // and then each is made to read a DIFFERENT state by something no single
    // column carries. clm_01 is revalidated `changed` (another table),
    // clm_02 is retired by an edge (a third table), clm_03 is untouched.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody()),
        recordEnvelope("claim", validClaimBody({ id: "clm_02", body: "two" })),
        recordEnvelope("claim", validClaimBody({ id: "clm_03", body: "three" })),
        recordEnvelope(
          "claim_edge",
          validClaimEdgeBody({
            kind: "supersedes",
            fromClaimId: "clm_03",
            toClaimId: "clm_02",
          }),
        ),
      ],
    });
    await report(harness, developer, [entry("changed")]);

    // Act
    const summary = await readSummary(harness, developer);

    // Assert
    expect(summary.counted).toBe(3);
    expect(summary.total).toBe(3);
    expect(summary.unbound).toBe(0);
    expect(summary.states["stale"]).toBe(1);
    expect(summary.states["superseded"]).toBe(1);
    expect(summary.states["unknown"]).toBe(1);
    // clm_01 was measured; clm_02 and clm_03 never were. `superseded` is one
    // of them — the count is about the MEASUREMENT, not about the verdict.
    expect(summary.neverRevalidated).toBe(2);
  });

  test("a claim bound to no commit is counted as one nobody can ever check", async () => {
    // Arrange: §8.5. The session registered the NO_COMMIT_SHA placeholder, so
    // ingest stamped `commit_binding = 'none'` — there is no "from" commit
    // and the rung cannot exist for this claim, ever.
    const { harness, developer } = await createHarnessWithSession({
      baseCommit: "0000000",
    });
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody()),
      ],
    });

    // Act
    const summary = await readSummary(harness, developer);

    // Assert: counted as unbound, and NOT as merely unmeasured — the two have
    // opposite remedies and doctor prints them on different lines.
    expect(summary.unbound).toBe(1);
    expect(summary.neverRevalidated).toBe(0);
    expect(summary.states["unknown"]).toBe(1);
  });

  test("another repo's claims are not this repo's health", async () => {
    // Arrange: the scope. A claim belongs to the repo its AUTHOR SESSION
    // registered under, and a summary that ignored that would report one
    // team's archive as another's.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody()),
      ],
    });

    // Act
    const summary = await readSummary(harness, developer, "github.com/acme/other");

    // Assert
    expect(summary.counted).toBe(0);
    expect(summary.total).toBe(0);
  });

  test("a summary without a repo is refused rather than answered for all of them", async () => {
    // Arrange
    const { harness, developer } = await seed();

    // Act
    const response = await harness.app.request(
      "/api/claim-revalidations/summary",
      jsonRequest("GET", developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(400);
  });
});
