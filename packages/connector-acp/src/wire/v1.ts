/**
 * ACP protocol v1 wire shapes — exactly the messages the §2.4 capture
 * mapping needs, nothing more. TOLERANT BY CONSTRUCTION: every schema is a
 * looseObject over the parse COPY, so unknown fields ride through ignored,
 * an unknown method simply matches no parser, and a malformed message
 * classifies to null — the wire itself was already forwarded verbatim
 * upstream (§2.3 rules 1-4), so the worst a parse miss can cost is one
 * uncaptured signal.
 *
 * VERSION-PINNED (§2.5): this module speaks protocol 1. The v2 diff overhaul
 * lands as a NEW sibling module behind a version switch — never as edits here.
 *
 * PRIVACY BY SHAPE: no schema in this file models prompt text, diff
 * old/new text, fs write content, or terminal command text. What is not
 * parsed cannot be stored, spooled, or logged (design §2.4 "not captured,
 * deliberately" + the hostile-prompt pin in capture-engine.test.ts).
 */
import { z } from "zod";

import { safeAcpSessionId } from "@crosscheck/connector-core/state/host-session-key.ts";

export const ACP_PROTOCOL_VERSION = 1;

/** The §2.4 rows by method name — the capture dispatcher's whole vocabulary. */
export const WIRE_METHODS = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionResume: "session/resume",
  sessionPrompt: "session/prompt",
  sessionUpdate: "session/update",
  sessionCancel: "session/cancel",
  sessionClose: "session/close",
  fsWriteTextFile: "fs/write_text_file",
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalWaitForExit: "terminal/wait_for_exit",
  terminalRelease: "terminal/release",
  terminalKill: "terminal/kill",
} as const;

export type WireId = string | number;

export interface WireRequest {
  readonly kind: "request";
  readonly id: WireId;
  readonly method: string;
  readonly params: unknown;
}

export interface WireNotification {
  readonly kind: "notification";
  readonly method: string;
  readonly params: unknown;
}

export interface WireResponse {
  readonly kind: "response";
  readonly id: WireId;
  readonly result: unknown;
  readonly isError: boolean;
}

export type WireMessage = WireRequest | WireNotification | WireResponse;

const isWireId = (value: unknown): value is WireId =>
  typeof value === "string" || typeof value === "number";

/**
 * Request / notification / response off the JSON-RPC envelope. Anything that
 * is not an object with a usable method or id is null — ignored, never a
 * throw (§2.3 rule 4).
 */
export const classifyWireMessage = (value: unknown): WireMessage | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const method = typeof record["method"] === "string" ? record["method"] : null;
  const id = isWireId(record["id"]) ? record["id"] : null;
  if (method !== null && id !== null) {
    return { kind: "request", id, method, params: record["params"] };
  }
  if (method !== null) {
    return { kind: "notification", method, params: record["params"] };
  }
  if (id !== null && ("result" in record || "error" in record)) {
    return {
      kind: "response",
      id,
      result: record["result"],
      isError: "error" in record && record["error"] !== undefined && record["error"] !== null,
    };
  }
  return null;
};

/** safeParse through a schema; null on any mismatch — the tolerant default. */
const parseOrNull = <T>(schema: z.ZodType<T>, value: unknown): T | null => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

// ── initialize ──────────────────────────────────────────────────────────────

const InitializeResultSchema = z.looseObject({
  protocolVersion: z.number().optional(),
  agentInfo: z
    .looseObject({
      name: z.string().min(1).optional(),
      version: z.string().min(1).optional(),
    })
    .optional(),
});

export interface InitializeResult {
  readonly protocolVersion: number | null;
  readonly agentName: string | null;
  readonly agentVersion: string | null;
}

export const parseInitializeResult = (result: unknown): InitializeResult => {
  const parsed = parseOrNull(InitializeResultSchema, result);
  return {
    protocolVersion: parsed?.protocolVersion ?? null,
    agentName: parsed?.agentInfo?.name ?? null,
    agentVersion: parsed?.agentInfo?.version ?? null,
  };
};

// ── session lifecycle ───────────────────────────────────────────────────────

/**
 * HOSTILE-IDENTIFIER DISCIPLINE: every session id on this wire is minted by
 * the AGENT. `safeAcpSessionId` shapes each one right here, at the parse
 * boundary — the single choke point — so nothing downstream (engine log
 * lines, host keys, state filenames, `cc_`/`wc_` ids) can ever see an
 * unshaped id: no newline can mint a log line, no ESC can drive a terminal,
 * no multi-kilobyte id can bloat a key. An id that is nothing but
 * unprintables parses to null: capture skips it, the pipe above is
 * unaffected. Only `--record` keeps the verbatim wire — that is its
 * documented purpose.
 */

const SessionNewParamsSchema = z.looseObject({ cwd: z.string().min(1) });

