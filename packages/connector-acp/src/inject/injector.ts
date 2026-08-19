/**
 * The Block-5 injection decision engine (design §2.5): exactly two write
 * points on the client→agent wire, both fail-open, both version-gated.
 *
 *   1. `session/new` / `session/load` / `session/resume`: append ONE owned
 *      mcpServers entry (inject/launcher.ts) — only when the params already
 *      carry an mcpServers ARRAY (open question 3's conservative default: a
 *      field the client did not send is a field we do not invent), only for
 *      a cwd that resolves to a crosscheck-connected repo (an unconnected
 *      directory stays a pure pipe — prime directive 1), and never past an
 *      existing entry named `crosscheck` (owned or foreign: appending a
 *      second server of the same name shadows somebody — skip, log which).
 *   2. `session/prompt`: append ONE trailing text ContentBlock — the cached
 *      briefing on the first prompt it is ready for, the hint flow
 *      afterwards, under the UserPromptSubmit budget constants. The user's
 *      own blocks are never edited or reordered (append-don't-edit).
 *
 * EVERY skip forwards the original bytes. Every skip that SUPPRESSES an
 * intended injection says why in the proxy log; the one exception is the
 * hint path's routine no-candidates silence, which counts in `skips`
 * without a log line (silence is the flow's normal outcome, not a
 * suppressed delivery — one line per quiet prompt would be noise).
 * A budget race lost mid-hint leaves the flow to finish in the background:
 * the slot is spent, the text unshown — the same lost-slot honesty as the
 * Claude runner's race (flows/hint.ts header), never a repeat delivery.
 *
 * PRIVACY: prompt text is decoded only as the hint flow's EPHEMERAL query
 * (Block 4's pin extends here) — never stored, never logged; log lines
 * carry shaped session ids and reasons only.
 *
 * VERSION GATE (§2.3 rule 7): the injector watches the initialize exchange
 * itself (its own tiny pending set — the capture engine's pending maps stay
 * capture's). No decided version, or version ≠ 1 → every decision is
 * "forward", with one log line and one stderr notice for the mismatch.
 */
