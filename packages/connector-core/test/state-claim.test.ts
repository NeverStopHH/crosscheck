/**
 * `claimSessionState` — the serialization that makes two parallel state-less
 * recoveries deterministic (adversarial review of trial finding #9): a
 * recovery PUBLISHES its state only if none exists yet, under the state
 * file's own lock. The loser adopts the winner's state (and the callers'
 * foreign-repo guard then judges it); it never overwrites, so a session's
 * repo binding cannot flap between two first-touch hooks. A busy lock is
 * fail-open null — silence over a wrong write.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  sessionSlug,
  sessionStatePathForSlug,
} from "../src/config/paths.ts";
import {
  claimSessionState,
  deriveSessionState,
  readSessionState,
} from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const HUB_URL = "http://127.0.0.1:7100";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const stateFor = (key: string, repoId: string, developerId: string) =>
  deriveSessionState({
    hostSessionKey: key,
    repoId,
    repoRoot: `/tmp/${repoId.split("/").at(-1) ?? "repo"}`,
    hubUrl: HUB_URL,
    developerId,
    startedAt: new Date("2026-08-19T08:00:00.000Z").toISOString(),
  });

describe("claimSessionState", () => {
  test("claims an absent state file and publishes it", async () => {
    // Arrange
    const home = await makeHome("claim-fresh");
    paths.push(home);
    const state = stateFor("claim-uuid", "github.com/acme/api", "dev_a");

    // Act
    const claim = await claimSessionState(home, state);

    // Assert: won, and the file is the published truth
    expect(claim?.claimed).toBe(true);
    expect(claim?.state.repoId).toBe("github.com/acme/api");
    const stored = await readSessionState(home, "claim-uuid");
    expect(stored?.repoId).toBe("github.com/acme/api");
    expect(stored?.foreignRepoDrops).toBe(0);
  });

  test("adopts an existing state instead of overwriting it", async () => {
    // Arrange: a sibling recovery already published — for a DIFFERENT repo
    const home = await makeHome("claim-lost");
    paths.push(home);
    const winner = stateFor("claim-uuid", "github.com/other/web", "dev_w");
    expect((await claimSessionState(home, winner))?.claimed).toBe(true);

    // Act: the loser arrives with its own derived state
    const loser = stateFor("claim-uuid", "github.com/acme/api", "dev_l");
    const claim = await claimSessionState(home, loser);

    // Assert: adopted, never overwritten — the binding cannot flap
    expect(claim?.claimed).toBe(false);
    expect(claim?.state.repoId).toBe("github.com/other/web");
    expect(claim?.state.developerId).toBe("dev_w");
    const stored = await readSessionState(home, "claim-uuid");
    expect(stored?.repoId).toBe("github.com/other/web");
  });

  test("a lock held by a live process is fail-open null", async () => {
    // Arrange: a lock file naming THIS (running) process — unstealable
    const home = await makeHome("claim-busy");
    paths.push(home);
    const lockPath = `${sessionStatePathForSlug(home, sessionSlug("claim-uuid"))}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `${String(process.pid)}:testtoken\n`, "utf8");

    // Act
    const claim = await claimSessionState(
      home,
      stateFor("claim-uuid", "github.com/acme/api", "dev_a"),
    );

    // Assert: no claim, and NOTHING was written
    expect(claim).toBeNull();
    expect(await readSessionState(home, "claim-uuid")).toBeNull();
  });
});
