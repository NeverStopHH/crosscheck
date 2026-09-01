/**
 * The nested `claude -p` is a MODEL CALL, not a session (trial finding #14):
 * a plain `claude -p` loads the developer's whole settings stack — hooks,
 * plugins, ~10 MCP servers — and took 35–116 s on a trivial slice against a
 * 30 s deadline, ran crosscheck's own hooks from inside the summarizer, and
 * left a transcript per fire. The argv below was measured to 9 s, 0 phantom
 * sessions, 0 transcripts on Claude Code 2.1.237; each flag is pinned once,
 * in the measured order, with `-p <PROMPT>` first. The deadline doubles for
 * the margin a cold Haiku or a slow laptop needs.
 *
 * No import of the flag list itself: this file must run — and go red — on a
 * tree that does not know it.
 */
import { describe, expect, test } from "bun:test";

import {
  SUMMARIZER_MODEL,
  SUMMARIZER_TIMEOUT_MS,
} from "@crosscheck/connector-core/constants.ts";
import {
  SUMMARIZER_PROMPT,
  resolveSummarizerArgv,
  resolveSummarizerTimeoutMs,
} from "@crosscheck/connector-core/model/runner.ts";

const LEAN_FLAGS = [
  "--setting-sources",
  "--strict-mcp-config",
  "--mcp-config",
  "--no-session-persistence",
  "--tools",
  "--max-turns",
] as const;

/** The flag tail exactly as measured (the README documents what each does). */
const MEASURED_TAIL = [
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--no-session-persistence",
  "--tools",
  "",
  "--max-turns",
  "1",
];

const valueAfter = (argv: readonly string[], flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1];

describe("resolveSummarizerArgv (lean nested claude)", () => {
  test("starts with -p <PROMPT> --model haiku and carries each lean flag exactly once", () => {
    const argv = resolveSummarizerArgv({});

    expect(argv.slice(0, 5)).toEqual([
      "claude",
      "-p",
      SUMMARIZER_PROMPT,
      "--model",
      SUMMARIZER_MODEL,
    ]);
    for (const flag of LEAN_FLAGS) {
      expect(argv.filter((arg) => arg === flag)).toHaveLength(1);
    }
    // --bare would be faster still, and it disables keychain/OAuth auth:
    // every `claude /login` developer would read "Not logged in". Rejected.
    expect(argv).not.toContain("--bare");
  });

  test("the flag values are the measured ones: no settings, no MCP servers, no tools, one turn", () => {
    const argv = resolveSummarizerArgv({});

    expect(valueAfter(argv, "--setting-sources")).toBe("");
    expect(JSON.parse(valueAfter(argv, "--mcp-config") ?? "null")).toEqual({ mcpServers: {} });
    expect(valueAfter(argv, "--tools")).toBe("");
    expect(valueAfter(argv, "--max-turns")).toBe("1");
    expect(argv.slice(5)).toEqual(MEASURED_TAIL);
  });

  test("an override replaces the binary wholesale — no flag reaches it", () => {
    expect(resolveSummarizerArgv({ CROSSCHECK_SUMMARIZER_CMD: "/tmp/fake" })).toEqual(["/tmp/fake"]);
    // An EMPTY override is no override: the real argv, flags included.
    expect(resolveSummarizerArgv({ CROSSCHECK_SUMMARIZER_CMD: "" })).toContain("--setting-sources");
  });
});

describe("summarizer deadline", () => {
  test("the default is 60 s — a lean run answers in ~9 s; the old 30 s lost every fire", () => {
    expect(SUMMARIZER_TIMEOUT_MS).toBe(60_000);
    expect(resolveSummarizerTimeoutMs({})).toBe(60_000);
  });

  test("CROSSCHECK_SUMMARIZER_TIMEOUT_MS overrides it; zero and garbage fall back", () => {
    expect(resolveSummarizerTimeoutMs({ CROSSCHECK_SUMMARIZER_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(resolveSummarizerTimeoutMs({ CROSSCHECK_SUMMARIZER_TIMEOUT_MS: "0" })).toBe(60_000);
    expect(resolveSummarizerTimeoutMs({ CROSSCHECK_SUMMARIZER_TIMEOUT_MS: "soon" })).toBe(60_000);
  });
});
