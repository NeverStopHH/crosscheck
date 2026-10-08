/**
 * DOCTOR RUNS NO COMMAND A REPO CHOSE (cli/doctor.ts `mcpProbeTarget`).
 *
 * `crosscheck doctor` proves the MCP server starts by spawning the registered
 * entry. A repo's committed `.mcp.json` is shared content, and the ownership
 * test only recognises a crosscheck-SHAPED entry — `sh -c "… crosscheck mcp"`
 * passes it — so before this guard a cloned repo could make doctor run any
 * command the moment a person typed `crosscheck doctor` there. A project
 * entry is now spawned only when it is exactly what this install's init
 * writes; the developer's own user-scope entry is still probed (the control
 * arm), always from a neutral cwd.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { RUNTIME_ISOLATION_FLAGS } from "@crosscheck/connector-core/config/runtime-isolation.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** This install's own entry, the one init writes into an MCP entry. */
const OWN_ENTRY = resolve(import.meta.dir, "..", "src", "bin", "crosscheck.ts");

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

const acceptingHub = (): string => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ ok: true, data: { sessions: [] } }),
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

/** An entry the ownership heuristic accepts, which runs `touch <marker>`. */
const baitEntry = (marker: string): Record<string, unknown> => ({
  type: "stdio",
  command: "/bin/sh",
  args: ["-c", `touch ${marker} # crosscheck mcp`],
});

const setup = async (label: string): Promise<{ repo: string; home: string; marker: string; env: Record<string, string> }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hubUrl = acceptingHub();
  return {
    repo,
    home,
    marker: join(home, "probe-ran"),
    env: { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: "test-key" },
  };
};

describe("doctor's MCP probe", () => {
  test("does not run the command a repo's committed .mcp.json names", async () => {
    // Arrange
    const s = await setup("probe-trust-repo");
    await writeFile(join(s.repo, ".mcp.json"), `${JSON.stringify({ mcpServers: { crosscheck: baitEntry(s.marker) } })}\n`, "utf8");

    // Act
    const result = await runDoctor(s.env, s.repo, async () => null);

    // Assert
    expect(await Bun.file(s.marker).exists()).toBe(false);
    expect(result.stdout).toContain("this repo's .mcp.json names a command crosscheck did not write here");
  });

  test("runs every probe from a neutral directory, never the repo", async () => {
    // Arrange — the developer's own entry, which records where it was started
    const s = await setup("probe-trust-cwd");
    const entry = { type: "stdio", command: "/bin/sh", args: ["-c", `pwd > ${s.marker} # crosscheck mcp`] };
    await writeFile(join(s.home, ".claude.json"), `${JSON.stringify({ mcpServers: { crosscheck: entry } })}\n`, "utf8");

    // Act
    await runDoctor(s.env, s.repo, async () => null);

    // Assert — bun would read a repo cwd's bunfig and .env for the probe
    const cwd = (await Bun.file(s.marker).text()).trim();
    expect(cwd.length).toBeGreaterThan(0);
    expect(cwd).not.toContain(s.repo.split("/").at(-1) ?? s.repo);
  });

  test("does not run another binary that carries the flags and this install's own entry", async () => {
    // Arrange — review round 2, R7: every conjunct but the runtime matches,
    // and the binary is the repo's own stand-in for bun
    const s = await setup("probe-trust-other-bun");
    const standIn = join(s.repo, "tools", "bun");
    await mkdir(join(s.repo, "tools"), { recursive: true });
    await writeFile(standIn, `#!/bin/sh\ntouch ${s.marker}\nexec "${process.execPath}" "$@"\n`, "utf8");
    await chmod(standIn, 0o755);
    const entry = { type: "stdio", command: standIn, args: [...RUNTIME_ISOLATION_FLAGS, OWN_ENTRY, "mcp"] };
    await writeFile(join(s.repo, ".mcp.json"), `${JSON.stringify({ mcpServers: { crosscheck: entry } })}\n`, "utf8");

    // Act
    const result = await runDoctor(s.env, s.repo, async () => null);

    // Assert
    expect(await Bun.file(s.marker).exists()).toBe(false);
    expect(result.stdout).toContain("this repo's .mcp.json names a command crosscheck did not write here");
  });

  test("probes the entry init writes: the running bun, the flags, this install's entry", async () => {
    // Arrange — the same args as above under the runtime doctor runs on, so
    // the case above differs from a probed entry by its command alone
    const s = await setup("probe-trust-own-bun");
    const entry = { type: "stdio", command: process.execPath, args: [...RUNTIME_ISOLATION_FLAGS, OWN_ENTRY, "mcp"] };
    await writeFile(join(s.repo, ".mcp.json"), `${JSON.stringify({ mcpServers: { crosscheck: entry } })}\n`, "utf8");

    // Act
    const result = await runDoctor(s.env, s.repo, async () => null);

    // Assert — the real server started and listed its tools
    expect(result.stdout).toMatch(/mcp tools usable[^\n]*\d+ tools, and they will call/);
  }, 30_000);

  test("still probes the developer's own user-scope entry (the control arm)", async () => {
    // Arrange — the same command, in a file only the developer writes
    const s = await setup("probe-trust-user");
    await writeFile(join(s.home, ".claude.json"), `${JSON.stringify({ mcpServers: { crosscheck: baitEntry(s.marker) } })}\n`, "utf8");

    // Act
    await runDoctor(s.env, s.repo, async () => null);

    // Assert — the probe ran it, so the test above proves the guard
    expect(await Bun.file(s.marker).exists()).toBe(true);
  });
});
