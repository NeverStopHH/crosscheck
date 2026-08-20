/**
 * Non-destructive merge of the team's `.mcp.json`.
 *
 * Same rule as `.claude/settings.json`, for the same reason: the file is shared,
 * foreign servers in it are the norm rather than the exception, and clobbering
 * one is how an install gets reverted (DESIGN.md §2: install = one PR). The
 * shapes differ enough that the two merges cannot be one function —
 * settings.json keys hooks by event and holds ARRAYS of matcher groups from
 * which owned commands are filtered by pattern, while `.mcp.json` is a flat map
 * of server name to definition and this owns exactly one key of it.
 */
import { MCP_SERVER_KEY } from "../constants.ts";

export interface McpServerEntry {
  readonly type: string;
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Matches every launcher form `init` can emit: the `crosscheck` binary on PATH,
 * an absolute path to the entry script, and an operator's `--command-prefix`
 * wrapped in `sh -c`.
 *
 * Deliberately NOT reused from settings-merge.ts's OWNED_COMMAND_PATTERN. That
 * one matches a whole shell command line — `<launcher> hook session-start` — and
 * an MCP entry has the launcher and its arguments in separate fields, so the
 * subcommand never sits adjacent to the binary in any one string. Sharing the
 * pattern would mean joining the fields back into a fake command line, which is
 * a shape neither file ever writes.
 */
const OWNED_LAUNCHER = /(^|[\s"'/])@?crosscheck(?:\/[\w.-]+)*(?:\.[cm]?[jt]s)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

/**
 * Whether an entry is one `init` wrote.
 *
 * Needed by `doctor`, which reports whether the tools are registered at all, and
 * cannot rely on the KEY alone: a developer may have hand-written an entry under
 * `crosscheck` that points somewhere else entirely, and reporting that as a
 * healthy install is exactly the silent-death failure rule 6 exists against.
 */
export const isOwnedMcpEntry = (entry: unknown): boolean => {
  if (!isRecord(entry)) {
    return false;
  }
  const command = entry["command"];
  const args = entry["args"];
  if (typeof command !== "string" || !Array.isArray(args)) {
    return false;
  }
  const strings = args.filter(
    (arg): arg is string => typeof arg === "string",
  );
  if (!strings.includes("mcp") && !strings.some((arg) => arg.includes(" mcp"))) {
    return false;
  }
  // Either the launcher itself is ours, or one of its arguments names our entry
  // point — the second covers `bun /abs/path/crosscheck.ts mcp` and `sh -c`.
  return (
    OWNED_LAUNCHER.test(command) ||
    strings.some((arg) => OWNED_LAUNCHER.test(arg.split(" ")[0] ?? "")) ||
    strings.some((arg) => /crosscheck/.test(arg))
  );
};

/** Pure: takes the parsed config, returns a new object. Never mutates. */
export const mergeMcpConfig = (
  existing: Record<string, unknown>,
  entry: McpServerEntry,
): Record<string, unknown> => ({
  ...existing,
  mcpServers: {
    ...asRecord(existing["mcpServers"]),
    [MCP_SERVER_KEY]: entry,
  },
});

export interface McpRemovalResult {
  readonly config: Record<string, unknown>;
  /** False = no crosscheck-owned entry found; the input passes through. */
  readonly changed: boolean;
}

/**
 * The inverse of `mergeMcpConfig`, for `init --global --remove` (finding
 * #11) — and it matters most on `~/.claude.json`, which is Claude Code's
 * OWN state file: everything foreign must ride through byte-identically,
 * order preserved. Only an entry `isOwnedMcpEntry` recognises is removed —
 * a hand-written server that happens to sit under our key is somebody's
 * deliberate configuration, not ours to delete. The `mcpServers` record is
 * dropped only when the removal emptied it (install created it); one that
 * was already empty, or still holds foreign servers, stays.
 */
export const removeMcpConfig = (
  existing: Record<string, unknown>,
): McpRemovalResult => {
  const servers = existing["mcpServers"];
  if (!isRecord(servers) || !isOwnedMcpEntry(servers[MCP_SERVER_KEY])) {
    return { config: existing, changed: false };
  }
  const kept = Object.entries(servers).reduce<Record<string, unknown>>(
    (rest, [name, entry]) =>
      name === MCP_SERVER_KEY ? rest : { ...rest, [name]: entry },
    {},
  );
  const config = Object.entries(existing).reduce<Record<string, unknown>>(
    (rest, [key, value]) => {
      if (key !== "mcpServers") {
        return { ...rest, [key]: value };
      }
      return Object.keys(kept).length === 0 ? rest : { ...rest, [key]: kept };
    },
    {},
  );
  return { config, changed: true };
};
