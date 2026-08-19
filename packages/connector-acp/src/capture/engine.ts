/**
 * The Block 4 capture engine: consumes the observer's parsed-COPY line
 * events and drives the §2.4 mapping through the core kit flows. It sits
 * entirely OFF the forward path — the pump forwards first, the observer
 * works on a copy, and this engine queues that copy's text on a serialized
 * promise chain — so nothing here can reorder, delay, or kill the wire
 * (prime directive 1).
 *
 * FAIL-OPEN EVERYWHERE (prime directive 2):
 *   - `offer()` never throws: it is a bounded synchronous enqueue;
 *   - every dispatch runs inside the chain's catch — a capture bug is a
 *     counter and one log line, never a broken pipe;
 *   - a session in an unconnected directory, or with no resolvable config,
 *     becomes a DISABLED session entry: every later event for it is a cheap
 *     silent skip ("the repo decides where a session reports", per-session
 *     resolution per §2.2);
 *   - the queue is byte-capped (ACP_CAPTURE_MAX_PENDING_BYTES): a line
 *     flood against a slow hub drops CAPTURE lines, counted, and touches
 *     forwarding not at all.
 *
 * PRIVACY: prompt text is never parsed (wire/v1.ts models only sessionId on
 * the prompt path), so it cannot reach the spool, the state files, or the
 * log. Same for diff texts, fs write content and terminal command text.
 * Local logging carries ids, slugs and counts — paths and content never.
 */
import {
  FINGERPRINT_SOURCE_CHARS,
  MAX_SEEN_TARGETS,
} from "@crosscheck/connector-core/constants.ts";
import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import type { Producer } from "@crosscheck/connector-core/capture/records.ts";
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import { isDisabled, loadConfig } from "@crosscheck/connector-core/config/config.ts";
import type { ResolvedConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  captureFailure,
  captureFileTargets,
} from "@crosscheck/connector-core/flows/capture-targets.ts";
import { endSessionFlow } from "@crosscheck/connector-core/flows/end-session.ts";
import { heartbeatMaybe } from "@crosscheck/connector-core/flows/heartbeat.ts";
import {
  fallbackWorkContextTitle,
  registerSessionFlow,
} from "@crosscheck/connector-core/flows/register-session.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import type { RepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { endSession } from "@crosscheck/connector-core/http/hub.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { reapSpool } from "@crosscheck/connector-core/spool/reap.ts";
import {
  acpAgentKind,
  acpHostSessionKey,
} from "@crosscheck/connector-core/state/host-session-key.ts";
import {
  updateSessionState,
  withSeenTargets,
} from "@crosscheck/connector-core/state/session-state.ts";

import {
  ACP_CAPTURE_EXIT_BUDGET_MS,
  ACP_CAPTURE_FLUSH_BUDGET_MS,
  ACP_CAPTURE_MAX_PENDING_BYTES,
  ACP_MAX_TRACKED_TERMINALS,
  ACP_SESSION_CLOSE_FLUSH_BUDGET_MS,
  ACP_TEST_FAULT_CAPTURE_DISPATCH,
  ACP_TEST_FAULT_ENV_VAR,
} from "../constants.ts";
import type { AcpLogger } from "../logger.ts";
import type { ObservedLine } from "../observer.ts";
import type { RecordDirection } from "../recorder.ts";
import {
  ACP_PROTOCOL_VERSION,
  WIRE_METHODS,
  classifyWireMessage,
  parseFsWriteParams,
  parseInitializeResult,
  parseSessionIdParams,
  parseSessionLoadParams,
  parseSessionNewParams,
  parseSessionNewResult,
  parseSessionPromptResult,
  parseSessionUpdateParams,
  parseTerminalCreateResult,
  parseTerminalExitResult,
  parseTerminalIdParams,
  parseTerminalOutputResult,
} from "../wire/v1.ts";
import type { ToolCallUpdate, WireMessage } from "../wire/v1.ts";
import { createPendingMap } from "./pending.ts";

/** Mirrors the Claude hooks' status vocabulary — one wire language. */
const INITIAL_STATUS = "analyzing";
const IMPLEMENTING_STATUS = "implementing";
const EDIT_TOOL_KIND = "edit";
const FAILED_STATUS = "failed";

export interface AcpCaptureOptions {
  readonly env: Env;
  readonly logger: AcpLogger;
  /** `--agent-kind` — overrides the initialize-derived kind (§2.4 row 1). */
  readonly agentKindFlag?: string | undefined;
  /** Injectable clock for deterministic throttle tests. */
  readonly now?: () => Date;
}

