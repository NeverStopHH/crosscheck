/**
 * `crosscheck trace` — the command formerly called `suspect` (Nick,
 * 2026-09-30: "Rename suspect to trace", with an alias and a deprecation
 * notice, and no "suspect" wording a person reads).
 *
 * The answer names SESSIONS that touched a surface; "suspect" read as an
 * accusation of a person, which is exactly what the command refuses to make.
 * The 0.10 name keeps working so scripts and habits do not break, and says
 * the new one. Wire paths and stored values keep the old name: renaming
 * `/api/suspect` or the `suspect` delivery channel would break every 0.10
 * client and every stored row for a word nobody reads.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";

import { TRACE_RENAME_NOTICE, runCli } from "../src/cli/index.ts";

const PACKAGES = resolve(import.meta.dir, "..", "..");

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "cx-trace-"));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const run = (argv: readonly string[]) =>
  runCli([...argv], { HOME: home, CROSSCHECK_HOME: home }, home);

describe("crosscheck trace", () => {
  test("without a surface it prints its own usage under its new name", async () => {
    // Act
    const result = await run(["trace"]);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout.startsWith("usage: crosscheck trace <pin-id>")).toBe(true);
  });

  test("--help is answered like every other subcommand's", async () => {
    // Act
    const result = await run(["trace", "--help"]);

    // Assert
    expect(result.stdout).toContain("usage: crosscheck trace <pin-id>");
  });

  test("the help lists trace, and no longer suspect", async () => {
    // Act
    const result = await run(["help"]);

    // Assert
    expect(result.stdout).toContain("  trace <pin-id|path…>");
    expect(result.stdout).not.toContain("  suspect <");
  });
});

describe("the 0.10 name", () => {
  test("still runs, and says the new name first", async () => {
    // Act
    const result = await run(["suspect"]);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout.startsWith(TRACE_RENAME_NOTICE)).toBe(true);
    expect(result.stdout).toContain("usage: crosscheck trace <pin-id>");
  });
});

describe("no printed sentence says suspect any more", () => {
  /** Lines a person never reads: comments and the alias notice itself. */
  const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

  test("no source file prints 'crosscheck suspect' or calls a session a suspect", async () => {
    // Arrange
    const glob = new Bun.Glob("*/src/**/*.{ts,tsx}");
    const offenders: string[] = [];

    // Act
    for await (const path of glob.scan({ cwd: PACKAGES })) {
      const text = await readFile(join(PACKAGES, path), "utf8");
      text.split("\n").forEach((line, index) => {
        // The alias notice is the one sentence that must say the old name.
        if (isComment(line) || line.includes("is now `crosscheck trace`")) {
          return;
        }
        if (/crosscheck suspect|SEPARATED SUSPECT|`suspect` answers|\bsuspect (?:names|prints|is|intersects)\b/.test(line)) {
          offenders.push(`${path}:${String(index + 1)}: ${line.trim()}`);
        }
      });
    }

    // Assert
    expect(offenders).toEqual([]);
  });
});