export const parseSessionNewParams = (
  params: unknown,
): { readonly cwd: string } | null => {
  const parsed = parseOrNull(SessionNewParamsSchema, params);
  return parsed === null ? null : { cwd: parsed.cwd };
};

const SessionNewResultSchema = z.looseObject({ sessionId: z.string().min(1) });

export const parseSessionNewResult = (
  result: unknown,
): { readonly sessionId: string } | null => {
  const parsed = parseOrNull(SessionNewResultSchema, result);
  const sessionId = parsed === null ? null : safeAcpSessionId(parsed.sessionId);
  return sessionId === null ? null : { sessionId };
};

const SessionLoadParamsSchema = z.looseObject({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
});

export const parseSessionLoadParams = (
  params: unknown,
): { readonly sessionId: string; readonly cwd: string } | null => {
  const parsed = parseOrNull(SessionLoadParamsSchema, params);
  const sessionId = parsed === null ? null : safeAcpSessionId(parsed.sessionId);
  return parsed === null || sessionId === null
    ? null
    : { sessionId, cwd: parsed.cwd };
};

const SessionIdParamsSchema = z.looseObject({ sessionId: z.string().min(1) });

/** For prompt/close/cancel: the session id and NOTHING else (privacy by shape). */
export const parseSessionIdParams = (
  params: unknown,
): { readonly sessionId: string } | null => {
  const parsed = parseOrNull(SessionIdParamsSchema, params);
  const sessionId = parsed === null ? null : safeAcpSessionId(parsed.sessionId);
  return sessionId === null ? null : { sessionId };
};

const SessionPromptResultSchema = z.looseObject({
  stopReason: z.string().min(1).optional(),
});

export const parseSessionPromptResult = (
  result: unknown,
): { readonly stopReason: string | null } => {
  const parsed = parseOrNull(SessionPromptResultSchema, result);
  return { stopReason: parsed?.stopReason ?? null };
};

// ── session/update tool calls ───────────────────────────────────────────────

/** Tolerant rows: one malformed location must not cost the others. */
const LocationSchema = z.looseObject({ path: z.string().min(1) });

const DiffContentSchema = z.looseObject({
  type: z.string().min(1),
  path: z.string().min(1).optional(),
});

/** The row that ANNOUNCES a tool call; the other one revises it. */
const NEW_TOOL_CALL = "tool_call";
const TOOL_CALL_UPDATES = new Set([NEW_TOOL_CALL, "tool_call_update"]);
const DIFF_CONTENT_TYPE = "diff";

/**
 * Wrong-typed optional fields fold to undefined (`catch`) instead of failing
 * the whole update: a message chunk's `content` is an OBJECT where a tool
 * call's is an array, and both must classify — the chunk as a no-tool-call
 * update, never as unparseable.
 */
const SessionUpdateParamsSchema = z.looseObject({
  sessionId: z.string().min(1),
  update: z.looseObject({
    sessionUpdate: z.string().min(1),
    toolCallId: z.string().min(1).optional().catch(undefined),
    kind: z.string().min(1).optional().catch(undefined),
    status: z.string().min(1).optional().catch(undefined),
    locations: z.array(z.unknown()).optional().catch(undefined),
    content: z.array(z.unknown()).optional().catch(undefined),
    rawOutput: z.unknown().optional(),
  }),
});

export interface ToolCallUpdate {
  /** Location paths + diff-content paths, in wire order. PATHS ONLY. */
  readonly paths: readonly string[];
  /**
   * The agent's own id for this tool CALL, carried by both the announce row
   * and every later revision of it — the identity the edit-tool fire is
   * counted on (capture/engine.ts). Null only for a row that omits it, which
   * the ACP schema does not permit but a tolerant parser must survive; the
   * `isNewToolCall` fallback below is what such a row falls back to.
   */
  readonly toolCallId: string | null;
  readonly toolKind: string | null;
  readonly status: string | null;
  readonly rawOutput: unknown;
  /**
   * True for `sessionUpdate: "tool_call"` — the row that ANNOUNCES a tool
   * call — and false for every later `tool_call_update` on the same call.
   *
   * The two are folded into one shape above (TOOL_CALL_UPDATES) because the
   * capture mapping treats their payloads identically, and that is still
   * right for paths and failures. It is NOT right for counting: agents
   * commonly repeat the whole update — `kind` included — on each status
   * change, so a fire counted per row would report three edit-tool fires for
   * one edit and corrupt the `N fires -> M targets` ratio the doctor WARN is
   * measured on. One fire per tool call is also exactly what the Claude
   * reference counts.
   *
   * It is the FALLBACK discriminator, not the primary one. Counting on this
   * alone booked ZERO fires for an agent that announces
   * `tool_call {status: "pending"}` and only reveals `kind: "edit"` on the
   * following revision — `kind` is optional on the announce row (the schema
   * above, and the ACP schema's own `"other"` default), so that agent is
   * conformant and its WARN was structurally unreachable. `toolCallId` is the
   * identity the fire is counted on now; this stands in for a row that
   * carries no id at all.
   *
   * Both are ADDITIVE fields on a version-pinned module: nothing that existed
   * changed shape, and no new wire FACT is parsed — both discriminators were
   * already on the wire and simply thrown away.
   */
  readonly isNewToolCall: boolean;
}

