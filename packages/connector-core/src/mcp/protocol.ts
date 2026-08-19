/**
 * JSON-RPC 2.0 and the slice of MCP this server speaks, hand-rolled.
 *
 * WHY NOT @modelcontextprotocol/sdk. The official SDK bundles transports this
 * server does not use — its HTTP/SSE side pulls in express and body-parser —
 * and it would land in the package whose entry point every hook already spawns.
 * Measured this round with `bun add @modelcontextprotocol/sdk` in a scratch
 * directory: 92 packages installed, against the 32 this whole workspace
 * resolves today. (That command writes a node_modules tree, so it is prose with
 * a named command rather than a VERIFY directive — nothing that edits a tree
 * runs from inside scripts/verify-claims.ts.) What is needed instead is four
 * methods over newline-delimited stdio, and that is what is below.
 *
 * The cost of hand-rolling is that protocol conformance is ours to keep, so the
 * handshake is pinned by test/mcp-protocol.test.ts rather than by a dependency.
 *
 * FRAMING. One JSON value per line, UTF-8, no embedded raw newline. That last
 * property is free rather than enforced: `JSON.stringify` escapes U+000A inside
 * strings, so a claim body containing a newline cannot split a frame. It is
 * asserted anyway — `every response is exactly one line` in
 * test/mcp-protocol.test.ts — because it is the property the whole transport
 * rests on, and a future encoder change must not be able to break it quietly.
 */

/** Nothing but frames may reach stdout, so diagnostics go here. */
export const MCP_LOG_PREFIX = "[crosscheck mcp]";

export const JSON_RPC_VERSION = "2.0";

/** The JSON-RPC codes this server can emit. Business failures use none of them. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/** A JSON-RPC id: absent marks a notification, which is never answered. */
export type RpcId = string | number | null;

export interface RpcRequest {
  readonly jsonrpc: string;
  readonly id?: RpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcError {
  readonly code: number;
  readonly message: string;
}

export type RpcResponse =
  | { readonly jsonrpc: string; readonly id: RpcId; readonly result: unknown }
  | { readonly jsonrpc: string; readonly id: RpcId; readonly error: RpcError };

export const rpcResult = (id: RpcId, result: unknown): RpcResponse => ({
  jsonrpc: JSON_RPC_VERSION,
  id,
  result,
});

export const rpcError = (
  id: RpcId,
  code: number,
  message: string,
): RpcResponse => ({ jsonrpc: JSON_RPC_VERSION, id, error: { code, message } });

export type ParsedFrame =
  | { readonly kind: "request"; readonly request: RpcRequest }
  /** Parseable JSON that is not a request — answered with an error frame. */
  | { readonly kind: "invalid"; readonly id: RpcId }
  /** Not JSON at all: there is no id to answer to. */
  | { readonly kind: "unparseable" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `id` is read even from a frame that is otherwise invalid, so the error can be
 * addressed to the request that caused it. A client whose `tools/call` came back
 * with `id: null` could not match the failure to the call it made.
 */
const readId = (value: Record<string, unknown>): RpcId => {
  const id = value["id"];
  return typeof id === "string" || typeof id === "number" ? id : null;
};

export const parseFrame = (line: string): ParsedFrame => {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return { kind: "unparseable" };
  }
  if (!isRecord(raw)) {
    return { kind: "invalid", id: null };
  }
  const method = raw["method"];
  if (raw["jsonrpc"] !== JSON_RPC_VERSION || typeof method !== "string") {
    return { kind: "invalid", id: readId(raw) };
  }
  // `id` absent — not `id: null` — is what makes a frame a notification, and
  // the difference decides whether anything is written back at all.
  const request: RpcRequest = {
    jsonrpc: JSON_RPC_VERSION,
    method,
    ...("id" in raw ? { id: readId(raw) } : {}),
    ...("params" in raw ? { params: raw["params"] } : {}),
  };
  return { kind: "request", request };
};

export const isNotification = (request: RpcRequest): boolean =>
  request.id === undefined;

/** MCP tool result: text content, with `isError` marking a failure the agent sees. */
export interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

export const toolText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

/**
 * A failure the AGENT is told about, rather than one the protocol swallows.
 *
 * MCP draws this line deliberately and so does this server: a JSON-RPC error
 * means "the call itself was malformed", which the model can do nothing with,
 * while `isError` means "the call was fine and here is why it did not work",
 * which the model can act on. An unreachable hub, an expired key and a violated
 * business rule are all the second kind (DESIGN.md §3 fails open for HOOKS —
 * tools fail loudly on purpose).
 */
export const toolFailure = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});
