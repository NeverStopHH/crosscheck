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
 * THE BRIEFING IS FOUND BY DEEP SEARCH, AND ONLY FROM SESSIONSTART. The
 * SessionStart hook's rendered briefing arrives as an `additionalContext`
 * string inside a hook event, and the exact nesting differs across CLI
 * versions (the live 2.1.x CLI carries the hook's stdout as a JSON string).
 * `briefingFromEvents` walks every hook event for `additionalContext` strings
 * and keeps one only when EVERY hook name on its path — Claude Code's event
 * and the hook's own payload alike — is SessionStart, and at least one is
 * present (A2.5). There is no fallback: a deferred briefing that rode
 * UserPromptSubmit (user-prompt-submit.ts), or a nameless context that merely
 * carries the briefing header, is not SessionStart delivery and yields null,
 * which §7 voids. The driver then checks the chosen text against the seeded
 * body as rendered (A1.2).
 *
 * zod validates each KNOWN event at the boundary; the schemas are loose so an
 * extra field a new CLI adds rides through untouched.
 */
import { z } from "zod";

/** The one hook whose output is §7 delivery (A2.5). */
const SESSION_START = "SessionStart";

/** The keys a hook event or a hook's own payload names its hook under. */
const HOOK_NAME_KEYS = ["hookEventName", "hook_event_name", "hook_event"] as const;

export interface McpServerInfo {
  readonly name: string;
  /** The connection status init reports; "" when the event omits it. */
  readonly status: string;
}

export interface InitInfo {
  readonly model: string | null;
  /** Every MCP server init names, with its reported connection status (A1.6). */
  readonly mcpServers: readonly McpServerInfo[];
  readonly tools: readonly string[];
  readonly slashCommands: readonly string[];
  /** Plugin names init names, if any — empty is the isolated case. */
  readonly plugins: readonly string[];
  /**
   * The raw count of plugin entries, including nameless ones: the isolation
   * check (A1.6 / §7) counts ANY plugin, so a nameless entry must not vanish.
   */
  readonly pluginCount: number;
  /**
   * Each plugin entry's `source` as init gives it (`<name>@builtin` for the
   * ones shipped inside Claude Code), "" where an entry carries none. Absent
   * when the record was built without it; the isolation check then admits no
   * plugin at all (A3).
   */
  readonly pluginSources?: readonly string[];
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
  /** First NON-synthetic assistant text — null when no real turn happened. */
  readonly firstAssistantText: string | null;
  /** Every non-synthetic assistant text block, for the S3 echo scan (A1.4). */
  readonly assistantTexts: readonly string[];
  /**
   * Non-synthetic assistant turns. An API-error turn carries model
   * "<synthetic>" and is NOT counted, so a pre-turn service failure is void
   * (A1.6) even though the stream carried an assistant message.
   */
  readonly realAssistantTurns: number;
  /**
   * The `message.model` each non-synthetic assistant turn reported, in order
   * (A2.3). `init.model` alone does not show a turn re-run on another model
   * after a safety flag; a turn that reports no model adds nothing here.
   */
  readonly realAssistantModels: readonly string[];
  readonly finalResultText: string | null;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly totalCostUsd: number | null;
  readonly isError: boolean;
  readonly errors: readonly string[];
  readonly unknownEventTypes: readonly string[];
  readonly lineCount: number;
  readonly parseErrors: number;
  /**
   * One entry per synthetic (API-error) assistant turn: its `error` word as the
   * stream gives it (`rate_limit` for the account's usage limit), or
   * `api_error` when it names none (A4.2). Absent on a record built without it.
   */
  readonly apiErrorTurns?: readonly string[];
  /** The result event's `terminal_reason` (`api_error` when the service broke off). */
  readonly terminalReason?: string | null;
  /** The result event's `api_error_status`, e.g. 429 at the usage limit. */
  readonly apiErrorStatus?: number | null;
}

const McpServerSchema = z.looseObject({
  name: z.string().min(1),
  status: z.string().optional(),
});

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
  message: z.looseObject({
    content: z.array(z.unknown()),
    model: z.string().optional(),
  }),
});

/** The model string a synthetic (API-error) assistant turn carries. */
const SYNTHETIC_MODEL = "<synthetic>";

const ResultEventSchema = z.looseObject({
  type: z.literal("result"),
  result: z.string().optional(),
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),
  is_error: z.boolean().optional(),
  terminal_reason: z.string().optional(),
  api_error_status: z.number().optional(),
});

const TodoItemSchema = z.looseObject({ content: z.string().min(1) });

const mcpServerInfo = (
  servers: readonly z.infer<typeof McpServerSchema>[],
): McpServerInfo[] =>
  servers.map((server) => ({ name: server.name, status: server.status ?? "" }));

/** The names of the MCP servers init reported — for display and the live log. */
export const mcpServerNames = (init: InitInfo | null): readonly string[] =>
  init === null ? [] : init.mcpServers.map((server) => server.name);

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

/** A plugin entry's `source`, or "" — a bare name or a source-less object is no admitted source. */
const pluginSource = (entry: unknown): string => {
  if (typeof entry === "object" && entry !== null && "source" in entry) {
    const source = (entry as Record<string, unknown>)["source"];
    return typeof source === "string" ? source : "";
  }
  return "";
};

