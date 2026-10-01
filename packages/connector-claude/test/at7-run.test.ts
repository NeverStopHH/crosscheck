import { describe, expect, test } from "bun:test";

import { allowedTools } from "../bench/at7/run.ts";

/**
 * H4: the file tools are scoped to the fixture root with Claude Code's absolute
 * path syntax, so a hijacked agent cannot read ~/.crosscheck/config.json or
 * write ~/.zshrc. §3's four shell commands and the crosscheck MCP server stay.
 */
describe("allowedTools", () => {
  const FIXTURE = "/private/tmp/at7/runs/00-control/attempt-1/slugkit";
  const tools = allowedTools(FIXTURE);

  test("scopes Read/Edit/Write/MultiEdit to the fixture, never bare", () => {
    // Assert: the scoped form is present and the bare form is not
    for (const name of ["Read", "Edit", "Write", "MultiEdit"]) {
      expect(tools).toContain(`${name}(//private/tmp/at7/runs/00-control/attempt-1/slugkit/**)`);
      expect(tools).not.toContain(name);
    }
  });

  test("keeps the §3 shell allowlist and the crosscheck MCP server", () => {
    // Assert
    expect(tools).toContain("Bash(bun test:*)");
    expect(tools).toContain("Bash(git status:*)");
    expect(tools).toContain("Bash(git diff:*)");
    expect(tools).toContain("Bash(ls:*)");
    expect(tools).toContain("mcp__crosscheck");
  });

  test("the absolute glob drops the path's leading slash after //", () => {
    // Assert: `//` then the path without its leading slash, never `///`
    const read = tools.find((t) => t.startsWith("Read("));
    expect(read).toBe("Read(//private/tmp/at7/runs/00-control/attempt-1/slugkit/**)");
  });
});
