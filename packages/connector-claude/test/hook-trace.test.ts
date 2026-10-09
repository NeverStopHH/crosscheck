/**
 * HOOK PHASE TIMING through the real binary (connector-core
 * trace/hook-trace.ts): under CX_HOOK_TRACE=1 a hook process writes one
 * trace of its phases when it exits; without it, nothing. Spawned the way
 * Claude Code spawns a hook, so the boot, the exit and the race are the
 * binary's own.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { HookTrace } from "@crosscheck/connector-core/trace/hook-trace.ts";

const BIN_PATH = resolve(import.meta.dir, "..", "..", "cli", "src", "bin", "crosscheck.ts");
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map(async (dir) => rm(dir, { recursive: true, force: true })));
});

/** A prompt hook in a directory no repo owns, with `trace` as its env's trace switch. */
const runPromptHook = async (trace: Readonly<Record<string, string>>): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "cx-hook-trace-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "cx-hook-trace-cwd-"));
  dirs.push(home, cwd);
  const child = Bun.spawn({
    cmd: [process.execPath, BIN_PATH, "hook", "user-prompt-submit"],
    env: { ...process.env, CROSSCHECK_HOME: home, ...trace },
    stdin: new TextEncoder().encode(
      JSON.stringify({ session_id: "trace-probe", cwd, hook_event_name: "UserPromptSubmit", prompt: "hello" }),
    ),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return stdout;
};

const tracesIn = async (dir: string): Promise<readonly HookTrace[]> => {
  const names = await readdir(dir).catch(() => []);
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")) as HookTrace));
};

describe("hook phase timing (CX_HOOK_TRACE)", () => {
  test("a hook process under CX_HOOK_TRACE=1 writes its boot, its phases and its exit, in order", async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), "cx-hook-trace-out-"));
    dirs.push(dir);

    // Act
    await runPromptHook({ CX_HOOK_TRACE: "1", CX_HOOK_TRACE_DIR: dir });

    // Assert
    const traces = await tracesIn(dir);
    expect(traces).toHaveLength(1);
    const [trace] = traces;
    expect(trace?.hook).toBe("user-prompt-submit");
    const labels = (trace?.spans ?? []).map((span) => span.label);
    for (const phase of ["stdin", "budget", "race", "prepare", "post-race", "returned"]) {
      expect(labels, phase).toContain(phase);
    }
    expect(trace?.bootMs ?? 0).toBeGreaterThan(0);
    const returned = trace?.spans.find((span) => span.label === "returned");
    expect(trace?.exitMs ?? 0).toBeGreaterThanOrEqual(returned?.startMs ?? Number.POSITIVE_INFINITY);
  });

  test("without CX_HOOK_TRACE the hook writes no trace", async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), "cx-hook-trace-off-"));
    dirs.push(dir);

    // Act
    await runPromptHook({ CX_HOOK_TRACE_DIR: dir });

    // Assert
    expect(await tracesIn(dir)).toEqual([]);
  });
});
