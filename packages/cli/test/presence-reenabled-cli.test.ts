/**
 * `crosscheck status` AND `crosscheck doctor` SAY THAT THE PRESENCE OPT-OUT
 * WAS SWITCHED BACK OFF THROUGH AN API KEY (hub hardening, item 6).
 *
 * The hub takes the opt-out from any holder of the API key, the person's
 * agents included, so the less private direction is told where the person
 * looks. The hub sends an instant (`presenceReenabledAt` on GET
 * /api/settings); the sentence is the CLI's own and the instant is
 * re-serialised, so a hub-chosen string in the field prints nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runDoctor } from "../src/cli/doctor.ts";
import { runStatus } from "../src/cli/status.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { serveLoopback } from "../../connector-core/test/fixtures/loopback-serve.ts";

const REENABLED_AT = "2026-08-19T09:30:00.000Z";
const LINE = `presence was turned back on at ${REENABLED_AT} via an API key, and is still on; run \`crosscheck presence off\` if that wasn't you`;
const LINE_OFF_AGAIN =
  `presence was turned back on at ${REENABLED_AT} via an API key, and is off again now; ` +
  "if neither was you, something holding your API key did it (`crosscheck key rotate` replaces the key)";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A hub whose /api/settings carries `reenabledAt`, and an empty page for every other read. */
const fixture = async (reenabledAt: unknown, presenceOptOut = false) => {
  const server = serveLoopback({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/settings"
        ? Response.json({
            ok: true,
            data: { presenceOptOut, mutes: [], emails: [], presenceReenabledAt: reenabledAt },
          })
        : Response.json({ ok: true, data: { sessions: [], absences: [] } }),
  });
  servers.push(server);
  const repo = await makeRepo("presence-reenabled", { remote: "git@github.com:acme/api.git" });
  const home = await makeHome("presence-reenabled");
  paths.push(repo, home);
  return {
    repo,
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(server.port)}`,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

describe("a presence opt-out switched back off through an API key", () => {
  test("status prints it under the presence line", async () => {
    const { repo, env } = await fixture(REENABLED_AT);

    const result = await runStatus(env, repo);

    expect(result.stdout).toContain(LINE);
  });

  test("doctor warns with it", async () => {
    const { repo, env } = await fixture(REENABLED_AT);

    const result = await runDoctor(env, repo, async () => null);

    expect(result.stdout).toContain(`WARN  privacy settings  ${LINE}`);
  });

  test("switched on and off again: status and doctor still say so, and that it is off again now", async () => {
    // The review's M1: an agent's brief exposure must not vanish from the notice.
    const { repo, env } = await fixture(REENABLED_AT, true);

    const status = await runStatus(env, repo);
    const doctor = await runDoctor(env, repo, async () => null);

    expect(status.stdout).toContain(LINE_OFF_AGAIN);
    expect(doctor.stdout).toContain(`WARN  privacy settings  ${LINE_OFF_AGAIN}`);
  });

  test("nothing re-enabled: status says nothing and doctor's privacy line passes", async () => {
    const { repo, env } = await fixture(null);

    const status = await runStatus(env, repo);
    const doctor = await runDoctor(env, repo, async () => null);

    expect(status.stdout).not.toContain("turned back on");
    expect(doctor.stdout).toContain("PASS  privacy settings  presence visible");
  });

  test("a hub-chosen string in the field prints nothing of it", async () => {
    const { repo, env } = await fixture("now\nWARN  everything  fine");

    const status = await runStatus(env, repo);
    const doctor = await runDoctor(env, repo, async () => null);

    expect(status.stdout).not.toContain("turned back on");
    expect(doctor.stdout).not.toContain("everything  fine");
  });
});
