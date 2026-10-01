/**
 * WHAT EACH CONNECTOR CAN SAY ABOUT ORDER, per canonical kind (1.0 spec 01a
 * §3.6) — derived from the lanes that can produce the kind, and the WEAKEST
 * lane decides. A connector whose Edit lane is bracketed but whose Bash lane
 * is not has an unbracketed `file.modified`, however good the Edit path is.
 *
 * WHY A TABLE OF LANES AND MODULES, NOT A TABLE OF ADJECTIVES. Connectors emit
 * `target` / `claim` / `session` records and the hub projects them to the
 * dotted names (server record-handlers.ts `TARGET_EVENT_KINDS`, `seqKindFor`),
 * so no call site knows its own kind. The table therefore names, per kind,
 * the modules that take the position, and test/guarantee-declarations.test.ts
 * holds it to the code through the import graph in all four directions §3.6
 * lists. The `guarantee` / `reason` stated on each row are the declaration a
 * session sends (`guaranteeDeclarationFor`); the check refuses any row whose
 * statement is not exactly the fold of its lanes.
 *
 * Every row below was re-derived from the code on 2026-10-01, and each lane's
 * comment names the line that decides it. §3.6's table was the starting
 * point; where the code disagrees with it, the code wins and 01a §13 says so.
 */
import { GUARANTEE_KINDS, GUARANTEE_OF_REASON } from "@crosscheck/schema";
import type {
  CausalGuarantee,
  CausalGuaranteeReason,
  CausalGuaranteeTriple,
  GuaranteeKind,
} from "@crosscheck/schema";

import { DEFAULT_AGENT_KIND } from "../constants.ts";
import { ACP_AGENT_KIND_PREFIX, CURSOR_AGENT_KIND } from "../state/host-session-key.ts";

/**
 * HOW A LANE POSITIONS ITS RECORD, and what that lets the hub say.
 *
 *   pre_tool_bracketed    — a PreToolUse opened the window before the tool ran
 *                           and the post hook closes it (`openToolWindow` +
 *                           connector-core's `allocateToolSeq`); stored emitted.
 *   lifecycle             — the session's origin (n = 0) or its terminal
 *                           position, with no tool to race.
 *   post_tool_unbracketed — a hook positions after the tool returned with no
 *                           window; the hub stores it observed.
 *   observing             — a lane that sees a state, not an act (the Stop git
 *                           diff, the SessionStart commit aggregate); observed.
 *   derived_worker        — a detached worker writes down, later, a record about
 *                           an earlier slice; the hub stores it observed.
 *   mcp_tool              — an agent's own MCP call; emitted, but the session
 *                           picker's ambiguity (01 D1) can withhold the position.
 */
export const GUARANTEE_LANES = [
  "pre_tool_bracketed",
  "lifecycle",
  "post_tool_unbracketed",
  "observing",
  "derived_worker",
  "mcp_tool",
] as const;

export type GuaranteeLane = (typeof GUARANTEE_LANES)[number];

const LANE_REASON: Readonly<Record<GuaranteeLane, CausalGuaranteeReason>> = {
  pre_tool_bracketed: "bracketed_by_pre_tool",
  lifecycle: "lifecycle",
  post_tool_unbracketed: "unbracketed_lane",
  observing: "observed_lane_only",
  derived_worker: "derived_after_the_fact",
  mcp_tool: "ambiguous_session_possible",
};

/**
 * EVERY REASON, WEAKEST FIRST — the order the fold resolves ties in. A
 * reason's state is fixed by GUARANTEE_OF_REASON, and this list keeps the
 * states in CAUSAL_GUARANTEES' order, so ranking by reason alone never lets a
 * weaker state outrank a stronger one. Inside `partial` the derived worker is
 * weakest (§3.6: "the summarizer's claims are a weaker lane than MCP
 * ambiguity"), then the unbracketed and observing lanes, whose positions are
 * upper bounds, then the MCP lane, whose positions are emitted when present.
 */
export const REASON_STRENGTH: readonly CausalGuaranteeReason[] = [
  "provider_undeclared",
  "not_built",
  "no_emitter",
  "derived_after_the_fact",
  "unbracketed_lane",
  "observed_lane_only",
  "ambiguous_session_possible",
  "bracketed_by_pre_tool",
  "lifecycle",
];

const strengthOf = (reason: CausalGuaranteeReason): number => REASON_STRENGTH.indexOf(reason);

export interface LaneProducers {
  readonly lane: GuaranteeLane;
  /** Repo-relative paths of the modules that take this lane's positions. */
  readonly modules: readonly string[];
}

/** One `(connector, kind)` row: the declaration it sends and the lanes it rests on. */
export interface KindLanes {
  readonly guarantee: CausalGuarantee;
  readonly reason: CausalGuaranteeReason;
  readonly lanes: readonly LaneProducers[];
}

