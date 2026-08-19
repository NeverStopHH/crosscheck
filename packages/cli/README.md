# @crosscheck/cli

The ONE `crosscheck` bin (design: `docs/adapters/DESIGN-agent-agnostic.md`
§5 row 8 — the Block-8 extraction that ended §1.2's named debt), fronting
three connectors and the server:

```
crosscheck serve                      the hub (dynamic import: @crosscheck/server)
crosscheck init [--cursor]            repo install: .claude/* and, with --cursor, .cursor/*
crosscheck login|status|doctor        host-agnostic commands (this package)
crosscheck presence|mute|unmute       §2.1 privacy controls (this package)
crosscheck hook <name>                Claude Code hooks   (@crosscheck/connector-claude)
crosscheck statusline                 Claude Code surface (@crosscheck/connector-claude)
crosscheck mcp                        the stdio MCP server (@crosscheck/connector-core)
crosscheck acp [-- …]                 the ACP proxy       (@crosscheck/connector-acp, dynamic)
crosscheck acp-report <file>          per-agent capture-quality report
crosscheck cursor-hook <event>        Cursor IDE hooks    (@crosscheck/connector-cursor, dynamic)
```

Division of labor: this package owns the bin dispatch and the host-agnostic
commands; everything host-specific stays in its connector (`connector-claude`
keeps hooks/statusline/summarizer and the `.claude` settings plan+merge that
`init` imports). Dynamic imports keep the hook/statusline paths from paying
for the server, proxy, or Cursor code they never use.

Per-editor install snippets and the post-merge dogfood checklists:
[`docs/adapters/INSTALL.md`](../../docs/adapters/INSTALL.md).

Publishing: `scripts/pack-npm.ts` assembles the single `crosscheck-hub` npm
package from all seven workspace packages (`docs/PUBLISHING.md`), and
`test/e2e/npm-package.e2e.test.ts` proves the packed artifact end to end.
The cross-connector §4.5 E2E — three real connector subprocesses of this bin
against one real hub — lives in `test/e2e/cross-connector.e2e.test.ts`.
