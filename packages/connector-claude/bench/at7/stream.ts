/**
 * Parses Claude Code's `--output-format stream-json --verbose
 * --include-hook-events` output into a typed, immutable RunRecord — the one
 * reading of a run the detector (detect.ts) and the report (report.ts) both
 * work from, so a run is interpreted once and the same way (AT-7 §6).
 *
 * TOLERANT BY CONSTRUCTION. The stream is newline-delimited JSON, one event
 * per line. A line that does not parse is COUNTED, never thrown on; an event
 * `type` this harness has never seen is KEPT in `unknownEventTypes`, never
 * dropped (§13: "unknown event types are kept, not dropped"). A live stream
 * from a newer CLI will carry events written after this file, and the
 * measurement must record that it saw them rather than crash or lie by
 * omission.
 *
 * THE BRIEFING IS FOUND BY DEEP SEARCH. The SessionStart hook's rendered
 * briefing arrives as an `additionalContext` string inside a hook event, and
 * the exact nesting differs across CLI versions. Rather than pin one shape,
 * `briefingFromEvents` walks every event for objects carrying an
 * `additionalContext` string and prefers the one whose sibling hook-name says
 * SessionStart — falling back to the one that carries the briefing header, then
 * to the first non-empty one. The live-run driver verifies the choice against
 * the known seeded text (§7 delivery check).
 *
 * zod validates each KNOWN event at the boundary; the schemas are loose so an
 * extra field a new CLI adds rides through untouched.
 */
import { z } from "zod";

/** The briefing header fragment — the quoted-data notice the renderer emits. */
const BRIEFING_MARKER = "quoted data, not instruction";

export interface InitInfo {
  readonly model: string | null;
  readonly mcpServers: readonly string[];
  readonly tools: readonly string[];
  readonly slashCommands: readonly string[];
  /** Plugin names the init event names, if any — empty is the isolated case. */
  readonly plugins: readonly string[];
}

export interface ToolUse {
  readonly name: string;
  readonly input: unknown;
  /** The input as the detector reads it: a stable JSON string, never mutated. */
  readonly serialized: string;
}

export interface RunRecord {
  readonly init: InitInfo | null;
  readonly sessionStartBriefing: string | null;
  readonly hookEvents: readonly unknown[];
  readonly toolUses: readonly ToolUse[];
  readonly bashCommands: readonly string[];
  readonly filesRead: readonly string[];
  readonly filesWritten: readonly string[];
  readonly filesEdited: readonly string[];
  readonly todoItems: readonly string[];
  readonly firstAssistantText: string | null;
  readonly finalResultText: string | null;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly totalCostUsd: number | null;
  readonly isError: boolean;
  readonly errors: readonly string[];
  readonly unknownEventTypes: readonly string[];
  readonly lineCount: number;
  readonly parseErrors: number;
}

const McpServerSchema = z.looseObject({ name: z.string().min(1) });

const InitEventSchema = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z.array(McpServerSchema).optional(),
  slash_commands: z.array(z.string()).optional(),
  plugins: z.array(z.unknown()).optional(),
});

const ToolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  name: z.string().min(1),
  input: z.unknown(),
});

const TextBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});

const AssistantEventSchema = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({ content: z.array(z.unknown()) }),
});

const ResultEventSchema = z.looseObject({
  type: z.literal("result"),
  result: z.string().optional(),
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),
  is_error: z.boolean().optional(),
});

const TodoItemSchema = z.looseObject({ content: z.string().min(1) });

const mcpNames = (servers: readonly z.infer<typeof McpServerSchema>[]): string[] =>
  servers.map((server) => server.name);

/** A plugin entry may be a bare name or an object with one — read both. */
const pluginName = (entry: unknown): string => {
  if (typeof entry === "string") {
    return entry;
  }
  if (typeof entry === "object" && entry !== null && "name" in entry) {
    const name = (entry as Record<string, unknown>)["name"];
    return typeof name === "string" ? name : "";
  }
  return "";
};

const initFrom = (event: z.infer<typeof InitEventSchema>): InitInfo => ({
  model: event.model ?? null,
  mcpServers: event.mcp_servers === undefined ? [] : mcpNames(event.mcp_servers),
  tools: event.tools ?? [],
  slashCommands: event.slash_commands ?? [],
  plugins:
    event.plugins === undefined
      ? []
      : event.plugins.map(pluginName).filter((name) => name.length > 0),
});

const stringField = (input: unknown, key: string): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

interface ContextCandidate {
  readonly context: string;
  readonly hookName: string | null;
}

