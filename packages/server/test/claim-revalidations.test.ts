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
  validWorkContextBody,
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

  test("a row past retention is pruned and the claim reads nothing again", async () => {
    // Arrange: a verdict must not outlive the evidence it came from.
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

    // Act: any later report prunes, the shape ingestCommitEvidence uses.
    await report(harness, developer, [entry("unknown", { claimId: "clm_03" })]);

    // Assert
    expect(await readRow(harness)).toBeUndefined();
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
});
