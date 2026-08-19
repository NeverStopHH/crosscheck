/**
 * The bin dispatch, end to end: `crosscheck cursor-hook <event>` through the
 * REAL binary (`packages/cli` since Block 8 — the one bin fronting this
 * package). Exit 0 ALWAYS — Cursor reads exit 2 as a block and other
 * non-zero exits as failures worth logging; this connector is never either
 * — and stdout is always parseable directive-free JSON.
 */
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { SESSION_START_INPUT } from "./fixtures/cursor-contract/payloads.ts";

const BIN = resolve(
  import.meta.dir,
  "..",
  "..",
  "cli",
  "src",
  "bin",
  "crosscheck.ts",
);

const REMOTE = "git@github.com:acme/api.git";

interface BinRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

const runBin = async (
  args: readonly string[],
  stdin: string,
  env: Record<string, string>,
): Promise<BinRun> => {
  const startedAt = performance.now();
  const proc = Bun.spawn({
    cmd: [process.execPath, BIN, ...args],
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, elapsedMs: performance.now() - startedAt };
};

describe("crosscheck cursor-hook through the real binary", () => {
  test("a healthy payload on an unconnected machine: exit 0, {}, silent stderr, fast", async () => {
    // Arrange
    const repo = await makeRepo("bin-nologin", { remote: REMOTE });
    const home = await makeHome("bin-nologin");

    // Act
    const run = await runBin(
      ["cursor-hook", "sessionStart"],
      JSON.stringify({
        ...SESSION_START_INPUT,
        workspace_roots: [repo],
      }),
      { CROSSCHECK_HOME: home },
    );

    // Assert: the fail-open contract, measured through the process boundary.
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe("{}");
    expect(run.stderr).toBe("");
    // Process floor + git spawns + the silent ladder — generous CI bound,
    // far under anything Cursor would notice against its seconds-scale
    // timeout.
    expect(run.elapsedMs).toBeLessThan(3000);
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  test("an unknown event name: exit 0 and {} — never a usage error on a hook path", async () => {
    const home = await makeHome("bin-unknown");
    const run = await runBin(["cursor-hook", "noSuchEvent"], "{}", {
      CROSSCHECK_HOME: home,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe("{}");
    await rm(home, { recursive: true, force: true });
  });

  test("garbage stdin: exit 0 and {} — the tripwire counts, the process never fails", async () => {
    const home = await makeHome("bin-garbage");
    const run = await runBin(
      ["cursor-hook", "afterFileEdit"],
      "definitely not json",
      { CROSSCHECK_HOME: home },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe("{}");
    await rm(home, { recursive: true, force: true });
  });
});
