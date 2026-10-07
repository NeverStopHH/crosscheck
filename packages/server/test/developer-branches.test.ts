/**
 * developer_branches (review round 5, H3): written as sessions register and
 * re-register, and backfilled at boot (db/bootstrap.sql) for a hub that
 * predates it.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { branchesOf } from "../src/services/developer-branches.ts";
import { createTestDeveloper, createTestHarness, registerTestSession } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const SESSION = "cc_00000000-0000-4000-8000-0000000000aa";
const BOOTSTRAP_SQL_URL = new URL("../src/db/bootstrap.sql", import.meta.url);

const sortedBranchesOf = async (harness: TestHarness, developerId: string): Promise<readonly string[]> =>
  [...((await branchesOf(harness.db, [developerId])).get(developerId) ?? [])].sort();

/** The PGlite client drizzle wraps (`Db` does not name it). */
interface RawClient {
  readonly $client: { readonly exec: (text: string) => Promise<unknown> };
}

/** What every start of the hub runs on its database (db/client.ts runBootstrap). */
const boot = async (harness: TestHarness): Promise<void> => {
  await (harness.db as unknown as RawClient).$client.exec(await Bun.file(BOOTSTRAP_SQL_URL).text());
};

const rowCount = async (harness: TestHarness): Promise<number> => {
  const counted = await harness.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM developer_branches`);
  return counted.rows[0]?.n ?? Number.NaN;
};

describe("every branch a developer's sessions reported is remembered", () => {
  test("a registration and every re-registration that moves the branch", async () => {
    // Arrange
    const harness = await createTestHarness();
    const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");

    // Act
    await registerTestSession(harness, robin.apiKey, { id: SESSION, branch: "feat/a" });
    await registerTestSession(harness, robin.apiKey, { id: SESSION, branch: "feat/b" });
    await registerTestSession(harness, robin.apiKey, { id: SESSION, branch: "feat/c" });

    // Assert
    expect(await sortedBranchesOf(harness, robin.developerId)).toEqual(["feat/a", "feat/b", "feat/c"]);
  });

  test("a boot recovers what a hub without the table knew, and a second boot adds nothing", async () => {
    // Arrange: a hub from before the table (its rows emptied) whose events
    // remember a branch no session row still holds, plus one event naming a
    // developer the hub no longer has.
    const harness = await createTestHarness();
    const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
    await registerTestSession(harness, robin.apiKey, { id: SESSION, branch: "feat/old" });
    await registerTestSession(harness, robin.apiKey, { id: SESSION, branch: "feat/now" });
    await harness.db.execute(sql`INSERT INTO events (kind, payload)
      VALUES ('session_started', jsonb_build_object('developerId', 'dev_gone', 'branch', 'feat/ghost'))`);
    await harness.db.execute(sql`DELETE FROM developer_branches`);

    // Act
    await boot(harness);
    const afterFirstBoot = await rowCount(harness);
    await boot(harness);

    // Assert: her current branch from the session row, the old one from its
    // session_started event, nothing for the removed developer (the boot did
    // not fail on it), and a second boot that changes nothing.
    expect(await sortedBranchesOf(harness, robin.developerId)).toEqual(["feat/now", "feat/old"]);
    expect(afterFirstBoot).toBe(2);
    expect(await rowCount(harness)).toBe(2);
  });
});