export interface AcpCaptureCounters {
  /** Parsed lines dispatched into the mapping. */
  readonly observedLines: number;
  /** Unparseable / oversized / unclassifiable lines — skipped, counted. */
  readonly ignored: number;
  /** Lines dropped by the capture queue's byte cap. */
  readonly dropped: number;
  /** Contained dispatch failures — capture bugs that stayed capture bugs. */
  readonly errors: number;
  /** JSON-RPC error responses on captured methods (§2.4: counted, no record). */
  readonly errorResponses: number;
  /** Register-flow runs (session/new + idempotent re-registers). */
  readonly sessions: number;
  readonly targets: number;
  readonly fingerprints: number;
  readonly heartbeats: number;
  /** session/prompt responses seen — the future Tier-1 gate's tick. */
  readonly turns: number;
}

export interface AcpCapture {
  /** Synchronous, bounded, never throws — called from the pump's observer. */
  offer(direction: RecordDirection, event: ObservedLine): void;
  /** Await the dispatch chain (test seam; shutdown() includes it). */
  settle(): Promise<void>;
  /** End every live session, flush, reap — bounded by `budgetMs`. */
  shutdown(budgetMs?: number): Promise<void>;
  counters(): AcpCaptureCounters;
}

interface CaptureSession {
  readonly acpSessionId: string;
  /** False: unconnected dir or no config — every event is a silent skip. */
  readonly enabled: boolean;
  readonly hostSessionKey: string;
  readonly cwd: string;
  readonly config: ResolvedConfig | null;
  readonly identity: RepoIdentity | null;
  readonly hub: HubContext | null;
  readonly repoKey: string | null;
  readonly crosscheckSessionId: string;
  readonly workContextId: string;
  developerId: string | null;
  lastHeartbeatAt: string | null;
  readonly seenTargets: Set<string>;
  turns: number;
  ended: boolean;
}

interface TrackedTerminal {
  readonly acpSessionId: string;
  /** Kept to the fingerprint window — output beyond it cannot matter. */
  tail: string;
  /** One fingerprint per terminal, however many exit signals arrive. */
  fired: boolean;
}

