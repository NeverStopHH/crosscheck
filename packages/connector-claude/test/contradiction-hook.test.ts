/**
 * SessionStart discovery wiring for contradiction pointers (VISION.md §4):
 * the hook fetches GET /api/contradictions as one more parallel GET inside
 * the same fetch block as presence/work-contexts/absences, and a hub without
 * the endpoint — or answering garbage — costs the section, never the
 * briefing (fail open, like every hub call a hook makes).
 *
 * The rendering rules live in test/briefing-contradictions.test.ts; this
 * file proves the real hook, through the real binary, carries them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const PAIR_ID = "cx_0123456789abcdef0123456789abcdef";

interface FakeHub {
  readonly url: string;
  readonly stop: () => void;
}

/** A healthy hub whose /api/contradictions answers one fixed open pair. */
const startHub = (contradictionsBody?: unknown): FakeHub => {
  const contradictions = contradictionsBody ?? {
    ok: true,
    data: {
      candidates: [
        {
          id: PAIR_ID,
          claimA: {
            id: "clm_a",
            workContextId: "wc_a",
            kind: "hypothesis",
            status: "proposed",
            authorDeveloperName: "Alice",
          },
          claimB: {
            id: "clm_b",
            workContextId: "wc_b",
            kind: "hypothesis",
            status: "rejected",
            authorDeveloperName: "Robin",
          },
          reason: "shared_target",
          similarity: null,
        },
      ],
    },
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/contradictions") {
        return Response.json(contradictions);
      }
      if (pathname === "/api/records") {
        return Response.json({
          ok: true,
          data: { accepted: 1, duplicates: 0, ignored: 0, rejected: 0 },
        });
      }
      if (pathname === "/api/presence") {
        return Response.json({
          ok: true,
          data: {
            sessions: [
              {
                sessionId: "cc_other",
                developerId: "dev_other",
                developerName: "Alice",
                branch: "feat/auth",
                status: "implementing",
                lastHeartbeatAt: new Date().toISOString(),
                isSelf: false,
              },
            ],
          },
        });
      }
      if (pathname === "/api/work-contexts") {
        return Response.json({ ok: true, data: { workContexts: [] } });
      }
      if (pathname === "/api/absences") {
        return Response.json({ ok: true, data: { absences: [] } });
      }
      return Response.json({
        ok: true,
        data: { session: { id: "cc_x", developerId: "dev_self" } },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
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
  readonly env: Env;
}

const fixture = async (
  label: string,
  contradictionsBody?: unknown,
): Promise<Fixture> => {
  const hub = startHub(contradictionsBody);
  hubs.push(hub);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
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

describe("session-start contradiction integration", () => {
  test("points at the hub's open contradiction in the briefing", async () => {
    // Arrange
    const { repo, env } = await fixture("cx-brief");

    // Act
    const stdout = await runHook("session-start", sessionStart(repo, "s1"), env);

    // Assert
    const briefing = briefingOf(stdout);
    expect(briefing).toContain("Conflicting positions");
    expect(briefing).toContain(
      `- Alice (hypothesis, proposed) vs Robin (hypothesis, rejected) · get_referee_brief ${PAIR_ID}`,
    );
  });

  test("a hub without the contradictions endpoint costs nothing but the section", async () => {
    // Arrange: an unrecognisable envelope, which is what an older hub's 404
    // body is to this client
    const { repo, env } = await fixture("cx-degrade", { unexpected: true });

    // Act
    const stdout = await runHook("session-start", sessionStart(repo, "s2"), env);

    // Assert: presence still renders; no contradiction section, no crash
    const briefing = briefingOf(stdout);
    expect(briefing).toContain("Alice");
    expect(briefing).not.toContain("Conflicting positions");
  });
});
