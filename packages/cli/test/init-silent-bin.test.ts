/**
 * INIT NEVER FALLS BACK SILENTLY (core config/launcher.ts `silentBareNote`).
 *
 * A `crosscheck` on PATH that does not answer `--version` within init's
 * budget (10 s, asked twice) is not wired by its bare name. init writes the
 * absolute launcher instead and says so in one line, naming both. This runs
 * init's real budget against a bin that never answers, so it takes about
 * 20 s on purpose.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INIT_IDENTITY_PROBE } from "@crosscheck/connector-core/config/launcher.ts";
import { runCli } from "../src/cli/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const SLACK_MS = 15_000;
const FALLBACK_MARKER = "didn't answer in time; wired the absolute launcher ";

const paths: string[] = [];
let fakeDir = "";

beforeAll(async () => {
  fakeDir = await mkdtemp(join(tmpdir(), "cx-silent-crosscheck-"));
  paths.push(fakeDir);
  await mkdir(fakeDir, { recursive: true });
  await writeFile(join(fakeDir, "crosscheck"), `#!/bin/sh\necho run >> "${join(fakeDir, "runs")}"\nexec sleep 60\n`, "utf8");
  await chmod(join(fakeDir, "crosscheck"), 0o755);
});

afterAll(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe("init with a crosscheck on PATH that never answers", () => {
  test(
    "wires the absolute launcher and says so in one line, naming the silent bin and what it wired",
    async () => {
      // Arrange
      const repo = await makeRepo("init-silent-bin", { remote: "git@github.com:acme/api.git" });
      const home = await makeHome("init-silent-bin");
      paths.push(repo, home);
      const env = {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: "http://127.0.0.1:9",
        CROSSCHECK_API_KEY: "test-key",
        PATH: [fakeDir, "/usr/bin", "/bin"].join(":"),
      };

      // Act
      const startedAt = performance.now();
      const result = await runCli(["init"], env, repo);
      const waitedMs = performance.now() - startedAt;
      const runs = (await readFile(join(fakeDir, "runs"), "utf8")).split("\n").filter((line) => line.length > 0).length;
      const settings = JSON.parse(await readFile(join(repo, ".claude", "settings.json"), "utf8")) as {
        hooks: Record<string, readonly { hooks: readonly { command: string }[] }[]>;
      };
      const sessionStart = settings.hooks["SessionStart"]?.at(-1)?.hooks[0]?.command ?? "";

      // Assert — init's own budget was spent (asked twice, waited both
      // deadlines out), then one line, and the hooks run exactly what it names
      expect(runs).toBe(INIT_IDENTITY_PROBE.attempts);
      expect(waitedMs).toBeGreaterThanOrEqual(INIT_IDENTITY_PROBE.timeoutMs * INIT_IDENTITY_PROBE.attempts);
      expect(result.exitCode).toBe(0);
      const notes = result.stdout.split("\n").filter((line) => line.includes(FALLBACK_MARKER));
      expect(notes).toHaveLength(1);
      const note = notes[0] ?? "";
      expect(note.startsWith(`crosscheck on PATH (${join(fakeDir, "crosscheck")}) didn't answer in time`)).toBe(true);
      expect(note.endsWith(" instead; rerun init to switch")).toBe(true);
      const wired = note.slice(note.indexOf(FALLBACK_MARKER) + FALLBACK_MARKER.length, note.indexOf(" instead; rerun init"));
      expect(sessionStart).toBe(`${wired} hook session-start`);
      expect(wired).not.toBe("crosscheck");
    },
    INIT_IDENTITY_PROBE.timeoutMs * INIT_IDENTITY_PROBE.attempts + SLACK_MS,
  );
});
