/**
 * THE AUTHOR'S NOTICE, Mike's side, through the real SessionStart hook
 * (docs/1.0/landed-changes.md, step 4): his briefing tells a waiting notice —
 * unless no person reads the session (`CROSSCHECK_TRIPWIRE=notice`, the mark
 * of a headless run), where it is not even fetched, so it is not spent on a
 * run nobody reads.
 *
 * THE HUB IS BOUND TO THE ADDRESS THE HOOK IS GIVEN (2026-10-08). Bound by
 * `Bun.serve({ port: 0 })` alone it listened on the dual-stack wildcard
 * `*:<port>`, while the hook was handed `http://127.0.0.1:<port>`, and on
 * this host ANY other process that binds `127.0.0.1:<that port>` afterwards
 * is allowed to and then answers every new connection to it — measured: six
 * of six requests reached the other process. One full-suite run, with other
 * sessions' suites on the machine, got an empty briefing in 181 ms against a
 * 5000 ms budget, and 130 stressed reruns never recurred: the budget never
 * expired and the CPU was not the cause, and this is the one mechanism found
 * that yields a fast, rare, load-independent empty answer. Bound to 127.0.0.1
 * itself, a second bind there is refused and a wildcard one no longer takes
 * the traffic — pinned by the first test below.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** The one address the hub listens on, and the one the hook is handed. */
const HUB_HOST = "127.0.0.1";

interface NoticeHub {
  readonly url: string;
  readonly port: number;
  readonly noticeCalls: () => number;
  readonly postedKinds: readonly string[];
  readonly stop: () => void;
}

/** Answers the notices list with one notice, records what is posted, and nothing else. */
const startNoticeHub = (): NoticeHub => {
  let calls = 0;
  const postedKinds: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: HUB_HOST,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/landed/notices") {
        calls += 1;
        return Response.json({
          ok: true,
          data: {
            notices: [
              {
                id: "lnt_1",
                readerName: "Nick",
                path: "src/lines.ts",
                stoppedAt: new Date(Date.now() - 60_000).toISOString(),
                commits: [
                  { id: "lnt_1", sha: "0dcfc4e9a1b2c3d4e5f60718293a4b5c6d7e8f90", subject: "Fix line offset", missing: true },
                ],
              },
            ],
          },
        });
      }
      if (pathname === "/api/records") {
        const body = (await request.json()) as { records: readonly { kind?: string }[] };
        postedKinds.push(...body.records.map((record) => record.kind ?? ""));
        return Response.json({
          ok: true,
          data: { accepted: body.records.length, duplicates: 0, ignored: 0, rejected: 0 },
        });
      }
      return Response.json({ ok: true, data: { session: { id: "cc_x", developerId: "dev_self" } } });
    },
  });
  return {
    url: `http://${HUB_HOST}:${String(server.port)}`,
    port: server.port,
    noticeCalls: () => calls,
    postedKinds,
    stop: () => {
      server.stop(true);
    },
  };
};

const paths: string[] = [];
const hubs: NoticeHub[] = [];

afterEach(async () => {
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const fixture = async (label: string, extra: Env = {}) => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startNoticeHub();
  hubs.push(hub);
  const env: Env = {
    CROSSCHECK_HOME: home,
    CROSSCHECK_HUB_URL: hub.url,
    CROSSCHECK_API_KEY: "test-key",
    CROSSCHECK_TIMEOUT_MS: "2000",
    CROSSCHECK_LANDING_FETCH: "off",
    ...extra,
  };
  return { repo, hub, env };
};

const sessionStart = (repo: string, sessionId: string): string =>
  JSON.stringify({ session_id: sessionId, cwd: repo, hook_event_name: "SessionStart", source: "startup" });

const briefingOf = (stdout: string): string =>
  stdout.length === 0
    ? ""
    : ((JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
        ?.additionalContext ?? "");

/** Whether ANOTHER process may bind `host:port`: "bound" or "refused". */
const bindFromAnotherProcess = (host: string, port: number): string => {
  const probe = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `try { Bun.serve({ port: ${String(port)}, hostname: "${host}", fetch: () => new Response("") }); console.log("bound"); } catch { console.log("refused"); } process.exit(0);`,
    ],
    timeout: 20_000,
  });
  return new TextDecoder().decode(probe.stdout).trim();
};

describe("Mike's briefing tells a waiting notice", () => {
  test("no other process can answer the hub URL this test hands the hook", async () => {
    // Arrange
    const { hub } = await fixture("author-brief-bind");

    // Act
    const answer = bindFromAnotherProcess(HUB_HOST, hub.port);

    // Assert: refused — so every request below reaches THIS hub.
    expect(answer).toBe("refused");
  });

  test("in a session a person reads, and marks it told", async () => {
    const { repo, hub, env } = await fixture("author-brief");

    const briefing = briefingOf(await runHook("session-start", sessionStart(repo, "s-author"), env));

    // The stage first: a failure then says whether the notice was ever asked.
    expect(hub.noticeCalls()).toBe(1);
    expect(briefing).toContain("Teammates ran into your landed changes (each notice is shown once):");
    expect(briefing).toContain("0dcfc4e «Fix line offset»: was missing from Nick's checkout");
    expect(hub.postedKinds).toContain("landed_notice_delivery");
  });

  test("never in a headless run: the notices are not even fetched, so none is spent", async () => {
    const { repo, hub, env } = await fixture("author-brief-headless", { CROSSCHECK_TRIPWIRE: "notice" });

    const briefing = briefingOf(await runHook("session-start", sessionStart(repo, "s-headless"), env));

    expect(briefing).not.toContain("ran into your landed change");
    expect(hub.noticeCalls()).toBe(0);
    expect(hub.postedKinds).not.toContain("landed_notice_delivery");
  });
});
