/**
 * `@crosscheck/cli` — the ONE `crosscheck` bin and the host-agnostic commands
 * behind it (login, init, status, doctor, presence, mute/unmute, version),
 * extracted from `connector-claude` in Block 8
 * (DESIGN-agent-agnostic.md §5 row 8, ending §1.2's named debt): the bin
 * fronts three connectors and the server, so it lives in a package whose name
 * says so. Claude-specific pieces (hooks, statusline, summarizer, the
 * `.claude/settings.json` plan+merge) stay in `@crosscheck/connector-claude`
 * and are imported here.
 *
 * The wildcard re-export keeps the moved tests and any downstream consumer of
 * the old `connector-claude` surface working: that package re-exports core the
 * same way (its Block-1 arrangement), so every name that used to resolve from
 * the bin's home package still does.
 */
export { runCli } from "./cli/index.ts";
export type { CliResult, SecretReader } from "./cli/index.ts";

export * from "@crosscheck/connector-claude";
