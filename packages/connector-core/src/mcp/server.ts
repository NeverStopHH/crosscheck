/**
 * The four methods, over newline-delimited stdio.
 *
 * TWO KINDS OF FAILURE, KEPT APART. MCP draws this line and so does this file: a
 * JSON-RPC error means "the call itself was malformed", which a model can do
 * nothing with, while a result carrying `isError` means "the call was fine and
 * here is why it did not work", which a model can act on. An unreachable hub, an
 * expired key, a work context that does not exist and a violated business rule
 * are all the second kind. Only a broken frame, an unknown method and a
 * `tools/call` with no tool name are the first.
 *
 * NOTHING BUT FRAMES REACHES STDOUT. A stray `console.log` corrupts the
 * transport for the rest of the session, so diagnostics go to stderr behind
 * MCP_LOG_PREFIX, and the loop below writes exactly one line per response.
 *
 * NOTHING THROWN ESCAPES. A tool that raises takes down the server and every
 * later call with it; an agent then sees a dead connection rather than a
 * message. Every dispatch is wrapped, and an unexpected throw becomes a tool
 * failure carrying the reason.
 */
import {
  MCP_PROTOCOL_VERSIONS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from "../constants.ts";
import {
  MCP_LOG_PREFIX,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  isNotification,
  parseFrame,
  rpcError,
  rpcResult,
  toolFailure,
} from "./protocol.ts";
import type { ParsedFrame, RpcId, RpcRequest, RpcResponse, ToolResult } from "./protocol.ts";
import { prepareMcp } from "./context.ts";
import { TOOLS, findTool, unknownToolResult } from "./tools/index.ts";
import type { Env } from "../config/paths.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Version negotiation, the spec's own rule: echo what the client asked for when
 * this server speaks it, otherwise answer with the newest one it does. Failing
 * the handshake instead would break an older client against a newer server for
 * no gain — the tools are the same either way.
 */
const negotiateVersion = (params: unknown): string => {
  const wanted = isRecord(params) ? params["protocolVersion"] : undefined;
  const supported = MCP_PROTOCOL_VERSIONS as readonly string[];
  return typeof wanted === "string" && supported.includes(wanted)
    ? wanted
    : (supported[0] ?? "");
};

const initializeResult = (params: unknown): unknown => ({
  protocolVersion: negotiateVersion(params),
  capabilities: { tools: {} },
  serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
});

const listToolsResult = (): unknown => ({
  tools: TOOLS.map((tool) => ({
    name: tool.definition.name,
    description: tool.definition.description,
    inputSchema: tool.definition.inputSchema,
  })),
});

/**
 * Runs one tool.
 *
 * The context is resolved HERE rather than once at startup, so a
 * `crosscheck login` that happens mid-session fixes the very next call — a
 * server that cached "no api key" at launch would keep saying so for hours.
 */
const callTool = async (
  name: string,
  args: unknown,
  env: Env,
  cwd: string,
): Promise<ToolResult> => {
  const tool = findTool(name);
  if (tool === undefined) {
    return unknownToolResult(name);
  }
  const setup = await prepareMcp(env, cwd);
  if (!setup.ok) {
    return toolFailure(setup.message);
  }
  return tool.run(setup.ctx, args);
};

interface ToolCallParams {
  readonly name: string;
  readonly args: unknown;
}

const readToolCallParams = (params: unknown): ToolCallParams | null => {
  if (!isRecord(params)) {
    return null;
  }
  const name = params["name"];
  return typeof name === "string" && name.length > 0
    ? { name, args: params["arguments"] }
    : null;
};

const logError = (context: string, error: unknown): void => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${MCP_LOG_PREFIX} ${context}: ${reason}\n`);
};

const dispatch = async (
  request: RpcRequest,
  id: RpcId,
  env: Env,
  cwd: string,
): Promise<RpcResponse> => {
  if (request.method === "initialize") {
    return rpcResult(id, initializeResult(request.params));
  }
  if (request.method === "ping") {
    return rpcResult(id, {});
  }
  if (request.method === "tools/list") {
    return rpcResult(id, listToolsResult());
  }
  if (request.method !== "tools/call") {
    return rpcError(
      id,
      RPC_METHOD_NOT_FOUND,
      `crosscheck's mcp server does not implement ${request.method}`,
    );
  }
  const params = readToolCallParams(request.params);
  if (params === null) {
    // Genuinely malformed: with no tool name there is no tool to blame, so this
    // is the one `tools/call` failure that is a protocol error rather than a
    // result the agent reads.
    return rpcError(
      id,
      RPC_INVALID_PARAMS,
      "tools/call requires params.name naming the tool to run",
    );
  }
  try {
    return rpcResult(id, await callTool(params.name, params.args, env, cwd));
  } catch (error) {
    // A throw must not kill the connection, and it must not be silent either:
    // the agent gets a message it can report, stderr gets the detail.
    logError(`tools/call ${params.name}`, error);
    return rpcResult(
      id,
      toolFailure(
        `crosscheck's ${params.name} tool failed unexpectedly: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          "This is a bug in crosscheck rather than in your call.",
      ),
    );
  }
};

/**
 * One parsed frame in, at most one response out.
 *
 * `null` means "write nothing", which is only ever right for a notification —
 * answering one corrupts the client's request matching.
 */
export const handleFrame = async (
  frame: ParsedFrame,
  env: Env,
  cwd: string,
): Promise<RpcResponse | null> => {
  if (frame.kind === "unparseable") {
    // JSON-RPC 2.0: when the id cannot be detected it MUST be null, rather than
    // the response being withheld. A client that sent a broken line otherwise
    // waits for an answer that never comes.
    return rpcError(null, RPC_PARSE_ERROR, "frame was not valid json");
  }
  if (frame.kind === "invalid") {
    return rpcError(
      frame.id,
      RPC_INVALID_REQUEST,
      'frame is not a json-rpc 2.0 request: it needs jsonrpc "2.0" and a method',
    );
  }
  if (isNotification(frame.request)) {
    return null;
  }
  return dispatch(frame.request, frame.request.id ?? null, env, cwd);
};

/**
 * The stdio loop.
 *
 * Lines are split manually rather than read with a line reader because a chunk
 * boundary can fall anywhere, including inside a frame: the remainder is carried
 * to the next chunk. A frame larger than one chunk is the ordinary case for
 * `tools/list`, whose schemas are several kilobytes.
 */
export const runMcpServer = async (env: Env, cwd: string): Promise<number> => {
  const decoder = new TextDecoder();
  let pending = "";

  const handleLine = async (line: string): Promise<void> => {
    if (line.trim().length === 0) {
      return;
    }
    try {
      const response = await handleFrame(parseFrame(line), env, cwd);
      if (response !== null) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      // The loop itself must survive anything: a server that exits on one bad
      // frame takes every later call with it.
      logError("frame", error);
    }
  };

  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    // The last element is the incomplete remainder — always, even when the
    // chunk ended exactly on a newline, in which case it is "".
    pending = lines.pop() ?? "";
    for (const line of lines) {
      await handleLine(line);
    }
  }
  await handleLine(pending);
  return 0;
};
