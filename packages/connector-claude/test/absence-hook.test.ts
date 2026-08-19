import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const MS_PER_DAY = 86_400_000;

interface RecordedEnvelope {
  readonly kind: string;
  readonly body: {
    readonly repo?: string;
    readonly authors?: readonly { readonly email: string }[];
  };
}

interface FakeHub {
  readonly url: string;
  readonly recordsSeen: RecordedEnvelope[];
  readonly stop: () => void;
}

/**
 * A healthy hub whose /api/absences answers with one fixed inactive finding —
 * unless `absencesBody` overrides it (the fail-open case sends garbage).
 */
const startHub = (absencesBody?: unknown): FakeHub => {
  const recordsSeen: RecordedEnvelope[] = [];
  const now = Date.now();
  const absences = absencesBody ?? {
    ok: true,
    data: {
      absences: [
        {
          kind: "inactive",
          name: "Robin",
          latestCommitAt: new Date(now - 2 * MS_PER_DAY).toISOString(),
          lastSessionAt: new Date(now - 9 * MS_PER_DAY).toISOString(),
          evidenceCollectedAt: new Date(now).toISOString(),
        },
      ],
    },
  };
  const session = (): Response =>
    Response.json({
      ok: true,
      data: { session: { id: "cc_x", developerId: "dev_self" } },
    });
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
      if (pathname === "/api/absences") {
        return Response.json(absences);
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
      return session();
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
  readonly env: Env;
  readonly hub: FakeHub;
}

const fixture = async (
  label: string,
  absencesBody?: unknown,
): Promise<Fixture> => {
  const hub = startHub(absencesBody);
  hubs.push(hub);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
    hub,
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

describe("session-start absence integration", () => {
  test("renders the hub's absence findings in the briefing", async () => {
    // Arrange
    const { repo, env } = await fixture("absence-brief");

    // Act
    const stdout = await runHook("session-start", sessionStart(repo, "s1"), env);

    // Assert
    const briefing = briefingOf(stdout);
    expect(briefing).toContain(
      "Commit authors on this repo without a recent agent session:",
    );
    expect(briefing).toContain(
      "- Robin · last commit 2d ago · last reported session 9d ago",
    );
  });

  test("ships the repo's commit authorship to the hub as a commit_evidence record", async () => {
    // Arrange: makeRepo's initial commit (dev@example.com) is inside the window
    const { repo, env, hub } = await fixture("absence-ship");

    // Act
    await runHook("session-start", sessionStart(repo, "s2"), env);

    // Assert
    const evidence = hub.recordsSeen.find(
      (record) => record.kind === "commit_evidence",
    );
    expect(evidence).toBeDefined();
    expect(evidence?.body.repo).toBe("github.com/acme/api");
    expect(
      evidence?.body.authors?.some(
        (author) => author.email === "dev@example.com",
      ),
    ).toBe(true);
  });

  test("a hub without the absences endpoint costs nothing but the section", async () => {
    // Arrange: the endpoint answers with an unrecognisable envelope, which is
    // what an older hub's 404 body is to this client
    const { repo, env } = await fixture("absence-degrade", {
      unexpected: true,
    });

    // Act
    const stdout = await runHook("session-start", sessionStart(repo, "s3"), env);

    // Assert: briefing still renders presence; no absence section, no crash
    const briefing = briefingOf(stdout);
    expect(briefing).toContain("Alice");
    expect(briefing).not.toContain("Commit authors");
  });
});
