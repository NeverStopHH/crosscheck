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
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { runGit } from "@crosscheck/connector-core/git/git.ts";
import { git, makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

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

/** Long enough that five of each crowd the 2200-char briefing budget. */
const CROWD_BRANCH =
  "feature/very-long-descriptive-branch-name-that-crowds-the-briefing-budget";
const CROWD_TITLE =
  "Investigating the intermittent token refresh failures that appear on " +
  "staging after every scheduled key rotation window closes unexpectedly";

const CROWD_TEAMMATES = 5;
const CROWD_CONTRADICTIONS = 3;

/** Five teammates, two long-branch sessions each — ~190 chars a line. */
const crowdPresence = (now: number): readonly Record<string, unknown>[] =>
  Array.from({ length: CROWD_TEAMMATES }, (_, i) =>
    ["a", "b"].map((suffix) => ({
      sessionId: `cc_p${String(i)}${suffix}`,
      developerId: `dev_p${String(i)}`,
      developerName: `Crowding Teammate Number ${String(i)}`,
      branch: `${CROWD_BRANCH}-${suffix}${String(i)}`,
      status: "implementing",
      lastHeartbeatAt: new Date(now - 60_000).toISOString(),
      isSelf: false,
    })),
  ).flat();

/** Five max-length-title contexts; no baseCommit, so no git legs run. */
const crowdContexts = (now: number): readonly Record<string, unknown>[] =>
  Array.from({ length: CROWD_TEAMMATES }, (_, i) => ({
    id: `wc_crowd_${String(i)}`,
    developerId: `dev_p${String(i)}`,
    developerName: `Crowding Teammate Number ${String(i)}`,
    title: `${CROWD_TITLE} ${String(i)}`,
    status: "implementing",
    landedAt: null,
    createdAt: new Date(now - 3_600_000).toISOString(),
    updatedAt: null,
  }));

const crowdContradictions = (): readonly Record<string, unknown>[] =>
  Array.from({ length: CROWD_CONTRADICTIONS }, (_, i) => ({
    id: `cx_crowd${String(i)}`,
    claimA: {
      id: `clm_a${String(i)}`,
      workContextId: "wc_crowd_0",
      kind: "hypothesis",
      status: "proposed",
      authorDeveloperName: "Crowding Teammate Number 0",
    },
    claimB: {
      id: `clm_b${String(i)}`,
      workContextId: "wc_crowd_0",
      kind: "hypothesis",
      status: "rejected",
      authorDeveloperName: "Crowding Teammate Number 1",
    },
    reason: "status_conflict",
  }));

interface HubOptions {
  /** Crowd the sections ahead of the solved one past the briefing budget. */
  readonly crowd?: boolean;
}

/** A hub with one solved match and one open listed context (base = mainSha). */
const startHub = (
  listedBaseCommit: string,
  options: HubOptions = {},
): FakeHub => {
  const recordsSeen: RecordedEnvelope[] = [];
  const now = Date.now();
  const crowd = options.crowd === true;
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
              ...(crowd ? crowdContexts(now) : []),
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
        return Response.json({
          ok: true,
          data: { sessions: crowd ? crowdPresence(now) : [] },
        });
      }
      if (pathname === "/api/absences") {
        return Response.json({ ok: true, data: { absences: [] } });
      }
      if (pathname === "/api/contradictions") {
        return Response.json({
          ok: true,
          data: { candidates: crowd ? crowdContradictions() : [] },
        });
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
const fixture = async (
  label: string,
  options: HubOptions = {},
): Promise<Fixture> => {
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
  const hub = startHub(mainSha, options);
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
    expect(briefing).toContain("Previously solved (get_diagnosis reads the tree)");
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

  test("a briefing too crowded to show the solved section records no deliveries", async () => {
    // Arrange: presence, contexts and contradictions fill the briefing
    // budget before the solved section's turn, so its pointer is never
    // emitted. The delivery ledger and the prompt-path seen-set must then
    // stay empty too — a delivery for a pointer the reader never saw is
    // phantom telemetry, and a seeded ref would suppress a pointer to a
    // tree the reader never heard of.
    const { repo, env, hub, home } = await fixture("solved-crowded", {
      crowd: true,
    });

    // Act
    const stdout = await runHook("session-start", sessionStart(repo, "s5"), env);

    // Assert: a briefing WAS emitted, without the solved section.
    const briefing = briefingOf(stdout);
    expect(briefing.length).toBeGreaterThan(0);
    expect(briefing).not.toContain("Previously solved");
    const deliveries = hub.recordsSeen.filter(
      (record) => record.kind === "hint_delivery",
    );
    expect(deliveries).toEqual([]);
    const state = await readSessionState(home, "s5");
    expect(state?.briefingSolvedRefs).toEqual([]);
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
