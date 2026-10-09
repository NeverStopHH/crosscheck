/**
 * `crosscheck doctor` says when the hub is still rebuilding search documents
 * (review round 4, M2).
 *
 * An upgraded hub rebuilds its older search docs in the background, and
 * until it has, search finds those work contexts by their claims only — a
 * thin result with no visible reason. GET /api/hub-status counts what is
 * left; doctor prints a line while it is not zero, and nothing once it is —
 * or when an older hub has no such endpoint.
 */
import { serveLoopback } from "../../connector-core/test/fixtures/loopback-serve.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runDoctor } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const HTTP_NOT_FOUND = 404;
const LINE_NAME = "search index";

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A hub that answers /api/hub-status with `answer` and every other read with an empty page. */
const hubWith = (answer: () => Response): string => {
  const server = serveLoopback({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/hub-status" ? answer() : Response.json({ ok: true, data: { sessions: [] } }),
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const doctor = async (answer: () => Response): Promise<string> => {
  const repo = await makeRepo("doctor-search-rebuild", { remote: "git@github.com:acme/api.git" });
  const home = await makeHome("doctor-search-rebuild");
  paths.push(repo, home);
  const result = await runDoctor(
    { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: hubWith(answer), CROSSCHECK_API_KEY: "test-key" },
    repo,
    async () => null,
  );
  return result.stdout;
};

const pending = (count: number) => (): Response => Response.json({ ok: true, data: { searchDocsPending: count } });

describe("the search index doctor line", () => {
  test("a hub still rebuilding says how many search documents are left", async () => {
    const stdout = await doctor(pending(1234));

    expect(stdout).toContain(
      "WARN  search index  hub is still rebuilding 1234 search documents; until it finishes, search finds them by their claims only",
    );
  });

  test("a hub with nothing left to rebuild prints no line", async () => {
    const stdout = await doctor(pending(0));

    expect(stdout).not.toContain(LINE_NAME);
  });

  test("an older hub without the endpoint prints no line", async () => {
    const stdout = await doctor(() => Response.json({ ok: false, error: { code: "not_found" } }, { status: HTTP_NOT_FOUND }));

    expect(stdout).not.toContain(LINE_NAME);
  });
});

/**
 * The start-up backfills after an upgrade, by the same endpoint (batch-2
 * integration review, M10 and M11): the rows still waiting for their
 * hint-floor words, and — on a hub with an embedder — the work contexts
 * still waiting for a vector. A line each while there is something left;
 * none at zero, none when the hub does not say (an older hub, a keyless one).
 */
describe("the start-up backfill doctor lines", () => {
  const status = (fields: Record<string, unknown>) => (): Response =>
    Response.json({ ok: true, data: { searchDocsPending: 0, ...fields } });

  test("a hub still filling the words index says how many rows are left and what that costs", async () => {
    const stdout = await doctor(status({ wordsIndexPending: 4321, vectorsPending: null }));

    expect(stdout).toContain(
      "WARN  words index  hub is still indexing the dotted names of 4321 rows; until it finishes, a name such as products.name in them matches only whole",
    );
  });

  test("a hub still embedding says how many work contexts are left", async () => {
    const stdout = await doctor(status({ wordsIndexPending: 0, vectorsPending: 567 }));

    expect(stdout).toContain(
      "WARN  vector index  hub is still embedding 567 work contexts; until it finishes, the vector tier misses them",
    );
    expect(stdout).not.toContain("words index");
  });

  test("nothing left, a keyless hub, or an older hub that sends neither field prints neither line", async () => {
    const done = await doctor(status({ wordsIndexPending: 0, vectorsPending: 0 }));
    const keyless = await doctor(status({ wordsIndexPending: 0, vectorsPending: null }));
    const older = await doctor(status({}));

    for (const stdout of [done, keyless, older]) {
      expect(stdout).not.toContain("words index");
      expect(stdout).not.toContain("vector index");
    }
  });
});
