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
 * THE DERIVE RUNGS RIDE THIS SAME COPY. Three triggers hang off the §2.4
 * dispatch — an intent fire and a ghost-debt payment on the session/prompt
 * REQUEST, the Tier-1 gate on its RESPONSE (the `turns` tick this file's own
 * comment already called "the future Tier-1 gate's tick"). They are here
 * rather than in the injector on purpose: the injector is the only thing
 * that writes to the wire, and no derive capability may ever need it to.
 * Everything below works with `--no-inject`, and none of it can touch a
 * forwarded byte (derive/triggers.ts states the whole rule).
 *
 * PRIVACY, AND THE TWO TEXTS THIS FILE NOW HANDLES. Diff texts, fs write
 * content and terminal COMMAND text are still parsed by nothing, so they
 * cannot reach anything. Two texts now are, and each has exactly one
 * destination:
 *
 *   - the PROMPT reaches one 0600 file the intent worker removes as its
 *     first act, and nothing else — never the spool, a state file, a record
 *     or a log line;
 *   - the TURN SLICE (derive/slice.ts) lives in memory, byte-capped, and
 *     leaves only down a spawned worker's stdin — it touches no disk at all
 *     on this host.
 *
 * Both are pinned: the prompt by capture-engine.test.ts's prompt-privacy
 * case, NARROWED to the statement above rather than deleted (it used to say
 * "no persisted byte", which the intent file makes false in one bounded
 * way), and both by derive.test.ts's two privacy cases. Local logging still
 * carries ids, slugs and counts — paths and content never.
 */
import {
  FINGERPRINT_SOURCE_CHARS,
  MAX_SEEN_TARGETS,
} from "@crosscheck/connector-core/constants.ts";
import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import type { Producer } from "@crosscheck/connector-core/capture/records.ts";
import { UNKNOWN_DEVELOPER_ID } from "@crosscheck/connector-core/capture/records.ts";
import { isDisabled, loadReportableConfig } from "@crosscheck/connector-core/config/config.ts";
import type { ResolvedConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  captureFailure,
  captureFileTargets,
} from "@crosscheck/connector-core/flows/capture-targets.ts";
import {
  assembleBriefing,
  recordBriefingDeliveries,
} from "@crosscheck/connector-core/flows/briefing.ts";
import type { AssembledBriefing } from "@crosscheck/connector-core/flows/briefing.ts";
import { endSessionFlow } from "@crosscheck/connector-core/flows/end-session.ts";
import { heartbeatMaybe } from "@crosscheck/connector-core/flows/heartbeat.ts";
import { registerSessionFlow } from "@crosscheck/connector-core/flows/register-session.ts";
import { resolveFallbackWorkContextTitle } from "@crosscheck/connector-core/flows/work-context-title.ts";
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
  maybeSpawnAcpGhostWorker,
  maybeSpawnAcpIntentWorker,
  runAcpSummarizerGate,
} from "../derive/triggers.ts";
import type { AcpDeriveContext } from "../derive/triggers.ts";
import { createTurnSliceStore } from "../derive/slice.ts";
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
  parseSessionPromptParams,
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
  /**
   * Block 5: when true, a successful register kicks off the ASYNC briefing
   * prefetch (§2.5 — assembled at session/new capture time, served from
   * cache at the first prompt, never awaited on the wire path).
   */
  readonly injection?: boolean;
  /** Injectable clock for deterministic throttle tests. */
  readonly now?: () => Date;
}

/** What the first-prompt decision may find in the briefing cache. */
export type BriefingTake =
  | { readonly kind: "pending" }
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly text: string };

/**
 * The narrow session view the injector programs against — everything the
 * two prompt-path decisions need, nothing else of the engine exposed.
 */
export interface PromptInjectionView {
  readonly hostSessionKey: string;
  readonly home: string;
  readonly repoKey: string;
  readonly repoId: string;
  readonly repoRoot: string;
  readonly agentKind: string;
  readonly hub: HubContext;
  readonly timeoutMs: number;
  /**
   * Claims the cached briefing exactly once: `pending` while the prefetch
   * is in flight (the design's next-prompt fallback), `none` when it is
   * spent or came back empty, `text` with the rendered briefing — with the
   * solved-pointer deliveries recorded BEFORE the text is handed out
   * (record-then-emit, the prompt-hook contract).
   */
  takeBriefing(): Promise<BriefingTake>;
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
  /** session/prompt responses seen — the Tier-1 gate's tick. */
  readonly turns: number;
  /** Derived-intent fires booked by this proxy (once per session at most). */
  readonly intentFires: number;
  /** Ghost debts claimed and handed to a worker. */
  readonly ghostPayments: number;
  /** Tier-1 fires booked at a turn boundary. */
  readonly summarizerFires: number;
  /**
   * Slice characters the byte cap refused. NOT decorative: the gate reads
   * the slice it was given, so a turn whose conclusion arrived past the cap
   * is a miss, and this is what makes that explainable rather than silent.
   */
  readonly sliceDropped: number;
}

