/**
 * `mcp tools usable` stops being a claim (trial finding M3).
 *
 * It was `mcpUsableCheck(hasConfig, hubUrl)` called as `mcpUsableCheck(true,
 * config.hubUrl)` — a constant in the branch where a config exists. During the
 * trial it printed `PASS mcp tools usable  they will call http://127.0.0.1:7211`
 * directly beneath `FAIL hub reachable  invalid api key`.
 *
 * The pure half is exercised branch by branch; `runDoctor` is then run against
 * a hub that rejects the key, because that pairing — a PASS under a FAIL — is
 * the defect itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { mcpUsableCheck, runDoctor } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const HTTP_UNAUTHORIZED = 401;
const HUB_LABEL = "http://hub.example";

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

/** Answers, but with a denial — the hub is there, the key is not welcome. */
const rejectingHub = (): string => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { ok: false, error: { code: "unauthorized", message: "unknown api key" } },
        { status: HTTP_UNAUTHORIZED },
      ),
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const acceptingHub = (): string => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true, data: { sessions: [] } }),
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

describe("mcpUsableCheck", () => {
  test("a rejected key FAILs and names the login command", () => {
    // Arrange + Act
    const result = mcpUsableCheck({
      configured: true,
      hubUrl: HUB_LABEL,
      hub: { ok: false, status: HTTP_UNAUTHORIZED, kind: "http" },
      registered: true,
      probe: { kind: "not-probed", why: "decided" },
    });

    // Assert
    expect(result.level).toBe("FAIL");
    expect(result.detail).toContain("api key rejected");
    expect(result.detail).toContain(`crosscheck login ${HUB_LABEL}`);
  });

  test("an unreachable hub WARNs and points at the line that explains it", () => {
    // Arrange + Act
    const result = mcpUsableCheck({
      configured: true,
      hubUrl: HUB_LABEL,
      hub: { ok: false, status: 0, kind: "network" },
      registered: true,
      probe: { kind: "not-probed", why: "decided" },
    });

    // Assert
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain("unreachable");
    expect(result.detail).toContain("hub reachable");
  });

  test("nothing registered in either scope FAILs", () => {
    // Arrange + Act
    const result = mcpUsableCheck({
      configured: true,
      hubUrl: HUB_LABEL,
      hub: { ok: true, status: 200, kind: "http" },
      registered: false,
      probe: { kind: "not-probed", why: "decided" },
    });

    // Assert
    expect(result.level).toBe("FAIL");
    expect(result.detail).toContain("no mcp server is registered");
  });

  test("a server that would not start FAILs with what it said", () => {
    // Arrange + Act
    const result = mcpUsableCheck({
      configured: true,
      hubUrl: HUB_LABEL,
      hub: { ok: true, status: 200, kind: "http" },
      registered: true,
      probe: { kind: "failed", detail: "no tools/list answer within 3000 ms" },
    });

    // Assert
    expect(result.level).toBe("FAIL");
    expect(result.detail).toContain("did not answer");
    expect(result.detail).toContain("cannot start crosscheck");
  });

  test("a healthy handshake passes with the tool count", () => {
    // Arrange + Act
    const result = mcpUsableCheck({
      configured: true,
      hubUrl: HUB_LABEL,
      hub: { ok: true, status: 200, kind: "http" },
      registered: true,
      probe: { kind: "answered", tools: 6 },
    });

    // Assert
    expect(result.level).toBe("PASS");
    expect(result.detail).toContain("6 tools");
  });
});

describe("runDoctor", () => {
  test("no PASS sits under the reachability FAIL when the key is rejected", async () => {
    // Arrange
    const repo = await makeRepo("doctor-mcp-usable", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("doctor-mcp-usable");
    paths.push(repo, home);
    const hubUrl = rejectingHub();

    // Act
    const result = await runDoctor(
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: hubUrl,
        CROSSCHECK_API_KEY: "rotated-away-key",
      },
      repo,
      async () => null,
    );

    // Assert: the pre-fix pairing must be gone
    expect(result.stdout).toContain("FAIL  hub reachable  invalid api key");
    expect(result.stdout).toContain("FAIL  mcp tools usable  api key rejected");
    expect(result.stdout).not.toContain("PASS  mcp tools usable");
  });

  test("CROSSCHECK_DOCTOR_NO_PROBE skips the spawn and says so", async () => {
    // Arrange: registered project entry + a healthy hub
    const repo = await makeRepo("doctor-mcp-noprobe", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("doctor-mcp-noprobe");
    paths.push(repo, home);
    await writeFile(
      join(repo, ".mcp.json"),
      `${JSON.stringify({
        mcpServers: {
          crosscheck: { type: "stdio", command: "crosscheck", args: ["mcp"] },
        },
      })}\n`,
      "utf8",
    );
    const hubUrl = acceptingHub();

    // Act
    const result = await runDoctor(
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: hubUrl,
        CROSSCHECK_API_KEY: "test-key",
        CROSSCHECK_DOCTOR_NO_PROBE: "1",
      },
      repo,
      async () => null,
    );

    // Assert
    expect(result.stdout).toContain("PASS  mcp tools usable  not probed");
    expect(result.stdout).toContain("CROSSCHECK_DOCTOR_NO_PROBE=1");
  });
});
