/**
 * `crosscheck doctor` warns about how the hub is reachable (hub hardening,
 * review M7 and H6; cli/doctor-hub-transport.ts), from the two flags on GET
 * /api/hub-status: a hub that kept 0.10's every-interface listen, and a
 * localhost passkey origin beside an https one. Each WARN carries its fix in
 * doctor's own words. An older hub sends no flags and gets no line, and a
 * malformed block costs nothing but itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { HUB_LISTEN_WARNING, PASSKEY_ORIGINS_WARNING } from "../src/cli/doctor-hub-transport.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

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

/** Doctor against a hub whose /api/hub-status answers `status`, every other read an empty page. */
const doctorWith = async (status: unknown): Promise<string> => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/hub-status"
        ? Response.json({ ok: true, data: status })
        : Response.json({ ok: true, data: { sessions: [] } }),
  });
  servers.push(server);
  const repo = await makeRepo("doctor-hub-transport", { remote: "git@github.com:acme/api.git" });
  const home = await makeHome("doctor-hub-transport");
  paths.push(repo, home);
  const result = await runDoctor(
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(server.port)}`,
      CROSSCHECK_API_KEY: "test-key",
    },
    repo,
    async () => null,
  );
  return result.stdout;
};

describe("the hub transport doctor lines", () => {
  test("a hub on every interface by default is a WARN with the listen fix", async () => {
    const stdout = await doctorWith({
      searchDocsPending: 0,
      transport: { listensOnEveryInterface: true, localhostBesideHttps: false },
    });

    expect(stdout).toContain(`WARN  hub listen  ${HUB_LISTEN_WARNING}`);
    expect(HUB_LISTEN_WARNING).toContain("CROSSCHECK_LISTEN=127.0.0.1,<its tailnet IP>");
    expect(stdout).not.toContain("passkey origins");
  });

  test("a localhost origin beside an https one is a WARN that says to drop localhost", async () => {
    const stdout = await doctorWith({
      searchDocsPending: 0,
      transport: { listensOnEveryInterface: false, localhostBesideHttps: true },
    });

    expect(stdout).toContain(`WARN  passkey origins  ${PASSKEY_ORIGINS_WARNING}`);
    expect(PASSKEY_ORIGINS_WARNING).toContain("drop localhost from CROSSCHECK_WEBAUTHN_ORIGINS");
    expect(stdout).not.toContain("hub listen");
  });

  test("a hub with neither, or an older hub without the block, prints no line", async () => {
    const quiet = await doctorWith({
      searchDocsPending: 0,
      transport: { listensOnEveryInterface: false, localhostBesideHttps: false },
    });
    const older = await doctorWith({ searchDocsPending: 0 });

    for (const stdout of [quiet, older]) {
      expect(stdout).not.toContain("hub listen");
      expect(stdout).not.toContain("passkey origins");
    }
  });

  test("a malformed transport block costs only itself: the search line beside it still prints", async () => {
    const stdout = await doctorWith({ searchDocsPending: 12, transport: { listensOnEveryInterface: "yes" } });

    expect(stdout).toContain("hub is still rebuilding 12 search documents");
    expect(stdout).not.toContain("hub listen");
  });
});