export interface AcpCapture {
  /** Synchronous, bounded, never throws — called from the pump's observer. */
  offer(direction: RecordDirection, event: ObservedLine): void;
  /** Await the dispatch chain (test seam; shutdown() includes it). */
  settle(): Promise<void>;
  /** End every live session, flush, reap — bounded by `budgetMs`. */
  shutdown(budgetMs?: number): Promise<void>;
  counters(): AcpCaptureCounters;
  /**
   * Block 5: the injector's window into a LIVE, enabled session — null for
   * unknown, disabled, or ended sessions (every null is a skipped
   * injection, never an error).
   */
  promptInjectionView(acpSessionId: string): PromptInjectionView | null;
}

/**
 * The per-session briefing cache (§2.5): filled by the async prefetch,
 * spent by the first prompt's takeBriefing. Mutable by necessity, like the
 * counters — the prefetch resolves on its own schedule.
 */
interface BriefingSlot {
  status: "pending" | "ready";
  assembled: AssembledBriefing | null;
  taken: boolean;
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
  /** Null when injection is off for this proxy or the session is disabled. */
  briefing: BriefingSlot | null;
}

interface TrackedTerminal {
  readonly acpSessionId: string;
  /** Kept to the fingerprint window — output beyond it cannot matter. */
  tail: string;
  /** One fingerprint per terminal, however many exit signals arrive. */
  fired: boolean;
  /** One slice contribution per terminal, for the same reason. */
  sliced: boolean;
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
  intentFires: number;
  ghostPayments: number;
  summarizerFires: number;
  sliceDropped: number;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createAcpCapture = (options: AcpCaptureOptions): AcpCapture => {
  const now = options.now ?? ((): Date => new Date());
  const logger = options.logger;
  const disabled = isDisabled(options.env);
  const injection = options.injection === true && !disabled;

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
    intentFires: 0,
    ghostPayments: 0,
    summarizerFires: 0,
    sliceDropped: 0,
  };

  /** Requests awaiting a response, per originating direction. */
  const pendingClient = createPendingMap(); // c2a requests → a2c responses
  const pendingAgent = createPendingMap(); // a2c requests → c2a responses
  const sessions = new Map<string, CaptureSession>();
  const terminals = new Map<string, TrackedTerminal>();
  // The Tier-1 slice, per session, in memory only (derive/slice.ts).
  const slices = createTurnSliceStore();

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
    briefing: null,
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
    // The finding-#11 gate (core config.ts `loadReportableConfig`): a stored
    // login must not stand in for the missing committed .crosscheck.json —
    // the proxy wraps agents anywhere, and only connected repos may report.
    const config = await loadReportableConfig({
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
      // Detached-aware (trial finding #15): a worktree session is labelled by
      // its branch tip or commit subject — two bounded git calls at most, once.
      title: await resolveFallbackWorkContextTitle(identity),
      status: INITIAL_STATUS,
      now: at,
    });
    const session: CaptureSession = {
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
      briefing: null,
    };
    sessions.set(acpSessionId, session);
    counters.sessions += 1;
    logger.line(
      `capture registered session=${acpSessionId} cc=${registered.crosscheckSessionId} registered=${registered.registered}`,
    );
    if (injection) {
      // §2.5: the briefing is assembled ASYNCHRONOUSLY at session/new capture
      // time and served from cache — this promise is deliberately detached
      // (never awaited on the chain, never on the wire path); the slot flips
      // to "ready" whenever it lands, and the first prompt AFTER that gets
      // the text. A failed prefetch is an empty slot, not an error.
      session.briefing = { status: "pending", assembled: null, taken: false };
      const slot = session.briefing;
      void assembleBriefing({
        hub,
        repoId: identity.repoId,
        repoRoot: identity.root,
        selfDeveloperId: registered.developerId,
        now: now(),
      })
        .then((assembled) => {
          slot.assembled = assembled;
          slot.status = "ready";
          // The ready-signal AFTER the slot flip: whoever observes this line
          // (a harness polling the proxy log instead of sleeping a fixed
          // guess) is guaranteed the next prompt finds the cache ready.
          logger.line(
            `inject briefing-prefetch-ready session=${acpSessionId} chars=${String(assembled.briefing.length)}`,
          );
        })
        .catch((error: unknown) => {
          slot.status = "ready";
          logger.line(`inject briefing-prefetch-error ${describeError(error)}`);
        });
    }
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