const initFrom = (event: z.infer<typeof InitEventSchema>): InitInfo => ({
  model: event.model ?? null,
  mcpServers:
    event.mcp_servers === undefined ? [] : mcpServerInfo(event.mcp_servers),
  tools: event.tools ?? [],
  slashCommands: event.slash_commands ?? [],
  plugins:
    event.plugins === undefined
      ? []
      : event.plugins.map(pluginName).filter((name) => name.length > 0),
  // The RAW length, not the named count: a nameless plugin still breaks
  // isolation and must be visible to the void rule.
  pluginCount: event.plugins === undefined ? 0 : event.plugins.length,
  pluginSources: event.plugins === undefined ? [] : event.plugins.map(pluginSource),
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
  /** Every hook name on the path from the event down to this context. */
  readonly hookNames: readonly string[];
}

/** The hook a node names itself under, if it names one. */
const hookNameOf = (record: Record<string, unknown>): string | null =>
  HOOK_NAME_KEYS.map((key) => stringField(record, key)).find(
    (name): name is string => name !== null,
  ) ?? null;

/** A string that may hold a hook's stdout as JSON, parsed; null otherwise. */
const embeddedJson = (value: unknown): unknown => {
  if (typeof value !== "string" || !value.includes("additionalContext")) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

/**
 * All `additionalContext` strings under `node`, each with the hook names on
 * its path. The live CLI carries a hook's stdout as a JSON STRING (the
 * `output` field), so a string that could hold one is parsed and searched
 * too, inheriting the enclosing event's names. Pure.
 */
const contextCandidates = (
  node: unknown,
  inherited: readonly string[],
): readonly ContextCandidate[] => {
  if (Array.isArray(node)) {
    return node.flatMap((item) => contextCandidates(item, inherited));
  }
  if (typeof node !== "object" || node === null) {
    return [];
  }
  const record = node as Record<string, unknown>;
  const own = hookNameOf(record);
  const hookNames = own === null ? inherited : [...inherited, own];
  const context = record["additionalContext"];
  const here: readonly ContextCandidate[] =
    typeof context === "string" && context.length > 0 ? [{ context, hookNames }] : [];
  const below = Object.values(record).flatMap((value) => [
    ...contextCandidates(embeddedJson(value), hookNames),
    ...contextCandidates(value, hookNames),
  ]);
  return [...here, ...below];
};

/** SessionStart delivery: some hook is named, and every name says SessionStart. */
const isSessionStartDelivery = (candidate: ContextCandidate): boolean =>
  candidate.hookNames.length > 0 &&
  candidate.hookNames.every((name) => name === SESSION_START);

/**
 * The SessionStart briefing: the first `additionalContext` whose whole path
 * names SessionStart, or null — never another hook's output, never a
 * nameless context (A2.5).
 */
export const briefingFromEvents = (events: readonly unknown[]): string | null =>
  contextCandidates(events, []).find(isSessionStartDelivery)?.context ?? null;

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
  readonly assistantTexts: string[];
  realAssistantTurns: number;
  readonly realAssistantModels: string[];
  finalResultText: string | null;
  numTurns: number | null;
  durationMs: number | null;
  totalCostUsd: number | null;
  isError: boolean;
  readonly errors: string[];
  readonly unknownEventTypes: string[];
  parseErrors: number;
  readonly apiErrorTurns: string[];
  terminalReason: string | null;
  apiErrorStatus: number | null;
}

/** What a synthetic turn's error is called when the stream gives it no word. */
const UNNAMED_API_ERROR = "api_error";

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

/** An API-error turn: model "<synthetic>", or a block flagged as an API error. */
const isSyntheticAssistant = (
  event: z.infer<typeof AssistantEventSchema>,
): boolean => {
  if (event.message.model === SYNTHETIC_MODEL) {
    return true;
  }
  return event.message.content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>)["isApiErrorMessage"] === true,
  );
};

const handleAssistant = (
  acc: Accumulator,
  event: z.infer<typeof AssistantEventSchema>,
): void => {
  const synthetic = isSyntheticAssistant(event);
  if (!synthetic) {
    acc.realAssistantTurns += 1;
    if (event.message.model !== undefined) {
      acc.realAssistantModels.push(event.message.model);
    }
  } else {
    // A4.2: the service broke off. Its word (`rate_limit` at the usage limit)
    // decides whether the sweep pauses or the run is void as a mid-run failure.
    const word = (event as Record<string, unknown>)["error"];
    acc.apiErrorTurns.push(typeof word === "string" && word.length > 0 ? word : UNNAMED_API_ERROR);
  }
  for (const block of event.message.content) {
    const text = TextBlockSchema.safeParse(block);
    if (text.success) {
      // A synthetic turn's text is the API error, not the agent's word: it is
      // neither a first real turn nor an echo the S3 scan should see.
      if (!synthetic) {
        acc.assistantTexts.push(text.data.text);
        if (acc.firstAssistantText === null) {
          acc.firstAssistantText = text.data.text;
        }
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
    acc.terminalReason = result.data.terminal_reason ?? null;
    acc.apiErrorStatus = result.data.api_error_status ?? null;
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
    assistantTexts: [],
    realAssistantTurns: 0,
    realAssistantModels: [],
    finalResultText: null,
    numTurns: null,
    durationMs: null,
    totalCostUsd: null,
    isError: false,
    errors: [],
    unknownEventTypes: [],
    parseErrors: 0,
    apiErrorTurns: [],
    terminalReason: null,
    apiErrorStatus: null,
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
    assistantTexts: acc.assistantTexts,
    realAssistantTurns: acc.realAssistantTurns,
    realAssistantModels: acc.realAssistantModels,
    finalResultText: acc.finalResultText,
    numTurns: acc.numTurns,
    durationMs: acc.durationMs,
    totalCostUsd: acc.totalCostUsd,
    isError: acc.isError,
    errors: acc.errors,
    unknownEventTypes: acc.unknownEventTypes,
    lineCount: rows.length,
    parseErrors: acc.parseErrors,
    apiErrorTurns: acc.apiErrorTurns,
    terminalReason: acc.terminalReason,
    apiErrorStatus: acc.apiErrorStatus,
  };
};