interface MutableCounters {
  observedLines: number;
  ignored: number;
  dropped: number;
  errors: number;
  errorResponses: number;
  sessions: number;
  targets: number;
  fingerprints: number;
  heartbeats: number;
  turns: number;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createAcpCapture = (options: AcpCaptureOptions): AcpCapture => {
  const now = options.now ?? ((): Date => new Date());
  const logger = options.logger;
  const disabled = isDisabled(options.env);

  const counters: MutableCounters = {
    observedLines: 0,
    ignored: 0,
    dropped: 0,
    errors: 0,
    errorResponses: 0,
    sessions: 0,
    targets: 0,
    fingerprints: 0,
    heartbeats: 0,
    turns: 0,
  };

  /** Requests awaiting a response, per originating direction. */
  const pendingClient = createPendingMap(); // c2a requests → a2c responses
  const pendingAgent = createPendingMap(); // a2c requests → c2a responses
  const sessions = new Map<string, CaptureSession>();
  const terminals = new Map<string, TrackedTerminal>();

  let agentName: string | null = null;
  let negotiatedVersion: number | null = null;
  let accepting = !disabled;
  let pendingBytes = 0;
  let chain: Promise<void> = Promise.resolve();
  // The capture-side test fault (constants.ts): arms exactly one dispatch
  // throw, so the containment catch below is provable — and mutation-checked.
  let dispatchFaultArmed =
    options.env[ACP_TEST_FAULT_ENV_VAR] === ACP_TEST_FAULT_CAPTURE_DISPATCH;

  const enqueue = (work: () => Promise<void>): void => {
    chain = chain.then(work).catch((error) => {
      counters.errors += 1;
      logger.line(`capture-error ${describeError(error)}`);
    });
  };

  const settle = (): Promise<void> =>
    chain.then(
      () => undefined,
      () => undefined,
    );

  // ── session lifecycle ─────────────────────────────────────────────────────

  const disabledSession = (acpSessionId: string, cwd: string): CaptureSession => ({
    acpSessionId,
    enabled: false,
    hostSessionKey: acpHostSessionKey(agentName ?? "", acpSessionId),
    cwd,
    config: null,
    identity: null,
    hub: null,
    repoKey: null,
    crosscheckSessionId: "",
    workContextId: "",
    developerId: null,
    lastHeartbeatAt: null,
    seenTargets: new Set(),
    turns: 0,
    ended: true,
  });

  /**
   * Per-session resolution (§2.2): repo identity from the session's OWN cwd,
   * config through the core loaders (committed .crosscheck.json + login
   * config). No repo or no config = a disabled entry — capture silently off,
   * the pipe above unaffected.
   */
  const registerAcpSession = async (
    acpSessionId: string,
    cwd: string,
  ): Promise<void> => {
    const identity = await resolveRepoIdentity(cwd);
    if (identity === null) {
      sessions.set(acpSessionId, disabledSession(acpSessionId, cwd));
      logger.line(`capture session=${acpSessionId} off (not a repo)`);
      return;
    }
    const config = await loadConfig({
      env: options.env,
      repoRoot: identity.root,
      defaultAgentKind: options.agentKindFlag ?? acpAgentKind(agentName ?? undefined),
    });
    if (config === null) {
      sessions.set(acpSessionId, disabledSession(acpSessionId, cwd));
      logger.line(`capture session=${acpSessionId} off (no config)`);
      return;
    }
    const hostSessionKey = acpHostSessionKey(agentName ?? "", acpSessionId);
    const key = repoKey(config.hubUrl, identity.repoId);
    const hub: HubContext = {
      hubUrl: config.hubUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      home: config.home,
      repoKey: key,
      now,
    };
    const at = now();
    const registered = await registerSessionFlow({
      home: config.home,
      repoKey: key,
      hub,
      agentKind: config.agentKind,
      hostSessionKey,
      repoId: identity.repoId,
      repoRoot: identity.root,
      branch: identity.branch,
      baseCommit: identity.baseCommit,
      hubUrl: config.hubUrl,
      fallbackDeveloperId: config.developerId,
      title: fallbackWorkContextTitle(identity.branch, identity.repoId),
      status: INITIAL_STATUS,
      now: at,
    });
    sessions.set(acpSessionId, {
      acpSessionId,
      enabled: true,
      hostSessionKey,
      cwd,
      config,
      identity,
      hub,
      repoKey: key,
      crosscheckSessionId: registered.crosscheckSessionId,
      workContextId: registered.workContextId,
      developerId: registered.developerId,
      lastHeartbeatAt: at.toISOString(),
      seenTargets: new Set(),
      turns: 0,
      ended: false,
    });
    counters.sessions += 1;
    logger.line(
      `capture registered session=${acpSessionId} cc=${registered.crosscheckSessionId} registered=${registered.registered}`,
    );
    await flushSpool(
      hub,
      { sessionId: registered.crosscheckSessionId, developerId: registered.developerId },
      ACP_CAPTURE_FLUSH_BUDGET_MS,
    );
  };

  const producerFor = (session: CaptureSession): Producer => ({
    developerId: session.developerId ?? UNKNOWN_DEVELOPER_ID,
    agentKind: session.config?.agentKind ?? acpAgentKind(agentName ?? undefined),
    sessionId: session.crosscheckSessionId,
  });

  const liveSession = (acpSessionId: string): CaptureSession | null => {
    const session = sessions.get(acpSessionId);
    return session !== undefined && session.enabled && !session.ended
      ? session
      : null;
  };

  // ── the capture actions (§2.4 rows) ───────────────────────────────────────

  const captureTargets = async (
    session: CaptureSession,
    paths: readonly string[],
  ): Promise<void> => {
    if (paths.length === 0 || session.hub === null || session.config === null) {
      return;
    }
    const captured = await captureFileTargets({
      home: session.config.home,
      repoKey: session.repoKey ?? "",
      hostSessionKey: session.hostSessionKey,
      repoRoot: session.identity?.root ?? session.cwd,
      cwd: session.cwd,
      paths,
      denylist: session.config.denylist ?? null,
      seenTargets: [...session.seenTargets],
      workContextId: session.workContextId,
      producer: producerFor(session),
      now: now(),
    });
    if (captured.length === 0) {
      return;
    }
    for (const path of captured) {
      session.seenTargets.add(path);
    }
    // The in-memory twin of withSeenTargets' FIFO cap (design §6 question
    // 7): a week-long session — or an agent streaming synthetic in-repo
    // paths — must cost bounded memory. Evicting the oldest trades a
    // possible re-capture (the hub dedups on natural key) for the bound,
    // exactly the trade the persisted copy already makes.
    while (session.seenTargets.size > MAX_SEEN_TARGETS) {
      const oldest = session.seenTargets.values().next();
      if (oldest.done) {
        break;
      }
      session.seenTargets.delete(oldest.value);
    }
    counters.targets += captured.length;
    await updateSessionState(
      session.config.home,
      session.hostSessionKey,
      (fresh) => withSeenTargets(fresh, captured),
    );
    await flushSpool(
      session.hub,
      { sessionId: session.crosscheckSessionId, developerId: session.developerId },
      ACP_CAPTURE_FLUSH_BUDGET_MS,
    );
  };

  const captureFailureText = async (
    session: CaptureSession,
    failureText: string,
  ): Promise<void> => {
    if (session.hub === null || session.config === null) {
      return;
    }
    const value = await captureFailure({
      home: session.config.home,
      repoKey: session.repoKey ?? "",
      hostSessionKey: session.hostSessionKey,
      workContextId: session.workContextId,
      producer: producerFor(session),
      failureText,
      now: now(),
    });
    if (value === null) {
      return;
    }
    counters.fingerprints += 1;
    await flushSpool(
      session.hub,
      { sessionId: session.crosscheckSessionId, developerId: session.developerId },
      ACP_CAPTURE_FLUSH_BUDGET_MS,
    );
  };

  const heartbeat = async (
    session: CaptureSession,
    status: string | undefined,
  ): Promise<void> => {
    if (session.hub === null || session.config === null) {
      return;
    }
    const at = now();
    const attempted = await heartbeatMaybe({
      hub: session.hub,
      crosscheckSessionId: session.crosscheckSessionId,
      lastHeartbeatAt: session.lastHeartbeatAt,
      now: at,
      status,
    });
    if (!attempted) {
      return;
    }
    counters.heartbeats += 1;
    session.lastHeartbeatAt = at.toISOString();
    await updateSessionState(
      session.config.home,
      session.hostSessionKey,
      (fresh) => ({ ...fresh, lastHeartbeatAt: at.toISOString() }),
    );
  };

  const endOneSession = async (
    session: CaptureSession,
    flushBudgetMs: number,
  ): Promise<void> => {
    if (!session.enabled || session.ended || session.hub === null || session.config === null) {
      return;
    }
    session.ended = true;
    const outcome = await endSessionFlow({
      home: session.config.home,
      repoKey: session.repoKey ?? "",
      hub: session.hub,
      hostSessionKey: session.hostSessionKey,
      crosscheckSessionId: session.crosscheckSessionId,
      developerId: session.developerId,
      flushBudgetMs,
      now,
    });
    logger.line(
      `capture ended session=${session.acpSessionId} undelivered=${outcome.undelivered} ended=${outcome.ended}`,
    );
  };

  const handleToolCall = async (
    session: CaptureSession,
    toolCall: ToolCallUpdate,
  ): Promise<void> => {
    await captureTargets(session, toolCall.paths);
    if (toolCall.status === FAILED_STATUS) {
      // The §2.4 failure row: string fields joined, tail-sliced — the
      // IDENTICAL extractor + normalizer as the Claude hook path.
      await captureFailureText(session, extractFailureText(toolCall.rawOutput));
    }
    if (toolCall.toolKind === EDIT_TOOL_KIND) {
      // Same heuristic as the Claude connector's edit-tool heartbeat.
      await heartbeat(session, IMPLEMENTING_STATUS);
    }
  };

  const fireTerminalFailure = async (
    terminalId: string,
    exitCode: number | null,
  ): Promise<void> => {
    if (exitCode === null || exitCode === 0) {
      return;
    }
    const terminal = terminals.get(terminalId);
    if (terminal === undefined || terminal.fired) {
      return;
    }
    const session = liveSession(terminal.acpSessionId);
    if (session === null || terminal.tail.length === 0) {
      return;
    }
    terminal.fired = true;
    await captureFailureText(session, terminal.tail);
  };

  const trackTerminal = (terminalId: string, acpSessionId: string): void => {
    if (terminals.size >= ACP_MAX_TRACKED_TERMINALS) {
      const oldest = terminals.keys().next();
      if (!oldest.done) {
        terminals.delete(oldest.value);
      }
    }
    terminals.set(terminalId, { acpSessionId, tail: "", fired: false });
  };

  // ── dispatch: one parsed line through the mapping ─────────────────────────

  const dispatchClientToAgent = async (message: WireMessage): Promise<void> => {
    if (message.kind === "request") {
      pendingClient.put(message.id, {
        method: message.method,
        params: message.params,
      });
      if (
        message.method === WIRE_METHODS.sessionLoad ||
        message.method === WIRE_METHODS.sessionResume
      ) {
        // Register at REQUEST time: history replays as session/update
        // notifications BEFORE the load response arrives (§2.4). Deterministic
        // ids make the cold re-register idempotent; the hub answers duplicate.
        // A session already LIVE in this proxy is skipped outright — a load
        // storm must not inflate the counter, re-append work_context, or
        // reset the seen-set (capture-hardening.test.ts pins both halves; a
        // disabled or closed entry re-resolves, in case config appeared).
        const params = parseSessionLoadParams(message.params);
        if (params !== null) {
          const existing = sessions.get(params.sessionId);
          if (existing === undefined || existing.ended) {
            await registerAcpSession(params.sessionId, params.cwd);
          }
        }
        return;
      }
      if (message.method === WIRE_METHODS.sessionPrompt) {
        // Heartbeat only. The prompt CONTENT is never parsed — Block 5 uses
        // it as an ephemeral hint query; Block 4 has no use for it at all.
        const params = parseSessionIdParams(message.params);
        const session = params === null ? null : liveSession(params.sessionId);
        if (session !== null) {
          await heartbeat(session, undefined);
        }
        return;
      }
      if (message.method === WIRE_METHODS.sessionClose) {
        const params = parseSessionIdParams(message.params);
        const session = params === null ? null : liveSession(params.sessionId);
        if (session !== null) {
          await endOneSession(session, ACP_SESSION_CLOSE_FLUSH_BUDGET_MS);
        }
        return;
      }
      return;
    }
    if (message.kind === "response") {
      const request = pendingAgent.take(message.id);
      if (request === null) {
        return;
      }
      if (message.isError) {
        counters.errorResponses += 1;
        return;
      }
      if (request.method === WIRE_METHODS.terminalCreate) {
        const created = parseTerminalCreateResult(message.result);
        const params = parseSessionIdParams(request.params);
        if (created !== null && params !== null) {
          trackTerminal(created.terminalId, params.sessionId);
        }
        return;
      }
      if (request.method === WIRE_METHODS.terminalOutput) {
        const output = parseTerminalOutputResult(message.result);
        const params = parseTerminalIdParams(request.params);
        if (params !== null && output.output !== null) {
          const terminal = terminals.get(params.terminalId);
          if (terminal !== undefined) {
            terminal.tail = (terminal.tail + output.output).slice(
              -FINGERPRINT_SOURCE_CHARS,
            );
          }
        }
        if (params !== null) {
          await fireTerminalFailure(params.terminalId, output.exitCode);
        }
        return;
      }
      if (request.method === WIRE_METHODS.terminalWaitForExit) {
        const params = parseTerminalIdParams(request.params);
        if (params !== null) {
          const exit = parseTerminalExitResult(message.result);
          await fireTerminalFailure(params.terminalId, exit.exitCode);
        }
        return;
      }
      return;
    }
    // c2a notifications (session/cancel): §2.3 rule 2 — nothing to do, and
    // nothing here ever sits on the cancel path anyway.
  };

  const dispatchAgentToClient = async (message: WireMessage): Promise<void> => {
    if (message.kind === "response") {
      const request = pendingClient.take(message.id);
      if (request === null) {
        return;
      }
      if (message.isError) {
        counters.errorResponses += 1;
        return;
      }
      if (request.method === WIRE_METHODS.initialize) {
        const initialized = parseInitializeResult(message.result);
        agentName = initialized.agentName;
        negotiatedVersion = initialized.protocolVersion;
        logger.line(
          `capture initialize agent=${acpAgentKind(agentName ?? undefined)} protocol=${negotiatedVersion ?? "none"}`,
        );
        if (negotiatedVersion !== ACP_PROTOCOL_VERSION) {
          // §2.3 rule 7: capture stays OPPORTUNISTIC — every message is
          // individually schema-validated anyway; this is the one notice.
          logger.line(
            `capture protocol=${negotiatedVersion ?? "none"} != ${ACP_PROTOCOL_VERSION}: opportunistic capture`,
          );
        }
        return;
      }
      if (request.method === WIRE_METHODS.sessionNew) {
        const result = parseSessionNewResult(message.result);
        const params = parseSessionNewParams(request.params);
        if (result !== null && params !== null) {
          await registerAcpSession(result.sessionId, params.cwd);
        }
        return;
      }
      if (request.method === WIRE_METHODS.sessionPrompt) {
        const params = parseSessionIdParams(request.params);
        const session = params === null ? null : liveSession(params.sessionId);
        if (session !== null) {
          // Turn tick (future Tier-1 gate); cancelled/refusal capture nothing
          // in v1 — and neither does anything else on this row.
          void parseSessionPromptResult(message.result);
          session.turns += 1;
          counters.turns += 1;
        }
        return;
      }
      return;
    }
    if (message.kind === "request") {
      pendingAgent.put(message.id, {
        method: message.method,
        params: message.params,
      });
      if (message.method === WIRE_METHODS.fsWriteTextFile) {
        const params = parseFsWriteParams(message.params);
        const session = params === null ? null : liveSession(params.sessionId);
        if (session !== null && params !== null) {
          await captureTargets(session, [params.path]);
        }
      }
      return;
    }
    // a2c notifications: session/update is THE capture-rich row.
    if (message.method === WIRE_METHODS.sessionUpdate) {
      const update = parseSessionUpdateParams(message.params);
      if (update === null || update.toolCall === null) {
        return;
      }
      const session = liveSession(update.sessionId);
      if (session !== null) {
        await handleToolCall(session, update.toolCall);
      }
    }
  };

  const dispatch = async (
    direction: RecordDirection,
    text: string,
  ): Promise<void> => {
    if (dispatchFaultArmed) {
      dispatchFaultArmed = false;
      throw new Error("injected capture dispatch fault (test seam)");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      counters.ignored += 1;
      return;
    }
    const message = classifyWireMessage(value);
    if (message === null) {
      counters.ignored += 1;
      return;
    }
    counters.observedLines += 1;
    if (direction === "c2a") {
      await dispatchClientToAgent(message);
    } else {
      await dispatchAgentToClient(message);
    }
  };

  // ── the public surface ────────────────────────────────────────────────────

  return {
    offer(direction, event) {
      if (!accepting) {
        return;
      }
      if (event.kind === "oversized" || !event.parsedOk) {
        counters.ignored += 1;
        return;
      }
      const text = event.text;
      if (pendingBytes + text.length > ACP_CAPTURE_MAX_PENDING_BYTES) {
        counters.dropped += 1;
        return;
      }
      pendingBytes += text.length;
      enqueue(() =>
        dispatch(direction, text).finally(() => {
          pendingBytes -= text.length;
        }),
      );
    },
    settle,
    async shutdown(budgetMs = ACP_CAPTURE_EXIT_BUDGET_MS) {
      accepting = false;
      const deadline = Date.now() + budgetMs;
      const remaining = (): number => Math.max(0, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      });
      await Promise.race([settle(), bounded]);
      clearTimeout(timer);
      try {
        // End every live session (§2.4 last row: child exit → endSessionFlow),
        // then reap once per (home, repoKey) with a DeferredEnder bounded by
        // what is left — the session-start maintenance pattern.
        const reapTargets = new Map<string, CaptureSession>();
        for (const session of sessions.values()) {
          if (session.enabled && session.config !== null && session.repoKey !== null) {
            reapTargets.set(`${session.config.home}\n${session.repoKey}`, session);
          }
          await endOneSession(session, remaining());
        }
        for (const session of reapTargets.values()) {
          if (session.config === null || session.hub === null) {
            continue;
          }
          const hub = session.hub;
          await reapSpool(
            session.config.home,
            session.repoKey ?? "",
            now(),
            async (crosscheckSessionId) => {
              const roomMs = remaining();
              if (roomMs <= 0) {
                return false;
              }
              const result = await endSession(
                { ...hub, timeoutMs: Math.min(hub.timeoutMs, roomMs) },
                crosscheckSessionId,
              );
              return result.ok;
            },
          );
        }
      } catch (error) {
        counters.errors += 1;
        logger.line(`capture-shutdown-error ${describeError(error)}`);
      }
      logger.line(
        `capture sessions=${counters.sessions} targets=${counters.targets} ` +
          `fingerprints=${counters.fingerprints} heartbeats=${counters.heartbeats} ` +
          `turns=${counters.turns} ignored=${counters.ignored} dropped=${counters.dropped} ` +
          `errors=${counters.errors} pending-evictions=${pendingClient.evictions() + pendingAgent.evictions()}`,
      );
    },
    counters() {
      return { ...counters };
    },
  };
};
