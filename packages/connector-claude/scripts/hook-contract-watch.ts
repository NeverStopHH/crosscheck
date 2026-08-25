/**
 * Watches the hook contract we do NOT own.
 *
 * Every capture path in this connector depends on Claude Code's hook contract:
 * which events fire, which fields arrive on stdin, and how `additionalContext`
 * is returned. Our hooks are deliberately fail-open — any error exits 0 in
 * silence so a developer's session is never broken (DESIGN.md §3). That is
 * correct, and it is exactly why a contract change is INVISIBLE: the hooks keep
 * exiting 0, briefings simply stop arriving, and nothing reports it.
 *
 * So this compares a normalized view of the public hooks reference against a
 * snapshot committed next to it, and fails loudly on any difference.
 *
 * NARROW BY DESIGN, AND FORMATTING-SENSITIVE. It looks only for the FIELD NAMES
 * this connector actually reads, inside the section that documents them,
 * matching `field` or "field". It reads no PROSE, so a reworded description
 * cannot move it.
 *
 * It is NOT formatting-insensitive, and an earlier version of this comment
 * claimed it was — "a docs rewrite that keeps the contract cannot cry wolf" is
 * false. Two rewrites that leave the contract entirely intact still report
 * drift, and both are pinned as known limits in test/hook-contract.test.ts:
 *
 *   bun test packages/connector-claude/test/hook-contract.test.ts
 *
 *   field names published in bold rather than in backticks   4 observations flip
 *   every heading promoted one level (`###` → `####`)       20 observations flip
 *
 * That direction is a false alarm, not a missed change, so it fails safe: the
 * job goes red, somebody reads the reference and re-records with --write. The
 * direction it CANNOT see is the dangerous one — a field whose MEANING changed
 * while its name stayed — and that is what the fixture tests and a human
 * reviewer are for.
 *
 * THREE OUTCOMES, KEPT DISTINCT. In sync (0). Drift (1). Could not read the
 * source at all (2) — because a watcher that goes quiet when it cannot see is
 * the precise failure it exists to prevent.
 *
 *   bun run packages/connector-claude/scripts/hook-contract-watch.ts
 *   ... --hooks-file <path> --statusline-file <path>   # offline, for tests
 *   ... --write                                        # accept drift as a diff
 */
import { resolve } from "node:path";

export const HOOKS_DOC_URL = "https://code.claude.com/docs/en/hooks.md";
export const STATUSLINE_DOC_URL = "https://code.claude.com/docs/en/statusline.md";

export const SNAPSHOT_PATH = resolve(
  import.meta.dir,
  "..",
  "test",
  "fixtures",
  "hook-contract",
  "docs-snapshot.json",
);

const FETCH_TIMEOUT_MS = 20_000;
/** A doc this short is a redirect stub or an error page, never the reference. */
const MIN_DOC_BYTES = 2000;

export const EXIT_IN_SYNC = 0;
export const EXIT_DRIFT = 1;
export const EXIT_UNREADABLE = 2;

export interface ContractDocs {
  readonly hooks: string;
  readonly statusline: string;
}

/** Observation key → "is it still documented". Diffable, and order-free. */
export type ContractView = Readonly<Record<string, boolean>>;

interface FieldProbe {
  readonly key: string;
  readonly section: string;
  readonly field: string;
}

/**
 * The registered events (cli/init.ts) whose documented sections carry fields
 * we read or write. UserPromptSubmit and Stop are registered too but consume
 * only the common input fields probed below, so they need no section probe.
 */
const EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "SessionEnd"] as const;

/**
 * Exactly what we read off stdin (capture/tool-events.ts HookPayloadSchema) and
 * what we write back (hooks/session-start.ts, hooks/pre-tool-use.ts). Nothing
 * aspirational: the PreToolUse probes are the three output fields the tripwire
 * emits — the decision, its reason, and `additionalContext` (trial finding
 * #25), which the reference documents for PreToolUse as "added to Claude's
 * context alongside the tool result".
 */
const HOOK_PROBES: readonly FieldProbe[] = [
  {
    key: "common.input.session_id",
    section: "Common input fields",
    field: "session_id",
  },
  { key: "common.input.cwd", section: "Common input fields", field: "cwd" },
  {
    key: "common.input.hook_event_name",
    section: "Common input fields",
    field: "hook_event_name",
  },
  { key: "SessionStart.input.source", section: "SessionStart", field: "source" },
  {
    key: "SessionStart.input.session_title",
    section: "SessionStart",
    field: "session_title",
  },
  {
    key: "SessionStart.output.hookSpecificOutput",
    section: "SessionStart",
    field: "hookSpecificOutput",
  },
  {
    key: "SessionStart.output.hookEventName",
    section: "SessionStart",
    field: "hookEventName",
  },
  {
    key: "SessionStart.output.additionalContext",
    section: "SessionStart",
    field: "additionalContext",
  },
  {
    key: "PreToolUse.output.permissionDecision",
    section: "PreToolUse",
    field: "permissionDecision",
  },
  {
    key: "PreToolUse.output.permissionDecisionReason",
    section: "PreToolUse",
    field: "permissionDecisionReason",
  },
  {
    key: "PreToolUse.output.additionalContext",
    section: "PreToolUse",
    field: "additionalContext",
  },
  {
    key: "PostToolUse.input.tool_name",
    section: "PostToolUse",
    field: "tool_name",
  },
  {
    key: "PostToolUse.input.tool_input",
    section: "PostToolUse",
    field: "tool_input",
  },
  {
    key: "PostToolUse.input.tool_response",
    section: "PostToolUse",
    field: "tool_response",
  },
  {
    key: "PostToolUse.input.file_path",
    section: "PostToolUse",
    field: "file_path",
  },
  { key: "SessionEnd.input.reason", section: "SessionEnd", field: "reason" },
];