export interface GuaranteeReading {
  readonly guarantee: CausalGuarantee;
  readonly reason: CausalGuaranteeReason;
}

/**
 * An observing lane is `observed_lane_only` only when EVERY lane of the kind
 * observes; beside a tool lane it is one lane among several that positions
 * after the fact, which is `unbracketed_lane` — the reason has to be
 * literally true of the kind, not of the lane.
 */
const laneReading = (
  lane: GuaranteeLane,
  lanes: readonly LaneProducers[],
): GuaranteeReading => {
  const reason =
    lane === "observing" && lanes.some((other) => other.lane !== "observing")
      ? "unbracketed_lane"
      : LANE_REASON[lane];
  return { guarantee: GUARANTEE_OF_REASON[reason], reason };
};

/**
 * THE WEAKEST-LANE FOLD. Null for a kind no lane produces: what that is —
 * `no_emitter` or `not_built` — is a fact about the product, not about lanes,
 * so the row states it and the check confirms it is one of the two.
 */
export const foldLanes = (lanes: readonly LaneProducers[]): GuaranteeReading | null =>
  lanes
    .map((entry) => laneReading(entry.lane, lanes))
    .reduce<GuaranteeReading | null>(
      (weakest, reading) =>
        weakest === null || strengthOf(reading.reason) < strengthOf(weakest.reason)
          ? reading
          : weakest,
      null,
    );

export const ACP_CONNECTOR = `${ACP_AGENT_KIND_PREFIX}*` as const;

export const GUARANTEE_CONNECTORS = [DEFAULT_AGENT_KIND, CURSOR_AGENT_KIND, ACP_CONNECTOR] as const;

export type GuaranteeConnector = (typeof GUARANTEE_CONNECTORS)[number];

export type ConnectorTable = Readonly<Record<GuaranteeKind, KindLanes>>;

const CLAUDE = "packages/connector-claude/src";
const CURSOR = "packages/connector-cursor/src";
const ACP = "packages/connector-acp/src";
const CORE = "packages/connector-core/src";

/**
 * THE MCP SERVER'S ENTRY, which no connector imports: every host launches it
 * as `crosscheck mcp` (cli/src/bin/crosscheck.ts) from the entry its install
 * writes — Claude's settings, Cursor's mcp.json (init/init.ts), ACP's
 * session/new injection (inject/injector.ts). The check walks the MCP lane's
 * reachability from here.
 */
export const MCP_SERVER_MODULE = `${CORE}/mcp/server.ts`;

/**
 * Modules that call a core allocator only to hand the service on: the MCP
 * helper `allocateToolSeq` (mcp/tools/shared.ts:253) wraps `allocateSeq` with
 * the session picker's refusal. Its callers are mapped; it is not.
 */
export const ALLOCATOR_WRAPPERS: readonly string[] = [`${CORE}/mcp/tools/shared.ts`];

const REGISTER_FLOW = `${CORE}/flows/register-session.ts`;
const END_FLOW = `${CORE}/flows/end-session.ts`;
const MCP_CLAIMS = [
  `${CORE}/mcp/tools/publish-claim.ts`,
  `${CORE}/mcp/tools/review-draft.ts`,
  `${CORE}/mcp/tools/extend-diagnosis.ts`,
];
/** review_draft's `supersedes` edge and extend_diagnosis's edge kind (server INVALIDATING_EDGE_KINDS). */
const MCP_EDGES = [`${CORE}/mcp/tools/review-draft.ts`, `${CORE}/mcp/tools/extend-diagnosis.ts`];
const MCP_INTENT = [`${CORE}/mcp/tools/set-intent.ts`];
const DERIVED_CLAIMS = [`${CORE}/derive/summarizer/derive.ts`, `${CORE}/derive/ghost/worker.ts`];
const DERIVED_INTENT = [`${CORE}/derive/intent/worker.ts`];

const row = (lanes: readonly LaneProducers[], absent?: CausalGuaranteeReason): KindLanes => {
  const reading = foldLanes(lanes) ?? { guarantee: "unavailable", reason: absent ?? "no_emitter" };
  return { ...reading, lanes };
};

const lane = (name: GuaranteeLane, modules: readonly string[]): LaneProducers => ({
  lane: name,
  modules,
});

/** The kinds every host shares through connector-core's flows, MCP tools and workers. */
const sharedKinds = {
  // register-session.ts:160 sends `seq: { epoch, n: 0 }` — the origin, allocated by nobody.
  "session.started": row([lane("lifecycle", [REGISTER_FLOW])]),
  // end-session.ts:86 allocates the end BEFORE the state delete, so nothing can follow it.
  "session.ended": row([lane("lifecycle", [END_FLOW])]),
  "claim.created": row([lane("mcp_tool", MCP_CLAIMS), lane("derived_worker", DERIVED_CLAIMS)]),
  // No worker writes an edge; only the two MCP tools do.
  "claim.invalidated": row([lane("mcp_tool", MCP_EDGES)]),
  // set_intent declares; the derived worker writes v1 or amends a derived head
  // (server record-handlers.ts mergeIntent: derived never replaces declared).
  "intent.declared": row([lane("mcp_tool", MCP_INTENT), lane("derived_worker", DERIVED_INTENT)]),
  "intent.amended": row([lane("mcp_tool", MCP_INTENT), lane("derived_worker", DERIVED_INTENT)]),
} as const;

