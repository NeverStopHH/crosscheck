/**
 * The statusline's failure vocabulary (trial finding M4).
 *
 * `renderForContext` branched on `result.ok` alone, so a rotated or revoked
 * api key — an ANSWER, HTTP 401 — rendered `cx ! hub unreachable · last sync
 * 2h` and sent the developer to look at their network. The status and the
 * failure kind are both on `HubResult` already (http/client.ts); this pins one
 * sentence per state, each naming its own remedy, and pins the CACHED path
 * too: a fresh presence cache means no call was made, so the 401 the last real
 * call booked is still the newest thing known about the hub.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runStatusline } from "../src/index.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "statusline-401-uuid";
const HTTP_UNAUTHORIZED = 401;
/** Refuses connections: the only state that is really "unreachable". */
const DEAD_HUB_URL = "http://127.0.0.1:9";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const serveWith = (handler: () => Response): string => {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

/** The hub is up and says no — the state that used to read as an outage. */
const rejectingHub = (): string =>
  serveWith(() =>
    Response.json(
      { ok: false, error: { code: "unauthorized", message: "unknown api key" } },
      { status: HTTP_UNAUTHORIZED },
    ),
  );

/** Answers 200 with something that is not an envelope at all. */
const garbageHub = (): string =>
  serveWith(() => Response.json({ nonsense: true }));

const fixture = async (
  hubUrl: string,
): Promise<{ readonly repo: string; readonly home: string; readonly env: Record<string, string> }> => {
  const repo = await makeRepo("statusline-401", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("statusline-401");
  paths.push(repo, home);
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "rotated-away-key",
    },
  };
};

const stdinFor = (repo: string): string =>
  JSON.stringify({ session_id: SESSION_ID, cwd: repo });

describe("statusline failure wording", () => {
  test("a rejected key says so, and never calls it an outage", async () => {
    // Arrange
    const hubUrl = rejectingHub();
    const { repo, env } = await fixture(hubUrl);

    // Act
    const line = await runStatusline(stdinFor(repo), env);

    // Assert
    expect(line).toContain("key rejected");
    expect(line).toContain("crosscheck login");
    expect(line).not.toContain("hub unreachable");
  });

  test("a refused connection is still an outage", async () => {
    // Arrange
    const { repo, env } = await fixture(DEAD_HUB_URL);

    // Act
    const line = await runStatusline(stdinFor(repo), env);

    // Assert
    expect(line).toContain("hub unreachable");
    expect(line).not.toContain("key rejected");
  });

  test("an answer that is not an envelope says the hub answered garbage", async () => {
    // Arrange
    const hubUrl = garbageHub();
    const { repo, env } = await fixture(hubUrl);

    // Act
    const line = await runStatusline(stdinFor(repo), env);

    // Assert
    expect(line).toContain("hub answered garbage");
  });

  test("a fresh presence cache does not launder a booked 401 into health", async () => {
    // Arrange: cache fresh enough that no hub call happens at all, plus the
    // status the last real call booked (state/sync-state.ts lastErrorStatus)
    const hubUrl = rejectingHub();
    const { repo, home, env } = await fixture(hubUrl);
    const key = repoKey(hubUrl, REPO_ID);
    const nowIso = new Date().toISOString();
    await mkdir(join(home, "cache"), { recursive: true });
    await writeFile(
      join(home, "cache", `${key}-presence.json`),
      `${JSON.stringify({ fetchedAt: nowIso, entries: [] })}\n`,
      "utf8",
    );
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(
      join(home, "state", `${key}.json`),
      `${JSON.stringify({
        lastSyncAt: nowIso,
        lastOkAt: null,
        lastCaptureOkAt: null,
        lastError: "unauthorized: unknown api key",
        lastErrorStatus: HTTP_UNAUTHORIZED,
        cursorVersion: null,
      })}\n`,
      "utf8",
    );

    // Act
    const line = await runStatusline(stdinFor(repo), env);

    // Assert
    expect(line).toContain("key rejected");
    expect(line).not.toContain("no teammates");
  });
});
