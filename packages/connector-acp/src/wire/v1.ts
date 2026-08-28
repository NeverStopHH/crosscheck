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
 * PRIVACY BY SHAPE, AND THE TWO TEXTS THAT ARE NOW MODELLED. Diff old/new
 * text, fs write content and terminal COMMAND text are still modelled by no
 * schema here: what is not parsed cannot be stored, spooled or logged
 * (design §2.4 "not captured, deliberately").
 *
 * The derive rungs made two exceptions, deliberately and narrowly, because a
 * connector that reads nothing can infer nothing:
 *
 *   - `parseSessionPromptParams` decodes the prompt's TEXT blocks, so the
 *     capture copy can decide whether a prompt is substantive enough to
 *     derive an intent from. The injector already decoded exactly this,
 *     ephemerally, for the hint query (inject/injector.ts promptQueryOf) —
 *     this is the same decode at the same choke point, with a cap.
 *   - `parseSessionUpdateParams` now also returns an `agent_message_chunk`'s
 *     text, which is the Tier-1 slice's main source.
 *
 * Both are CAPPED here (MAX_WIRE_TEXT_CHARS) so one hostile line cannot cost
 * unbounded parse memory, and what the callers may do with the result is
 * pinned one layer up: the prompt reaches exactly one 0600 file the worker
 * unlinks in `finally`, the slice reaches a spawned worker's stdin and no
 * disk at all, and NEITHER may reach a spool record, a state file or a log
 * line (capture-engine.test.ts's hostile-prompt pin, narrowed rather than
 * deleted, plus derive-privacy.test.ts).
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

/**
 * Cap on ONE decoded wire text field — a prompt's joined text blocks, or one
 * agent message chunk. Neither is ever stored at this size: the intent
 * trigger cuts to INTENT_PROMPT_MAX_CHARS before it writes anything, and the
 * turn slice has its own smaller running cap. This bound exists so a hostile
 * megabyte line costs a bounded string at PARSE time, on the copy path,
 * before any caller has a chance to be careless with it.
 */
const MAX_WIRE_TEXT_CHARS = 16_384;

/** An ACP text ContentBlock. Any other block type contributes nothing. */
const TextBlockSchema = z.looseObject({
  type: z.string().min(1),
  text: z.string().optional(),
});

const TEXT_BLOCK_TYPE = "text";

/** The text of one ContentBlock, or "" for every non-text block. */
const blockText = (block: unknown): string => {
  const parsed = parseOrNull(TextBlockSchema, block);
  return parsed !== null && parsed.type === TEXT_BLOCK_TYPE
    ? (parsed.text ?? "")
    : "";
};

const joinBlockTexts = (blocks: readonly unknown[]): string => {
  const parts: string[] = [];
  let length = 0;
  for (const block of blocks) {
    const text = blockText(block);
    if (text.length === 0) {
      continue;
    }
    parts.push(text);
    length += text.length;
    if (length >= MAX_WIRE_TEXT_CHARS) {
      break;
    }
  }
  return parts.join("\n").slice(0, MAX_WIRE_TEXT_CHARS);
};

const SessionPromptParamsSchema = z.looseObject({
  sessionId: z.string().min(1),
  prompt: z.array(z.unknown()).optional().catch(undefined),
});

/**
 * The prompt path WITH its text — see the module header for why this exists
 * and what the callers may not do with it. A prompt that is not a block
 * array (spec-illegal, or a shape this version does not model) yields the
 * session id and an EMPTY text, never null: capture's heartbeat row must
 * keep working on a prompt whose content we cannot read.
 */
export const parseSessionPromptParams = (
  params: unknown,
): { readonly sessionId: string; readonly text: string } | null => {
  const parsed = parseOrNull(SessionPromptParamsSchema, params);
  const sessionId = parsed === null ? null : safeAcpSessionId(parsed.sessionId);
  if (parsed === null || sessionId === null) {
    return null;
  }
  return {
    sessionId,
    text: Array.isArray(parsed.prompt) ? joinBlockTexts(parsed.prompt) : "",
  };
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

const TOOL_CALL_UPDATES = new Set(["tool_call", "tool_call_update"]);
const DIFF_CONTENT_TYPE = "diff";
/** The agent's own prose. `agent_thought_chunk` is NOT here — see below. */
const AGENT_MESSAGE_CHUNK = "agent_message_chunk";

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
    kind: z.string().min(1).optional().catch(undefined),
    status: z.string().min(1).optional().catch(undefined),
    locations: z.array(z.unknown()).optional().catch(undefined),
    // Deliberately `unknown`: a tool call's `content` is an ARRAY of rows
    // and a message chunk's is a single ContentBlock OBJECT, and both must
    // classify. The shape test is done in code below rather than by two
    // schema keys, because one wire key cannot have two.
    content: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
  }),
});

export interface ToolCallUpdate {
  /** Location paths + diff-content paths, in wire order. PATHS ONLY. */
  readonly paths: readonly string[];
  readonly toolKind: string | null;
  readonly status: string | null;
  readonly rawOutput: unknown;
}

export interface SessionUpdate {
  readonly sessionId: string;
  /** Null for non-tool updates (message chunks, plans, mode changes). */
  readonly toolCall: ToolCallUpdate | null;
  /**
   * The text of an `agent_message_chunk`, capped — the Tier-1 slice's main
   * source. Null for every other update kind, INCLUDING
   * `agent_thought_chunk`: reasoning text is the model talking to itself, it
   * is the most sensitive prose on this wire, and the gate's conjunctions
   * want what the agent said and what actually ran — so thoughts are left
   * out on purpose rather than by omission.
   */
  readonly agentText: string | null;
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
    const agentText =
      parsed.update.sessionUpdate === AGENT_MESSAGE_CHUNK
        ? blockText(parsed.update.content).slice(0, MAX_WIRE_TEXT_CHARS)
        : "";
    return {
      sessionId,
      toolCall: null,
      agentText: agentText.length === 0 ? null : agentText,
    };
  }
  const contentRows = Array.isArray(parsed.update.content)
    ? parsed.update.content
    : [];
  const locationPaths = (parsed.update.locations ?? [])
    .map((row) => parseOrNull(LocationSchema, row))
    .flatMap((row) => (row === null ? [] : [row.path]));
  const diffPaths = contentRows
    .map((row) => parseOrNull(DiffContentSchema, row))
    .flatMap((row) =>
      row !== null && row.type === DIFF_CONTENT_TYPE && row.path !== undefined
        ? [row.path]
        : [],
    );
  return {
    sessionId,
    agentText: null,
    toolCall: {
      paths: [...locationPaths, ...diffPaths],
      toolKind: parsed.update.kind ?? null,
      status: parsed.update.status ?? null,
      rawOutput: parsed.update.rawOutput,
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
