/**
 * Which work context an MCP tool writes to.
 *
 * A hook is HANDED its session id on stdin. An MCP server is not: Claude Code
 * starts it once per project and never tells it which session is calling. So
 * `publish_claim` has to work out which of the developer's own sessions this is,
 * and the only evidence on the machine is the session state files SessionStart
 * writes (state/session-state.ts).
 *
 * That makes the rule below load-bearing rather than incidental, and it has one
 * knowingly wrong answer — two concurrent sessions in the SAME worktree against
 * the SAME hub, where the newest wins. The last test in this file pins that,
 * because a limitation that is asserted is tracked and one that is only written
 * down is not.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { resolveOwnWorkContext } from "../src/mcp/session.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import type { RepoIdentity } from "../src/git/repo-identity.ts";
import { makeHome } from "./helpers.ts";

const HUB = "http://127.0.0.1:9999";
const OTHER_HUB = "http://127.0.0.1:8888";
const REPO_ID = "github.com/acme/api";
const ROOT = "/tmp/acme-api";
const WORKTREE = "/tmp/acme-api-worktree";

const homes: string[] = [];

afterAll(async () => {
  await Promise.all(
    homes.map((path) => rm(path, { recursive: true, force: true })),
  );
});

const newHome = async (label: string): Promise<string> => {
  const home = await makeHome(label);
  homes.push(home);
  return home;
};

const identity = (root: string = ROOT): RepoIdentity => ({
  repoId: REPO_ID,
  root,
  branch: "main",
  baseCommit: "a1b2c3d4",
});

interface SeedOptions {
  readonly repoId?: string;
  readonly repoRoot?: string;
  readonly hubUrl?: string;
  readonly startedAt: string;
}

const seed = async (
  home: string,
  claudeSessionId: string,
  options: SeedOptions,
): Promise<void> => {
  await writeSessionState(home, {
    claudeSessionId,
    crosscheckSessionId: `cc_${claudeSessionId}`,
    workContextId: `wc_cc_${claudeSessionId}`,
    repoId: options.repoId ?? REPO_ID,
    repoRoot: options.repoRoot ?? ROOT,
    hubUrl: options.hubUrl ?? HUB,
    developerId: "dev_nick",
    startedAt: options.startedAt,
    lastHeartbeatAt: options.startedAt,
    seenTargets: [],
  });
};

describe("resolveOwnWorkContext", () => {
  test("returns nothing when no session has started in this repo", async () => {
    // Arrange: an MCP server can be launched before any SessionStart hook ran
    const home = await newHome("mcp-none");

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert: null, not a guess — the tool turns this into an actionable message
    expect(own).toBeNull();
  });

  test("finds the deterministic ids SessionStart wrote", async () => {
    // Arrange
    const home = await newHome("mcp-one");
    await seed(home, "a-uuid", { startedAt: "2026-07-24T09:00:00.000Z" });

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert
    expect(own?.crosscheckSessionId).toBe("cc_a-uuid");
    expect(own?.workContextId).toBe("wc_cc_a-uuid");
    expect(own?.claudeSessionId).toBe("a-uuid");
  });

  test("carries the developer id the hub will check the producer against", async () => {
    // Arrange: `/api/records` rejects any envelope whose producer.developerId is
    // not the authenticated developer (services/records.ts `ingestOne`). A hook
    // fixes that at flush time by rewriting the producer; an MCP tool has no
    // flush, so it must know who it is before it posts. The session state file
    // is where SessionStart recorded that, and it is the only place on the
    // machine that has it when ~/.crosscheck/config.json carries no developerId.
    const home = await newHome("mcp-developer");
    await seed(home, "who-uuid", { startedAt: "2026-07-24T09:00:00.000Z" });

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert
    expect(own?.developerId).toBe("dev_nick");
  });

  test("ignores a session on a different repo", async () => {
    // Arrange: one home serves every repo the developer works on
    const home = await newHome("mcp-other-repo");
    await seed(home, "other-uuid", {
      repoId: "github.com/acme/web",
      repoRoot: "/tmp/acme-web",
      startedAt: "2026-07-24T10:00:00.000Z",
    });

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert
    expect(own).toBeNull();
  });

  test("ignores a session against a different hub", async () => {
    // Arrange: the same repo on two hubs is two trust spaces, and a claim must
    // never be published into the wrong one
    const home = await newHome("mcp-other-hub");
    await seed(home, "hub-uuid", {
      hubUrl: OTHER_HUB,
      startedAt: "2026-07-24T10:00:00.000Z",
    });

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert
    expect(own).toBeNull();
  });

  test("prefers the session in THIS worktree over one in a sibling", async () => {
    // Arrange: two worktrees of one repo share a repoId and differ by root.
    // The sibling is NEWER, so recency alone would pick the wrong one — this is
    // the case that makes root the primary key rather than a tie-break.
    const home = await newHome("mcp-worktree");
    await seed(home, "here-uuid", { startedAt: "2026-07-24T09:00:00.000Z" });
    await seed(home, "there-uuid", {
      repoRoot: WORKTREE,
      startedAt: "2026-07-24T11:00:00.000Z",
    });

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert
    expect(own?.crosscheckSessionId).toBe("cc_here-uuid");
  });

  test("falls back to the repo when no session names this exact root", async () => {
    // Arrange: the MCP server's cwd can resolve to a root spelling no session
    // recorded (a symlinked checkout). Same repo, same hub — refusing to publish
    // would be worse than publishing to the session that is demonstrably here.
    const home = await newHome("mcp-root-fallback");
    await seed(home, "elsewhere-uuid", {
      repoRoot: "/private/tmp/acme-api",
      startedAt: "2026-07-24T09:00:00.000Z",
    });

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert
    expect(own?.crosscheckSessionId).toBe("cc_elsewhere-uuid");
  });

  test("KNOWN LIMITATION: two sessions in one worktree resolve to the newest", async () => {
    // Arrange: Claude Code hands an MCP server no session id, so two agent
    // sessions in the same worktree against the same hub are indistinguishable
    // from in here. The newest wins, which is right more often than not and is
    // NOT always right.
    const home = await newHome("mcp-ambiguous");
    await seed(home, "older-uuid", { startedAt: "2026-07-24T09:00:00.000Z" });
    await seed(home, "newer-uuid", { startedAt: "2026-07-24T11:00:00.000Z" });

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert: deterministic, and documented as a limitation rather than as a
    // correct answer. The day Claude Code passes a session id to MCP servers,
    // this test is the one that should change.
    expect(own?.crosscheckSessionId).toBe("cc_newer-uuid");
  });

  test("survives an unparseable state file instead of failing the tool", async () => {
    // Arrange: a half-written file from a crashed hook must not make every
    // publish_claim in the repo fail
    const home = await newHome("mcp-corrupt");
    await seed(home, "good-uuid", { startedAt: "2026-07-24T09:00:00.000Z" });
    await Bun.write(`${home}/sessions/broken.json`, "{ not json");

    // Act
    const own = await resolveOwnWorkContext(home, identity(), HUB);

    // Assert
    expect(own?.crosscheckSessionId).toBe("cc_good-uuid");
  });
});