export interface SessionUpdate {
  readonly sessionId: string;
  /** Null for non-tool updates (message chunks, plans, mode changes). */
  readonly toolCall: ToolCallUpdate | null;
}

export const parseSessionUpdateParams = (
  params: unknown,
): SessionUpdate | null => {
  const parsed = parseOrNull(SessionUpdateParamsSchema, params);
  const sessionId = parsed === null ? null : safeAcpSessionId(parsed.sessionId);
  if (parsed === null || sessionId === null) {
    return null;
  }
  if (!TOOL_CALL_UPDATES.has(parsed.update.sessionUpdate)) {
    return { sessionId, toolCall: null };
  }
  const locationPaths = (parsed.update.locations ?? [])
    .map((row) => parseOrNull(LocationSchema, row))
    .flatMap((row) => (row === null ? [] : [row.path]));
  const diffPaths = (parsed.update.content ?? [])
    .map((row) => parseOrNull(DiffContentSchema, row))
    .flatMap((row) =>
      row !== null && row.type === DIFF_CONTENT_TYPE && row.path !== undefined
        ? [row.path]
        : [],
    );
  return {
    sessionId,
    toolCall: {
      paths: [...locationPaths, ...diffPaths],
      toolCallId: parsed.update.toolCallId ?? null,
      toolKind: parsed.update.kind ?? null,
      status: parsed.update.status ?? null,
      rawOutput: parsed.update.rawOutput,
      isNewToolCall: parsed.update.sessionUpdate === NEW_TOOL_CALL,
    },
  };
};

// ── fs + terminals ──────────────────────────────────────────────────────────

const FsWriteParamsSchema = z.looseObject({
  sessionId: z.string().min(1),
  path: z.string().min(1),
});

/** Path only — the content field is deliberately not modeled. */
export const parseFsWriteParams = (
  params: unknown,
): { readonly sessionId: string; readonly path: string } | null => {
  const parsed = parseOrNull(FsWriteParamsSchema, params);
  const sessionId = parsed === null ? null : safeAcpSessionId(parsed.sessionId);
  return parsed === null || sessionId === null
    ? null
    : { sessionId, path: parsed.path };
};

/** Session id only — the command text is deliberately not modeled (§2.4). */
export const parseTerminalCreateParams = (
  params: unknown,
): { readonly sessionId: string } | null => parseSessionIdParams(params);

const TerminalCreateResultSchema = z.looseObject({
  terminalId: z.string().min(1),
});

export const parseTerminalCreateResult = (
  result: unknown,
): { readonly terminalId: string } | null => {
  const parsed = parseOrNull(TerminalCreateResultSchema, result);
  return parsed === null ? null : { terminalId: parsed.terminalId };
};

const TerminalIdParamsSchema = z.looseObject({
  sessionId: z.string().min(1).optional(),
  terminalId: z.string().min(1),
});

export const parseTerminalIdParams = (
  params: unknown,
): { readonly sessionId: string | null; readonly terminalId: string } | null => {
  const parsed = parseOrNull(TerminalIdParamsSchema, params);
  return parsed === null
    ? null
    : {
        sessionId:
          parsed.sessionId === undefined
            ? null
            : safeAcpSessionId(parsed.sessionId),
        terminalId: parsed.terminalId,
      };
};

const ExitStatusSchema = z.looseObject({
  exitCode: z.number().nullable().optional(),
});

const TerminalOutputResultSchema = z.looseObject({
  output: z.string().optional(),
  exitStatus: ExitStatusSchema.nullable().optional(),
});

export interface TerminalOutputResult {
  readonly output: string | null;
  readonly exitCode: number | null;
}

export const parseTerminalOutputResult = (
  result: unknown,
): TerminalOutputResult => {
  const parsed = parseOrNull(TerminalOutputResultSchema, result);
  return {
    output: parsed?.output ?? null,
    exitCode: parsed?.exitStatus?.exitCode ?? null,
  };
};

const TerminalExitResultSchema = z.looseObject({
  exitCode: z.number().nullable().optional(),
  exitStatus: ExitStatusSchema.nullable().optional(),
});

/** exitCode at top level (wait_for_exit result) or under exitStatus. */
export const parseTerminalExitResult = (
  result: unknown,
): { readonly exitCode: number | null } => {
  const parsed = parseOrNull(TerminalExitResultSchema, result);
  return { exitCode: parsed?.exitCode ?? parsed?.exitStatus?.exitCode ?? null };
};
