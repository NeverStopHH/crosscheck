/**
 * The doctor's Cursor section (design §3.4), through the REAL runDoctor:
 * absent install = one informational PASS; a real install gets hooks +
 * launcher + mcp + version + contract-drift lines; a seeded drift ledger
 * becomes the WARN that stops a renamed payload field dying silently
 * (§10 risk 5 on the Cursor surface).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/cli/index.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REMOTE = "git@github.com:acme/api.git";
const HUB_URL = "http://127.0.0.1:19998";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
  cleanups.length = 0;
});

const fixture = async (label: string) => {
  const repo = await makeRepo(label, { remote: REMOTE });
  const home = await makeHome(label);
  cleanups.push(repo, home);
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

describe("doctor's cursor section", () => {
  test("no cursor install: one informational PASS line, nothing else", async () => {
    // Arrange
    const { repo, env } = await fixture("doc-none");

    // Act
    const result = await runDoctor(env, repo);

    // Assert
    expect(result.stdout).toContain("PASS  cursor hooks  not installed");
    expect(result.stdout).not.toContain("cursor contract drift");
  });

  test("a real install: hooks, launcher, mcp, version and drift lines all render", async () => {
    // Arrange: the composed init writes the real files.
    const { repo, home, env } = await fixture("doc-installed");
    const init = await runCli(["init", "--cursor"], env, repo);
    expect(init.exitCode).toBe(0);

    // Act
    const result = await runDoctor(env, repo);

    // Assert: the section's five surfaces.
    expect(result.stdout).toContain("PASS  cursor hooks  sessionStart");
    expect(result.stdout).toContain("cursor hook launcher");
    expect(result.stdout).toContain("PASS  cursor mcp tools");
    expect(result.stdout).toContain("cursor version  not yet observed");
    expect(result.stdout).toContain("PASS  cursor contract drift  none");
    // And the drift counter becomes a WARN when the ledger has entries.
    await mkdir(join(home, "state"), { recursive: true });
    await appendFile(
      join(home, "state", "cursor-drift.jsonl"),
      `${JSON.stringify({ at: "2026-08-19T10:00:00.000Z", event: "afterFileEdit", missing: ["file_path"] })}\n`,
      "utf8",
    );
    const warned = await runDoctor(env, repo);
    expect(warned.stdout).toContain("WARN  cursor contract drift");
    expect(warned.stdout).toContain("afterFileEdit.file_path");
  });
});