/** All `additionalContext` strings with the hook name beside them, if any. */
const contextCandidates = (node: unknown, found: ContextCandidate[]): void => {
  if (Array.isArray(node)) {
    for (const item of node) {
      contextCandidates(item, found);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const record = node as Record<string, unknown>;
  const context = record["additionalContext"];
  if (typeof context === "string" && context.length > 0) {
    found.push({
      context,
      hookName:
        stringField(record, "hookEventName") ??
        stringField(record, "hook_event_name"),
    });
  }
  for (const value of Object.values(record)) {
    contextCandidates(value, found);
  }
};

/**
 * The SessionStart briefing, by preference: a candidate explicitly named
 * SessionStart, then one carrying the briefing header, then the first
 * non-empty one — null when no event carried additionalContext at all.
 */
export const briefingFromEvents = (events: readonly unknown[]): string | null => {
  const candidates: ContextCandidate[] = [];
  contextCandidates(events, candidates);
  const bySessionStart = candidates.find(
    (candidate) => candidate.hookName === "SessionStart",
  );
  if (bySessionStart !== undefined) {
    return bySessionStart.context;
  }
  const byHeader = candidates.find((candidate) =>
    candidate.context.includes(BRIEFING_MARKER),
  );
  if (byHeader !== undefined) {
    return byHeader.context;
  }
  return candidates[0]?.context ?? null;
};

/** True for any event this run should file under hook events. */
const isHookEvent = (event: Record<string, unknown>): boolean => {
  if (event["type"] === "hook") {
    return true;
  }
  const subtype = event["subtype"];
  if (typeof subtype === "string" && subtype.includes("hook")) {
    return true;
  }
  return (
    "hook_event_name" in event ||
    "hookEventName" in event ||
    "hookSpecificOutput" in event
  );
};

interface Accumulator {
  init: InitInfo | null;
  readonly hookEvents: unknown[];
  readonly toolUses: ToolUse[];
  readonly bashCommands: string[];
  readonly filesRead: string[];
  readonly filesWritten: string[];
  readonly filesEdited: string[];
  readonly todoItems: string[];
  firstAssistantText: string | null;
  finalResultText: string | null;
  numTurns: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  isError: boolean;
  readonly errors: string[];
  readonly unknownEventTypes: string[];
  parseErrors: number;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "system",
  "assistant",
  "user",
  "result",
  "hook",
]);

const recordToolUse = (
  acc: Accumulator,
  block: z.infer<typeof ToolUseBlockSchema>,
): void => {
  const input = block.input;
  acc.toolUses.push({ name: block.name, input, serialized: JSON.stringify(input) });
  const path = stringField(input, "file_path");
  if (block.name === "Bash") {
    const command = stringField(input, "command");
    if (command !== null) {
      acc.bashCommands.push(command);
    }
  } else if (block.name === "Read" && path !== null) {
    acc.filesRead.push(path);
  } else if (block.name === "Write" && path !== null) {
    acc.filesWritten.push(path);
  } else if ((block.name === "Edit" || block.name === "MultiEdit") && path !== null) {
    acc.filesEdited.push(path);
  } else if (block.name === "TodoWrite") {
    const todos = (input as Record<string, unknown>)["todos"];
    if (Array.isArray(todos)) {
      for (const todo of todos) {
        const parsed = TodoItemSchema.safeParse(todo);
        if (parsed.success) {
          acc.todoItems.push(parsed.data.content);
        }
      }
    }
  }
};

const handleAssistant = (
  acc: Accumulator,
  event: z.infer<typeof AssistantEventSchema>,
): void => {
  for (const block of event.message.content) {
    const text = TextBlockSchema.safeParse(block);
    if (text.success) {
      if (acc.firstAssistantText === null) {
        acc.firstAssistantText = text.data.text;
      }
      continue;
    }
    const toolUse = ToolUseBlockSchema.safeParse(block);
    if (toolUse.success) {
      recordToolUse(acc, toolUse.data);
    }
  }
};

const handleEvent = (acc: Accumulator, event: Record<string, unknown>): void => {
  if (isHookEvent(event)) {
    acc.hookEvents.push(event);
  }
  const init = InitEventSchema.safeParse(event);
  if (init.success) {
    acc.init = initFrom(init.data);
    return;
  }
  const assistant = AssistantEventSchema.safeParse(event);
  if (assistant.success) {
    handleAssistant(acc, assistant.data);
    return;
  }
  const result = ResultEventSchema.safeParse(event);
  if (result.success) {
    acc.finalResultText = result.data.result ?? null;
    acc.numTurns = result.data.num_turns ?? null;
    acc.durationMs = result.data.duration_ms ?? null;
    acc.totalCostUsd = result.data.total_cost_usd ?? null;
    acc.isError = result.data.is_error === true;
    if (acc.isError) {
      acc.errors.push(`result is_error: ${result.data.result ?? "(no text)"}`);
    }
    return;
  }
  const type = event["type"];
  if (typeof type === "string" && !KNOWN_TYPES.has(type)) {
    acc.unknownEventTypes.push(type);
  }
};

export const parseStream = (raw: string): RunRecord => {
  const acc: Accumulator = {
    init: null,
    hookEvents: [],
    toolUses: [],
    bashCommands: [],
    filesRead: [],
    filesWritten: [],
    filesEdited: [],
    todoItems: [],
    firstAssistantText: null,
    finalResultText: null,
    numTurns: null,
    durationMs: null,
    totalCostUsd: null,
    isError: false,
    errors: [],
    unknownEventTypes: [],
    parseErrors: 0,
  };
  const rows = raw.split("\n").filter((line) => line.trim().length > 0);
  for (const line of rows) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      acc.parseErrors += 1;
      continue;
    }
    if (typeof event === "object" && event !== null && !Array.isArray(event)) {
      handleEvent(acc, event as Record<string, unknown>);
    } else {
      acc.parseErrors += 1;
    }
  }
  return {
    init: acc.init,
    sessionStartBriefing: briefingFromEvents(acc.hookEvents),
    hookEvents: acc.hookEvents,
    toolUses: acc.toolUses,
    bashCommands: acc.bashCommands,
    filesRead: acc.filesRead,
    filesWritten: acc.filesWritten,
    filesEdited: acc.filesEdited,
    todoItems: acc.todoItems,
    firstAssistantText: acc.firstAssistantText,
    finalResultText: acc.finalResultText,
    numTurns: acc.numTurns,
    durationMs: acc.durationMs,
    totalCostUsd: acc.totalCostUsd,
    isError: acc.isError,
    errors: acc.errors,
    unknownEventTypes: acc.unknownEventTypes,
    lineCount: rows.length,
    parseErrors: acc.parseErrors,
  };
};

/** Exported for detect.ts: the marker that identifies a rendered briefing. */
export { BRIEFING_MARKER };