  /**
   * Everything a derive trigger needs, and nothing else of the engine —
   * `PromptInjectionView`'s discipline one layer down. Null for a session
   * with no resolved config, which is the same silent skip every other row
   * makes: a disabled session infers nothing, exactly as it captures
   * nothing.
   *
   * `config.agentKind` is the value `producerFor` already stamps on every
   * record (`acp:<agent>`), so a derived draft and a captured target agree
   * about which host produced them — which is the whole point of passing it
   * rather than letting the worker default to `claude-code`.
   */
  const deriveContextFor = (
    session: CaptureSession,
  ): AcpDeriveContext | null =>
    session.config === null
      ? null
      : {
          env: options.env,
          home: session.config.home,
          hostSessionKey: session.hostSessionKey,
          agentKind: session.config.agentKind,
        };

  /** Add one source's text to this session's turn slice, counting drops. */
  const addToSlice = (session: CaptureSession, text: string): void => {
    const slice = slices.for(session.acpSessionId);
    const before = slice.dropped();
    slice.add(text);
    counters.sliceDropped += slice.dropped() - before;
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
    // Release the turn slice FIRST, and before the guard below: a session
    // that ends disabled, or ends twice, must still not leave its text
    // sitting in this process's memory. Nothing reads a slice after the
    // session that produced it is over.
    slices.forget(session.acpSessionId);
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
      const failureText = extractFailureText(toolCall.rawOutput);
      await captureFailureText(session, failureText);
      // Slice source 2. The SAME extracted text the fingerprint uses, so a
      // slice and a fingerprint can never disagree about what failed.
      addToSlice(session, failureText);
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

  /**
   * Slice source 3: what actually ran. Harvested ONCE per terminal, the
   * moment an exit code exists — whatever that code is, because a green
   * suite is half of the gate's red→green flip and a failure-only harvest
   * would make that conclusion structurally unreachable here. The tail is
   * already bounded to FINGERPRINT_SOURCE_CHARS, and the terminal's COMMAND
   * text is not parsed at all, so what lands in the slice is output only.
   */
  const harvestTerminalOutput = (
    terminalId: string,
    exitCode: number | null,
  ): void => {
    if (exitCode === null) {
      return;
    }
    const terminal = terminals.get(terminalId);
    if (terminal === undefined || terminal.sliced) {
      return;
    }
    terminal.sliced = true;
    const session = liveSession(terminal.acpSessionId);
    if (session === null || terminal.tail.length === 0) {
      return;
    }
    addToSlice(session, terminal.tail);
  };

  const trackTerminal = (terminalId: string, acpSessionId: string): void => {
    if (terminals.size >= ACP_MAX_TRACKED_TERMINALS) {
      const oldest = terminals.keys().next();
      if (!oldest.done) {
        terminals.delete(oldest.value);
      }
    }
    terminals.set(terminalId, {
      acpSessionId,
      tail: "",
      fired: false,
      sliced: false,
    });
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
        // THE TURN STARTS HERE: the heartbeat this row always sent, then the
        // two prompt-time rungs. The prompt's TEXT is decoded now — the one
        // thing this file did not do before — and wire/v1.ts's header states
        // where it may go: one 0600 file the intent worker removes as its
        // first act, and nowhere else. It is not logged, not spooled, not
        // written to state, and not read again by anything here.
        const params = parseSessionPromptParams(message.params);
        const session = params === null ? null : liveSession(params.sessionId);
        if (params === null || session === null) {
          return;
        }
        await heartbeat(session, undefined);
        // A new turn: last turn's text is not this turn's evidence. Resetting
        // on the REQUEST rather than after the gate is what keeps the slice a
        // TURN when a turn is cancelled and its response never arrives.
        slices.reset(session.acpSessionId);
        const ctx = deriveContextFor(session);
        if (ctx === null) {
          return;
        }
        if (await maybeSpawnAcpIntentWorker(ctx, params.text)) {
          counters.intentFires += 1;
        }
        // ACP gives this proxy a guaranteed next-prompt event, so the ghost
        // debt is paid exactly where Claude pays it — unlike Cursor, where it
        // had to be claimed by whichever of two handlers fired first.
        if (await maybeSpawnAcpGhostWorker(ctx)) {
          counters.ghostPayments += 1;
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
          harvestTerminalOutput(params.terminalId, output.exitCode);
          await fireTerminalFailure(params.terminalId, output.exitCode);
        }
        return;
      }
      if (request.method === WIRE_METHODS.terminalWaitForExit) {
        const params = parseTerminalIdParams(request.params);
        if (params !== null) {
          const exit = parseTerminalExitResult(message.result);
          harvestTerminalOutput(params.terminalId, exit.exitCode);
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
          // THE TURN BOUNDARY, and now the Tier-1 gate's tick in fact and not
          // only in a comment. The stop reason is still parsed and discarded:
          // a cancelled turn is a turn, and the gate judges the slice it got
          // rather than the reason the turn ended.
          void parseSessionPromptResult(message.result);
          session.turns += 1;
          counters.turns += 1;
          const ctx = deriveContextFor(session);
          if (ctx !== null) {
            const fired = await runAcpSummarizerGate(
              ctx,
              slices.for(session.acpSessionId).text(),
            );
            if (fired) {
              counters.summarizerFires += 1;
            }
          }
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
      if (update === null) {
        return;
      }
      const session = liveSession(update.sessionId);
      if (session === null) {
        return;
      }
      // Slice source 1: what the agent SAID this turn. `agent_thought_chunk`
      // is deliberately not here — wire/v1.ts's `agentText` says why.
      if (update.agentText !== null) {
        addToSlice(session, update.agentText);
      }
      if (update.toolCall !== null) {
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
      // THE DERIVE RUNGS GET THEIR OWN LINE, and `slice-dropped` is the
      // reason it exists rather than a decoration. The other three failure
      // paths are booked in session state and doctor prints them per rung;
      // slice content refused by the byte cap is booked NOWHERE else, and it
      // is the one that silently costs a conclusion — a turn whose verdict
      // arrived past the cap is a miss the gate cannot report, because the
      // gate only ever saw the part that fit.
      logger.line(
        `derive intent-fires=${counters.intentFires} ` +
          `ghost-payments=${counters.ghostPayments} ` +
          `summarizer-fires=${counters.summarizerFires} ` +
          `slice-dropped=${counters.sliceDropped}`,
      );
    },
    counters() {
      return { ...counters };
    },
    promptInjectionView(acpSessionId) {
      const session = liveSession(acpSessionId);
      if (
        session === null ||
        session.hub === null ||
        session.config === null ||
        session.identity === null ||
        session.repoKey === null
      ) {
        return null;
      }
      const hub = session.hub;
      const config = session.config;
      const identity = session.identity;
      const sessionRepoKey = session.repoKey;
      return {
        hostSessionKey: session.hostSessionKey,
        home: config.home,
        repoKey: sessionRepoKey,
        repoId: identity.repoId,
        repoRoot: identity.root,
        agentKind: config.agentKind,
        hub,
        timeoutMs: config.timeoutMs,
        takeBriefing: async (): Promise<BriefingTake> => {
          const slot = session.briefing;
          if (slot === null || slot.taken) {
            return { kind: "none" };
          }
          if (slot.status === "pending") {
            // The design's stated fallback: this prompt gets nothing, the
            // next one finds the cache ready. Never a blocking wait.
            return { kind: "pending" };
          }
          slot.taken = true;
          const assembled = slot.assembled;
          if (assembled === null || assembled.briefing.length === 0) {
            return { kind: "none" };
          }
          // Record-then-emit (the prompt-hook contract): the solved-pointer
          // deliveries are spooled + remembered BEFORE the text leaves the
          // engine; deterministic delivery ids keep a replay duplicate-free.
          await recordBriefingDeliveries({
            home: config.home,
            repoKey: sessionRepoKey,
            hostSessionKey: session.hostSessionKey,
            crosscheckSessionId: session.crosscheckSessionId,
            producer: producerFor(session),
            shownSolvedIds: assembled.shownSolvedIds,
            shownGhostCount: assembled.shownGhostCount,
            now: now(),
          });
          return { kind: "text", text: assembled.briefing };
        },
      };
    },
  };
};