import {
  MCP_SERVER_NAME,
  USER_PROMPT_SUBMIT_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import { isOwnedMcpEntry } from "@crosscheck/connector-core/config/mcp-config.ts";
import { loadConfig, resolveTimeoutMs } from "@crosscheck/connector-core/config/config.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { selectAndRenderHint } from "@crosscheck/connector-core/flows/hint.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";

import {
  ACP_INJECT_CWD_CACHE_MAX,
  ACP_PROMPT_SETTLE_WAIT_MS,
  ACP_SESSION_SETUP_INJECT_BUDGET_MS,
} from "../constants.ts";
import type { AcpCapture } from "../capture/engine.ts";
import type { AcpLogger } from "../logger.ts";
import type { ObservedLine } from "../observer.ts";
import {
  ACP_PROTOCOL_VERSION,
  WIRE_METHODS,
  classifyWireMessage,
  parseInitializeResult,
  parseSessionIdParams,
} from "../wire/v1.ts";
import type { WireId } from "../wire/v1.ts";
import { acpPromptBlockText } from "./blocks.ts";
import { hasLossyNumberToken } from "./json-guard.ts";
import { resolveAcpMcpServer } from "./launcher.ts";
import type { AcpMcpServerResolution } from "./launcher.ts";
import type { LineDecision } from "./line-pump.ts";

/** Initialize requests awaiting a response — one per connection, capped. */
const INIT_PENDING_MAX = 8;

/** The three session-setup methods whose params carry mcpServers. */
const SETUP_METHODS: ReadonlySet<string> = new Set([
  WIRE_METHODS.sessionNew,
  WIRE_METHODS.sessionLoad,
  WIRE_METHODS.sessionResume,
]);

export interface AcpInjectorOptions {
  readonly env: Env;
  readonly logger: AcpLogger;
  readonly capture: AcpCapture;
  /** The running entry script (Bun.main in the proxy; a fixture in tests). */
  readonly entryPath: string;
  /** Injectable clock for deterministic budget tests. */
  readonly now?: () => number;
  /** Injectable stderr for the one version-mismatch notice. */
  readonly notify?: (line: string) => void;
}

export interface AcpInjectorCounters {
  readonly mcpAppends: number;
  readonly briefings: number;
  readonly hints: number;
  readonly skips: number;
}

export interface AcpInjector {
  /** The line-pump handler: one COMPLETE c2a line in, decision out. */
  decideLine(text: string): Promise<LineDecision>;
  /** Fed from the a2c observer path — watches the initialize response. */
  offerA2c(event: ObservedLine): void;
  counters(): AcpInjectorCounters;
  /** One bounded summary line into the proxy log. */
  summarize(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The entry's wire name, for the conflict scan. */
const entryName = (entry: unknown): string | null => {
  if (!isRecord(entry)) {
    return null;
  }
  const name = entry["name"];
  return typeof name === "string" ? name : null;
};

/** Joined text of the prompt's text blocks — the hint flow's ephemeral query. */
const promptQueryOf = (prompt: readonly unknown[]): string =>
  prompt
    .filter(isRecord)
    .filter((block) => block["type"] === "text")
    .map((block) => block["text"])
    .filter((text): text is string => typeof text === "string")
    .join("\n");

/** Race a promise against a deadline; null when the deadline wins. */
const raceBudget = async <T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<T | null> => {
  if (budgetMs <= 0) {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, budgetMs);
  });
  const outcome = await Promise.race([work, bounded]);
  clearTimeout(timer);
  return outcome;
};

export const createAcpInjector = (options: AcpInjectorOptions): AcpInjector => {
  const { env, logger, capture } = options;
  const now = options.now ?? ((): number => Date.now());
  const notify =
    options.notify ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  // The UserPromptSubmit budget constants, reused (design §2.5): ratio ×
  // the per-request timeout (env override honored; the stored-config
  // override is per-session and the prompt path re-reads nothing per line).
  const promptBudgetMs =
    USER_PROMPT_SUBMIT_BUDGET_RATIO * resolveTimeoutMs(env, null);

  const counters = { mcpAppends: 0, briefings: 0, hints: 0, skips: 0 };

  // The launcher, resolved once, kicked off at construction. A session/new
  // arriving before it settles AWAITS it under the setup budget rather than
  // skipping: an editor's very first session/new lands milliseconds after
  // spawn — while the `--version` identity probe may still be running — and
  // that first session is exactly the one the tools are for.
  const launcherPromise: Promise<AcpMcpServerResolution> = resolveAcpMcpServer(
    env,
    options.entryPath,
  )
    .then((resolution) => {
      if (resolution.kind === "refused") {
        logger.line(`inject launcher-refused ${resolution.reason}`);
      }
      return resolution;
    })
    .catch((error: unknown) => {
      logger.line(`inject launcher-error ${String(error)}`);
      return { kind: "refused" as const, reason: String(error) };
    });

  // ── version gate ──────────────────────────────────────────────────────────
  const pendingInit = new Set<WireId>();
  let negotiated: number | null = null;
  let gateDecided = false;
  let mismatchNotified = false;

  const gateOpen = (): boolean => gateDecided && negotiated === ACP_PROTOCOL_VERSION;

  const skip = (why: string, sessionId?: string): null => {
    counters.skips += 1;
    logger.line(
      `inject skip why=${why}${sessionId === undefined ? "" : ` session=${sessionId}`}`,
    );
    return null;
  };

  // ── the conservative connected-cwd probe (bounded, cached) ───────────────
  // Cached for the proxy's LIFETIME, never invalidated (bounded FIFO only): a
  // repo disconnected mid-run keeps its stale `true` and may still receive
  // mcpServers appends while capture — which re-resolves per register — goes
  // silent. Accepted: the appended entry is inert without a connected config,
  // and connect/disconnect mid-session is an operator action a proxy restart
  // already resolves.
  const cwdConnected = new Map<string, boolean>();

  const probeCwd = async (cwd: string): Promise<boolean> => {
    const identity = await resolveRepoIdentity(cwd);
    if (identity === null) {
      return false;
    }
    const config = await loadConfig({ env, repoRoot: identity.root });
    return config !== null;
  };

  const isConnectedCwd = async (
    cwd: string,
    budgetMs: number,
  ): Promise<boolean | null> => {
    const cached = cwdConnected.get(cwd);
    if (cached !== undefined) {
      return cached;
    }
    const probe = probeCwd(cwd).then((connected) => {
      if (cwdConnected.size >= ACP_INJECT_CWD_CACHE_MAX) {
        const oldest = cwdConnected.keys().next();
        if (!oldest.done) {
          cwdConnected.delete(oldest.value);
        }
      }
      cwdConnected.set(cwd, connected);
      return connected;
    });
    // The race leaves the probe to finish and fill the cache for the NEXT
    // message; this one skips (fail open) if the budget is blown.
    return raceBudget(probe, budgetMs);
  };

  // ── write point 1: mcpServers append ─────────────────────────────────────
  const decideSetup = async (
    record: Record<string, unknown>,
    method: string,
  ): Promise<LineDecision> => {
    if (!gateOpen()) {
      return skip("version-gate");
    }
    const params = record["params"];
    if (!isRecord(params)) {
      return skip("no-params");
    }
    const servers = params["mcpServers"];
    if (!Array.isArray(servers)) {
      // Open question 3, conservative default: only APPEND to an array the
      // client already sent — never invent the field.
      return skip("no-mcpservers-array");
    }
    const cwd = params["cwd"];
    if (typeof cwd !== "string" || cwd.length === 0) {
      return skip("no-cwd");
    }
    // ONE deadline for the whole setup decision: launcher settle, then the
    // connected-cwd probe, whatever is left. Blown → skip, never a stall.
    const deadline = now() + ACP_SESSION_SETUP_INJECT_BUDGET_MS;
    const mcpServer = await raceBudget(launcherPromise, deadline - now());
    if (mcpServer === null) {
      return skip("launcher-pending");
    }
    if (mcpServer.kind === "refused") {
      return skip("launcher-refused");
    }
    const connected = await isConnectedCwd(cwd, deadline - now());
    if (connected === null) {
      return skip("setup-budget");
    }
    if (!connected) {
      return skip("unconnected-cwd");
    }
    const conflict = servers.find((entry) => entryName(entry) === MCP_SERVER_NAME);
    if (conflict !== undefined) {
      // Owned or foreign, never clobber and never shadow: an owned entry
      // means the tools are already there; a foreign one is the user's.
      return skip(
        isOwnedMcpEntry(conflict) ? "already-present" : "foreign-crosscheck-entry",
      );
    }
    counters.mcpAppends += 1;
    logger.line(`inject mcp method=${method} entries=${servers.length + 1}`);
    return JSON.stringify({
      ...record,
      params: { ...params, mcpServers: [...servers, mcpServer.entry] },
    });
  };

  // ── write point 2: the prompt block ──────────────────────────────────────
  const decidePrompt = async (
    record: Record<string, unknown>,
  ): Promise<LineDecision> => {
    if (!gateOpen()) {
      return skip("version-gate");
    }
    const deadline = now() + promptBudgetMs;
    const params = record["params"];
    if (!isRecord(params)) {
      return skip("no-params");
    }
    const sessionParams = parseSessionIdParams(params);
    if (sessionParams === null) {
      return skip("no-session-id");
    }
    const sessionId = sessionParams.sessionId;
    const prompt = params["prompt"];
    if (!Array.isArray(prompt)) {
      // Spec-legal prompts are block arrays; anything else we cannot append
      // to without editing — skip (append-don't-edit).
      return skip("no-prompt-array", sessionId);
    }
    // Registration rides the capture chain; a first prompt racing it gets a
    // bounded settle, never an open wait (ACP_PROMPT_SETTLE_WAIT_MS).
    if (capture.promptInjectionView(sessionId) === null) {
      await raceBudget(
        capture.settle(),
        Math.min(ACP_PROMPT_SETTLE_WAIT_MS, deadline - now()),
      );
    }
    const view = capture.promptInjectionView(sessionId);
    if (view === null) {
      return skip("unknown-session", sessionId);
    }

    const appendBlock = (text: string): string =>
      JSON.stringify({
        ...record,
        params: {
          ...params,
          prompt: [...prompt, { type: "text", text: acpPromptBlockText(text) }],
        },
      });

    const take = await view.takeBriefing();
    if (take.kind === "pending") {
      // The design's fallback: the next prompt gets it — no blocking wait.
      return skip("briefing-pending", sessionId);
    }
    if (take.kind === "text") {
      counters.briefings += 1;
      logger.line(`inject briefing session=${sessionId} chars=${take.text.length}`);
      return appendBlock(take.text);
    }

    // Hint path — the whole §4 pipeline is the shared core flow, raced
    // against what is left of the prompt budget. A race lost here spends
    // the slot without showing the text (see the module header).
    const remaining = deadline - now();
    if (remaining <= 0) {
      return skip("budget", sessionId);
    }
    const text = await raceBudget(
      selectAndRenderHint({
        home: view.home,
        repoKey: view.repoKey,
        hub: view.hub,
        hostSessionKey: view.hostSessionKey,
        repoId: view.repoId,
        repoRoot: view.repoRoot,
        agentKind: view.agentKind,
        prompt: promptQueryOf(prompt),
        now: new Date(now()),
      }),
      remaining,
    );
    if (text === null) {
      return skip("budget", sessionId);
    }
    if (text.length === 0) {
      // Silence is not a skip worth logging per prompt — it is the normal
      // no-candidates outcome; count it, no log noise.
      counters.skips += 1;
      return null;
    }
    counters.hints += 1;
    logger.line(`inject hint session=${sessionId} chars=${text.length}`);
    return appendBlock(text);
  };

  return {
    async decideLine(text) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return null; // not a message — forward verbatim (§2.3 rule 4)
      }
      const message = classifyWireMessage(value);
      if (message === null || message.kind !== "request") {
        // Notifications (session/cancel included) and responses pass with
        // zero added await — nothing here is on the cancel path.
        return null;
      }
      const record = value as Record<string, unknown>;
      if (message.method === WIRE_METHODS.initialize) {
        if (pendingInit.size < INIT_PENDING_MAX) {
          pendingInit.add(message.id);
        }
        return null;
      }
      const isSetup = SETUP_METHODS.has(message.method);
      if (!isSetup && message.method !== WIRE_METHODS.sessionPrompt) {
        return null;
      }
      // §2.3 rule 1's edit exception is VALUE-preserving or it is nothing: a
      // raw number JSON.parse would round (a 64-bit id past 2^53) or replace
      // (past double range → Infinity → `null`) makes the line uneditable —
      // forward the original bytes (json-guard.ts).
      if (hasLossyNumberToken(text)) {
        return skip("lossy-reserialize");
      }
      return isSetup ? decideSetup(record, message.method) : decidePrompt(record);
    },

    offerA2c(event) {
      if (gateDecided || !event.parsedOk || pendingInit.size === 0) {
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(event.text);
      } catch {
        return;
      }
      const message = classifyWireMessage(value);
      if (message === null || message.kind !== "response" || !pendingInit.has(message.id)) {
        return;
      }
      pendingInit.delete(message.id);
      if (message.isError) {
        return; // a failed initialize decides nothing; the client retries
      }
      negotiated = parseInitializeResult(message.result).protocolVersion;
      gateDecided = true;
      if (!gateOpen() && !mismatchNotified) {
        mismatchNotified = true;
        logger.line(
          `inject off protocol=${negotiated ?? "none"} != ${ACP_PROTOCOL_VERSION}`,
        );
        notify(
          `crosscheck acp: protocol version ${negotiated ?? "unknown"} != ${ACP_PROTOCOL_VERSION} — injection disabled for this connection\n`,
        );
      }
    },

    counters() {
      return { ...counters };
    },

    summarize() {
      logger.line(
        `inject mcp=${counters.mcpAppends} briefings=${counters.briefings} ` +
          `hints=${counters.hints} skips=${counters.skips}`,
      );
    },
  };
};
