/**
 * SessionStart end-to-end for the collective-memory block (VISION.md §1):
 * the solved-before pointer reaches the briefing, its delivery flows through
 * hint_deliveries like every other injected ref, the landed ancestry check
 * reports what git proves, and the session state remembers the pointer so
 * the prompt path cannot repeat it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { readSessionState } from "../src/state/session-state.ts";
import { runGit } from "../src/git/git.ts";
import { git, makeHome, makeRepo } from "./helpers.ts";

const DAY_MS = 86_400_000;
const SOLVED_CONTEXT_ID = "wc_prev";

interface RecordedEnvelope {
  readonly kind: string;
  readonly body: Record<string, unknown>;
}

interface FakeHub {
  readonly url: string;
  readonly recordsSeen: RecordedEnvelope[];
  readonly stop: () => void;
}

/** A hub with one solved match and one open listed context (base = mainSha). */
const startHub = (listedBaseCommit: string): FakeHub => {
  const recordsSeen: RecordedEnvelope[] = [];
  const now = Date.now();
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/records") {
        const body = (await request.json()) as {
          records: readonly RecordedEnvelope[];
        };
        recordsSeen.push(...body.records);
        return Response.json({
          ok: true,
          data: {
            accepted: body.records.length,
            duplicates: 0,
            ignored: 0,
            rejected: 0,
          },
        });
      }
      if (pathname === "/api/solved-matches") {
        return Response.json({
          ok: true,
          data: {
            matches: [
              {
                workContextId: SOLVED_CONTEXT_ID,
                title: "Refresh 500s after key rotation",
                developerName: "Robin",
                solvedAt: new Date(now - 150 * DAY_MS).toISOString(),
                landedAt: null,
                matchedTargetKind: "error_fingerprint",
              },
            ],
          },
        });
      }
      if (pathname === "/api/work-contexts") {
        return Response.json({
          ok: true,
          data: {
            workContexts: [
              {
                id: "wc_open",
                developerId: "dev_other",
                developerName: "Alice",
                title: "Key rotation cleanup",
                status: "implementing",
                baseCommit: listedBaseCommit,
                landedAt: null,
                createdAt: new Date(now - DAY_MS).toISOString(),
                updatedAt: null,
              },
            ],
          },
        });
      }
      if (pathname === "/api/presence") {
        return Response.json({ ok: true, data: { sessions: [] } });
      }
      if (pathname === "/api/absences") {
        return Response.json({ ok: true, data: { absences: [] } });
      }
      if (pathname === "/api/contradictions") {
        return Response.json({ ok: true, data: { candidates: [] } });
      }
      return Response.json({
        ok: true,
        data: { session: { id: "cc_x", developerId: "dev_self" } },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    recordsSeen,
    stop: () => {
      server.stop(true);
    },
  };
};

const paths: string[] = [];
const hubs: FakeHub[] = [];

afterEach(async () => {
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: FakeHub;
  readonly env: Env;
  readonly mainSha: string;
}

/** A repo whose origin/main covers HEAD, hub listing that commit as a base. */
const fixture = async (label: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(repo, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  const mainSha = await runGit(["rev-parse", "HEAD"], repo);
  if (mainSha === null) {
    throw new Error("fixture repo has no HEAD");
  }
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startHub(mainSha);
  hubs.push(hub);
  return {
    repo,
    home,
    hub,
    mainSha,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: "2000",
    },
  };
};

const sessionStart = (repo: string, sessionId: string): string =>
  JSON.stringify({
    session_id: sessionId,
    cwd: repo,
    hook_event_name: "SessionStart",
    source: "startup",
  });

const briefingOf = (stdout: string): string => {
  if (stdout.length === 0) {
    return "";
  }
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { additionalContext: string };
  };
  return parsed.hookSpecificOutput.additionalContext;
};

describe("session-start solved-before integration", () => {
  test("the briefing carries the solved pointer with its plain age", async () => {
    // Arrange
    const { repo, env } = await fixture("solved-brief");

    // Act
    const stdout = await runHook("session-start", sessionStart(repo, "s1"), env);

    // Assert
    const briefing = briefingOf(stdout);
    expect(briefing).toContain("Previously solved on this repo");
    expect(briefing).toContain(`get_diagnosis ${SOLVED_CONTEXT_ID}`);
    expect(briefing).toContain("diagnosed 5mo ago");
  });

  test("the shown pointer flows through hint_deliveries", async () => {
    // Arrange
    const { repo, env, hub } = await fixture("solved-telemetry");

    // Act
    await runHook("session-start", sessionStart(repo, "s2"), env);

    // Assert: refs only, never rendered text — the precision loop's ledger.
    const delivery = hub.recordsSeen.find(
      (record) => record.kind === "hint_delivery",
    );
    expect(delivery).toBeDefined();
    expect(delivery?.body["refKind"]).toBe("work_context");
    expect(delivery?.body["refId"]).toBe(SOLVED_CONTEXT_ID);
  });

  test("base commits proven ancestors of the default branch are reported landed", async () => {
    // Arrange
    const { repo, env, hub, mainSha } = await fixture("solved-landed");

    // Act
    await runHook("session-start", sessionStart(repo, "s3"), env);

    // Assert
    const landed = hub.recordsSeen.find(
      (record) => record.kind === "landed_evidence",
    );
    expect(landed).toBeDefined();
    expect(landed?.body["repo"]).toBe("github.com/acme/api");
    expect(landed?.body["defaultBranch"]).toBe("origin/main");
    expect(landed?.body["commits"]).toEqual([mainSha]);
  });

  test("the session state remembers the pointer so the prompt path cannot repeat it", async () => {
    // Arrange
    const { repo, env, home } = await fixture("solved-state");

    // Act
    await runHook("session-start", sessionStart(repo, "s4"), env);

    // Assert
    const state = await readSessionState(home, "s4");
    expect(state?.briefingSolvedRefs).toEqual([SOLVED_CONTEXT_ID]);
  });
});