/** The statusline doc is small, so the whole page is the search space. */
const STATUSLINE_FIELDS = ["session_id", "cwd"] as const;

const escapeForRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The body of one `###` section: from its heading to the next heading of the
 * same or a higher level, so `#### SessionStart input` stays inside
 * `### SessionStart` where its fields are documented.
 */
export const sectionBody = (markdown: string, heading: string): string => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start === -1) {
    return "";
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3} /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

/** `field` or "field" — how a field name appears in a table or a JSON example. */
const mentionsField = (body: string, field: string): boolean =>
  new RegExp(`[\`"]${escapeForRegExp(field)}[\`"]`).test(body);

export const extractContract = (docs: ContractDocs): ContractView => {
  const events = Object.fromEntries(
    EVENTS.map((event) => [
      `event.${event}`,
      sectionBody(docs.hooks, event).length > 0,
    ]),
  );
  const fields = Object.fromEntries(
    HOOK_PROBES.map((probe) => [
      probe.key,
      mentionsField(sectionBody(docs.hooks, probe.section), probe.field),
    ]),
  );
  const statusline = Object.fromEntries(
    STATUSLINE_FIELDS.map((field) => [
      `statusline.input.${field}`,
      mentionsField(docs.statusline, field),
    ]),
  );
  return { ...events, ...fields, ...statusline };
};

export const diffContract = (
  expected: ContractView,
  actual: ContractView,
): readonly string[] => {
  const keys = [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ].sort();
  return keys.flatMap((key) => {
    const before = expected[key];
    const after = actual[key];
    if (before === after) {
      return [];
    }
    return [`${key}: snapshot ${String(before)} → docs ${String(after)}`];
  });
};

class UnreadableSourceError extends Error {}

const readDoc = async (url: string, file: string | undefined): Promise<string> => {
  if (file !== undefined) {
    const local = Bun.file(file);
    if (!(await local.exists())) {
      throw new UnreadableSourceError(`no such file: ${file}`);
    }
    return local.text();
  }
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (cause) {
    throw new UnreadableSourceError(`${url}: ${String(cause)}`);
  }
  if (!response.ok) {
    throw new UnreadableSourceError(`${url}: HTTP ${String(response.status)}`);
  }
  const body = await response.text();
  if (body.length < MIN_DOC_BYTES) {
    throw new UnreadableSourceError(
      `${url}: ${String(body.length)} bytes, expected at least ${String(MIN_DOC_BYTES)}`,
    );
  }
  return body;
};

const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const readSnapshot = async (path: string): Promise<ContractView> => {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new UnreadableSourceError(`no snapshot at ${path}`);
  }
  return (await file.json()) as ContractView;
};

/** Where the report goes. A test passes its own sink instead of stdout. */
export type Reporter = (line: string) => void;

const toStdout: Reporter = (line) => {
  process.stdout.write(`${line}\n`);
};

const readDocs = async (args: readonly string[]): Promise<ContractDocs> => ({
  hooks: await readDoc(HOOKS_DOC_URL, flagValue(args, "--hooks-file")),
  statusline: await readDoc(
    STATUSLINE_DOC_URL,
    flagValue(args, "--statusline-file"),
  ),
});

/** Distinct from drift on purpose: nothing was compared, so nothing is known. */
const reportUnreadable = (cause: unknown, report: Reporter): number => {
  report("::error::hook contract SOURCE UNREADABLE — the contract was NOT checked");
  report(String(cause instanceof Error ? cause.message : cause));
  return EXIT_UNREADABLE;
};

const reportDrift = (
  differences: readonly string[],
  report: Reporter,
): number => {
  report(
    "::error::hook contract DRIFT — Claude Code's documented hook contract changed",
  );
  for (const line of differences) {
    report(`  ${line}`);
  }
  report("Review the reference, then re-record with --write and commit the diff:");
  report(`  ${HOOKS_DOC_URL}`);
  report(`  ${STATUSLINE_DOC_URL}`);
  return EXIT_DRIFT;
};

export const main = async (
  args: readonly string[],
  report: Reporter = toStdout,
): Promise<number> => {
  const snapshotPath = flagValue(args, "--snapshot") ?? SNAPSHOT_PATH;
  let actual: ContractView;
  try {
    actual = extractContract(await readDocs(args));
  } catch (cause) {
    return reportUnreadable(cause, report);
  }

  // Before the snapshot is read, so the first recording can bootstrap one.
  if (args.includes("--write")) {
    await Bun.write(snapshotPath, `${JSON.stringify(actual, null, 2)}\n`);
    report(`snapshot written: ${snapshotPath}`);
    return EXIT_IN_SYNC;
  }

  let snapshot: ContractView;
  try {
    snapshot = await readSnapshot(snapshotPath);
  } catch (cause) {
    return reportUnreadable(cause, report);
  }

  const differences = diffContract(snapshot, actual);
  if (differences.length === 0) {
    report(`hook contract in sync (${String(Object.keys(actual).length)} observations)`);
    return EXIT_IN_SYNC;
  }
  return reportDrift(differences, report);
};

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}