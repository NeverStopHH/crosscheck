/**
 * A MID-LIFE HEAL SWEEPS AGAIN INSIDE THE HOOK THAT HEALED (batch-2
 * integration review, L10), on the release gate's harness: real hooks as
 * processes, the real hub over PGlite on a loopback port, a real repo.
 *
 * Nick's life files three shared files — one by the Edit tool, one by a
 * Bash write, one by a commit — then a sibling ends that life on the hub. His
 * next edit's flush is refused, the hook heals onto the next life, and
 * before the fix that life owned nothing until the turn's Stop lane: every
 * teammate's tripwire read 0 of the 3 for the rest of the turn. Now the
 * hook sweeps again under the new life and flushes, so the hub holds all
 * four files under it before any Stop. The hook's wall time is printed: the
 * cost is the lane's plus one flush, paid once per heal.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sessionStatePath } from "@crosscheck/connector-core/config/paths.ts";
import { workContextIdFor } from "@crosscheck/connector-core/state/session-state.ts";

import { NICK } from "../../../connector-core/test/fixtures/landing-repos.ts";
import { checkoutFor, fileSource, seedCase } from "./release-gate/case-kit.ts";
import { commitAll } from "./release-gate/git.ts";
import { openSession } from "./release-gate/host.ts";
import { startHub } from "./release-gate/hub.ts";
import type { TestHub } from "./release-gate/hub.ts";
import { makeDeveloper, targetsOf } from "./release-gate/team.ts";

const CASE_TIMEOUT_MS = 300_000;
const EDITED = "src/edited.ts";
const BY_BASH = "src/by-bash.ts";
const COMMITTED = "src/committed.ts";
const AFTER_HEAL = "src/after-heal.ts";
const PATHS = [EDITED, BY_BASH, COMMITTED, AFTER_HEAL];
const SESSION_ID = "sess-heal-sweep";

let hub: TestHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await startHub();
});

afterAll(async () => {
  await hub.close();
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const lifeOf = async (home: string): Promise<string> =>
  (JSON.parse(await readFile(sessionStatePath(home, SESSION_ID), "utf8")) as { crosscheckSessionId: string }).crosscheckSessionId;

/** The files the hub holds under the life's own work context, sorted. */
const filesUnder = async (repoId: string, life: string): Promise<readonly string[]> =>
  (await targetsOf(hub.db, repoId))
    .filter((row) => row.kind === "file" && row.workContextId === workContextIdFor(life))
    .map((row) => row.value)
    .sort();

test(
  "the hook that heals files the refused life's work under the new life, before any Stop",
  async () => {
    // Arrange: a life that filed three files three ways, then ended on the hub by a sibling
    const repo = await seedCase("heal-sweep", hub.url, PATHS);
    const dev = await makeDeveloper(hub, NICK, "heal-sweep");
    const checkout = await checkoutFor(repo, dev.person, "feat/heal-sweep", "nick");
    cleanups.push(checkout.parent, repo.seed, dev.home);
    const session = openSession(dev, SESSION_ID, checkout.worktree, { isProcessHost: true });
    await session.start("startup");
    await session.prompt("heal sweep: the three ways a file is filed");
    await session.edit(join(checkout.worktree, EDITED), fileSource(EDITED, "edited"));
    await session.bash(
      "./scripts/gen.sh",
      async () => {
        await writeFile(join(checkout.worktree, BY_BASH), fileSource(BY_BASH, "bash"), "utf8");
      },
      { cwd: checkout.worktree },
    );
    await writeFile(join(checkout.worktree, COMMITTED), fileSource(COMMITTED, "committed"), "utf8");
    await commitAll(checkout.worktree, "heal sweep: committed", dev.person, new Date().toISOString());
    await session.stop();
    // A process host's hooks run on: nothing below reads before they are done.
    await session.settle();
    const life0 = await lifeOf(dev.home);
    expect(await filesUnder(repo.repoId, life0)).toEqual([BY_BASH, COMMITTED, EDITED]);
    const ended = await fetch(`${hub.url}/api/sessions/${encodeURIComponent(life0)}/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${dev.account.apiKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(ended.ok).toBe(true);

    // Act: the next turn's edit — its flush is refused, and the hook heals
    await session.prompt("next: one more file");
    await session.edit(join(checkout.worktree, AFTER_HEAL), fileSource(AFTER_HEAL, "after"));
    await session.settle();
    const life1 = await lifeOf(dev.home);

    // Assert: a new life, and the hub holds all four files under it already
    expect(life1).not.toBe(life0);
    expect(await filesUnder(repo.repoId, life1)).toEqual([AFTER_HEAL, BY_BASH, COMMITTED, EDITED]);
    // The hook that healed, swept and flushed — a process host books it once it has settled.
    const post = session.runs().findLast((run) => run.event === "PostToolUse" && run.filePath?.endsWith(AFTER_HEAL) === true);
    expect(post?.wasKilled).toBe(false);
    const others = session
      .runs()
      .filter((run) => run.event === "PostToolUse" && run !== post && run.durationMs !== null)
      .map((run) => run.durationMs ?? 0)
      .sort((left, right) => left - right);
    console.log(
      `heal-sweeps-again: the healing PostToolUse took ${String(post?.durationMs ?? -1)} ms (boot included); ` +
        `this session's other PostToolUse runs: ${others.map(String).join(", ")} ms`,
    );
  },
  CASE_TIMEOUT_MS,
);