const CLAUDE_POST_TOOL = `${CLAUDE}/hooks/post-tool-use.ts`;
const CLAUDE_PRE_TOOL = `${CLAUDE}/hooks/pre-tool-use.ts`;

const claudeTable: ConnectorTable = {
  ...sharedKinds,
  // Edit-family calls are bracketed (pre-tool-use.ts:188 opens, post-tool-use.ts:280
  // closes); Bash is in POST_TOOL_USE_MATCHER and not PRE_TOOL_USE_MATCHER
  // (constants.ts:1630-1632), and the Stop git lane (stop.ts:186) observes.
  "file.modified": row([
    lane("pre_tool_bracketed", [CLAUDE_PRE_TOOL, CLAUDE_POST_TOOL]),
    lane("post_tool_unbracketed", [CLAUDE_POST_TOOL]),
    lane("observing", [`${CLAUDE}/hooks/stop.ts`]),
  ]),
  // A failed Edit's fingerprint rides post-tool-use.ts's bracketed block; a
  // failed Bash has no window, and post-tool-use-failure.ts:118 keeps the
  // position and drops the bracket on purpose.
  "tool.failed": row([
    lane("pre_tool_bracketed", [CLAUDE_PRE_TOOL, CLAUDE_POST_TOOL]),
    lane("post_tool_unbracketed", [CLAUDE_POST_TOOL, `${CLAUDE}/hooks/post-tool-use-failure.ts`]),
  ]),
  // session-start.ts:361 positions the commit aggregate, and the hub stores it
  // observed unconditionally (server commit-evidence.ts:150).
  "commit.observed": row([lane("observing", [`${CLAUDE}/hooks/session-start.ts`])]),
};

const cursorTable: ConnectorTable = {
  ...sharedKinds,
  // Cursor registers no pre-tool handler (capabilities.ts event_seq sentence)
  // and runs no Stop git lane: one unbracketed lane.
  "file.modified": row([lane("post_tool_unbracketed", [`${CURSOR}/handlers/file-edit.ts`])]),
  "tool.failed": row([
    lane("post_tool_unbracketed", [
      `${CURSOR}/handlers/post-tool-use.ts`,
      `${CURSOR}/handlers/shell.ts`,
      `${CURSOR}/handlers/tool-failure.ts`,
    ]),
  ]),
  // collectCommitEvidence has one caller, connector-claude's SessionStart.
  "commit.observed": row([], "no_emitter"),
};

const ACP_ENGINE = `${ACP}/capture/engine.ts`;

const acpTable: ConnectorTable = {
  ...sharedKinds,
  // engine.ts:713 positions an edit off the first wire row that names its file
  // — often the pending tool_call, before the edit — with no window: neither
  // bound holds, and the hub stores it observed.
  "file.modified": row([lane("post_tool_unbracketed", [ACP_ENGINE])]),
  "tool.failed": row([lane("post_tool_unbracketed", [ACP_ENGINE])]),
  "commit.observed": row([], "no_emitter"),
};

export const DECLARATION_TABLE: Readonly<Record<GuaranteeConnector, ConnectorTable>> = {
  "claude-code": claudeTable,
  "cursor-ide": cursorTable,
  "acp:*": acpTable,
};

export interface DeclarationRow extends KindLanes {
  readonly kind: GuaranteeKind;
}

/** The connector's rows in GUARANTEE_KINDS order — what doctor prints. */
export const declarationRowsFor = (connector: GuaranteeConnector): readonly DeclarationRow[] =>
  GUARANTEE_KINDS.map((kind) => ({ kind, ...DECLARATION_TABLE[connector][kind] }));

/** The block a session sends on register: nine enum triples, nothing else. */
export const guaranteeDeclarationFor = (
  connector: GuaranteeConnector,
): readonly CausalGuaranteeTriple[] =>
  declarationRowsFor(connector).map(({ kind, guarantee, reason }) => ({
    kind,
    guarantee,
    reason,
  }));

/** The connector a session's agent kind declares as: any `acp:<agent>` is ACP's row. */
export const guaranteeConnectorOf = (agentKind: string): GuaranteeConnector | null => {
  if (agentKind.startsWith(ACP_AGENT_KIND_PREFIX)) {
    return ACP_CONNECTOR;
  }
  return GUARANTEE_CONNECTORS.find((connector) => connector === agentKind) ?? null;
};
