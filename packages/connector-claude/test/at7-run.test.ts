import { describe, expect, test } from "bun:test";

import { allowedTools, claudeArgs, MESSAGING_TOOLS, RUN_SETTINGS } from "../bench/at7/run.ts";

/**
 * H4: the file tools are scoped to the fixture root with Claude Code's absolute
 * path syntax. That is an ALLOW scope and does not by itself stop a read
 * outside the fixture: Claude Code runs its read-only Bash built-ins (`cat`,
 * `grep`, `find`, …) without a prompt in every mode. The read block is
 * `permissions.blockReadsOutsideWorkingDirectories` (A2.2, tested below).
 * The shell allowlist is `bun test`, `git status` and `ls` (A2.2 drops
 * `git diff`, whose `--output=<path>` writes anywhere), plus the crosscheck
 * MCP server.
 */
describe("allowedTools", () => {
  const FIXTURE = "/private/var/folders/x/T/0a1b2c3d4e5f/slugkit";
  const tools = allowedTools(FIXTURE);

  test("scopes Read/Edit/Write/MultiEdit to the fixture, never bare", () => {
    // Assert: the scoped form is present and the bare form is not
    for (const name of ["Read", "Edit", "Write", "MultiEdit"]) {
      expect(tools).toContain(`${name}(//private/var/folders/x/T/0a1b2c3d4e5f/slugkit/**)`);
      expect(tools).not.toContain(name);
    }
  });

  test("allows exactly bun test, git status and ls, plus the crosscheck MCP server", () => {
    // Act
    const shell = tools.filter((t) => t.startsWith("Bash("));

    // Assert
    expect(shell).toEqual(["Bash(bun test:*)", "Bash(git status:*)", "Bash(ls:*)"]);
    expect(tools).toContain("mcp__crosscheck");
  });

  test("never allows git diff, whose --output writes anywhere (A2.2)", () => {
    // Assert
    expect(tools.some((t) => t.includes("git diff"))).toBe(false);
  });

  test("the absolute glob drops the path's leading slash after //", () => {
    // Assert: `//` then the path without its leading slash, never `///`
    const read = tools.find((t) => t.startsWith("Read("));
    expect(read).toBe("Read(//private/var/folders/x/T/0a1b2c3d4e5f/slugkit/**)");
  });
});

/** The values a flag carries in an argv: everything up to the next `--flag`. */
const flagValues = (argv: readonly string[], flag: string): readonly string[] => {
  const start = argv.indexOf(flag);
  if (start === -1) {
    return [];
  }
  const rest = argv.slice(start + 1);
  const end = rest.findIndex((arg) => arg.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
};

/** The inline JSON the run passes with `--settings`, parsed. */
const runSettings = (argv: readonly string[]): Record<string, unknown> =>
  JSON.parse(flagValues(argv, "--settings")[0] ?? "{}") as Record<string, unknown>;

/**
 * A2.1: Claude Code 2.1.224+ runs cross-session messaging by default; a `-p`
 * session gets an inbox and can list and message the operator's own sessions
 * without a prompt. Every run disallows both messaging tools and refuses
 * inbound messages (code.claude.com/docs/en/cross-session-messaging).
 */
describe("claudeArgs — no other Claude Code session is reachable (A2.1)", () => {
  const argv = claudeArgs("/r/slugkit/.mcp.json", "/r/slugkit");

  test("disallows SendMessage and ListAgents by bare name", () => {
    // Act
    const disallowed = flagValues(argv, "--disallowed-tools");

    // Assert
    expect(MESSAGING_TOOLS).toEqual(["SendMessage", "ListAgents"]);
    expect(disallowed).toContain("SendMessage");
    expect(disallowed).toContain("ListAgents");
  });

  test("refuses inbound cross-session messages through --settings", () => {
    // Act
    const settings = runSettings(argv);

    // Assert
    expect(settings["crossSessionInbound"]).toBe("refuse");
    expect(RUN_SETTINGS.crossSessionInbound).toBe("refuse");
  });

  test("the messaging tools are not also allowed", () => {
    // Act
    const allowed = flagValues(argv, "--allowed-tools");

    // Assert
    for (const tool of MESSAGING_TOOLS) {
      expect(allowed).not.toContain(tool);
    }
  });

  test("blocks reads outside the working directory for every tool (A2.2)", () => {
    // Act
    const permissions = runSettings(argv)["permissions"] as Record<string, unknown> | undefined;

    // Assert
    expect(permissions?.["blockReadsOutsideWorkingDirectories"]).toBe(true);
  });

  test("adds no working directory beyond the fixture", () => {
    // Assert: an --add-dir would widen what the read block fences in
    expect(argv).not.toContain("--add-dir");
  });

  test("keeps the §3 task prompt positional right after -p", () => {
    // Assert: a variadic flag before the prompt would swallow it
    expect(argv.indexOf("-p")).toBe(1);
    expect(argv[2]).toContain("test/slug.test.ts");
  });
});
