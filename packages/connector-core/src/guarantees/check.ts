/**
 * THE JUDGEMENT HALF OF THE DECLARED-GUARANTEE BUILD CHECK (01a §3.6) — pure,
 * so test/guarantee-declarations.test.ts can feed it the facts it scanned from
 * the import graph AND tables built to break each rule. It returns one line
 * per violation; an empty list is the only passing answer.
 *
 * The four directions §3.6 lists, and two this build added because the first
 * four could be satisfied by a table naming the right modules under the wrong
 * kind:
 *   1. positions ⇄ map — every allocating module is mapped, every mapped one allocates;
 *   2. bracketed means bracketed — no producing module outside a pre-tool lane;
 *   3. no producer means unavailable — `no_emitter` or `not_built`, nothing stronger;
 *   4. the map agrees with the hub's projection;
 *   5. a module is listed under a kind only if its source builds that kind;
 *   6. a stated declaration is exactly the weakest-lane fold of its lanes.
 */
import { GUARANTEE_KINDS } from "@crosscheck/schema";
import type { GuaranteeKind, SeqKind } from "@crosscheck/schema";

import { ALLOCATOR_WRAPPERS, foldLanes } from "./declarations.ts";
import type {
  ConnectorTable,
  GuaranteeConnector,
  GuaranteeLane,
  KindLanes,
} from "./declarations.ts";

/** connector-core's three, and the MCP helper that shares a name (mcp/tools/shared.ts). */
export type AllocatorName =
  | "allocateSeq"
  | "allocateToolSeq"
  | "openToolWindow"
  | "mcp:allocateToolSeq";

export interface ModuleFacts {
  readonly path: string;
  readonly allocators: readonly AllocatorName[];
  /** The kinds this module's source proves it builds a record of. */
  readonly evidence: readonly string[];
  /** It sends the origin position `{ epoch, n: 0 }` without allocating. */
  readonly origin: boolean;
}

export interface ConnectorFacts {
  readonly connector: GuaranteeConnector;
  /** e.g. `packages/connector-claude` — the modules this connector owns. */
  readonly packageDir: string;
  /** Every module this connector's processes can run (import closure + the MCP server's). */
  readonly reachable: ReadonlySet<string>;
  /** Host tools whose post hook fires with no pre hook to open a window. */
  readonly toolsWithoutPreBracket: readonly string[];
}

export interface ProjectionFacts {
  /** The hub's `TARGET_EVENT_KINDS` values — the kinds a target record projects to. */
  readonly targetKinds: readonly string[];
  /** What the hub's `seqKindFor` stores for a target record from this lane; null off target lanes. */
  readonly seqKindOfLane: (lane: GuaranteeLane) => SeqKind | null;
}

type Table = Readonly<Record<GuaranteeConnector, ConnectorTable>>;
type Facts = ReadonlyMap<string, ModuleFacts>;

const TARGET_LANES: ReadonlySet<GuaranteeLane> = new Set([
  "pre_tool_bracketed",
  "post_tool_unbracketed",
  "observing",
]);
const LIFECYCLE_KINDS: ReadonlySet<string> = new Set(["session.started", "session.ended"]);
const ABSENT_REASONS: ReadonlySet<string> = new Set(["no_emitter", "not_built"]);
const WRAPPERS: ReadonlySet<string> = new Set(ALLOCATOR_WRAPPERS);

const takesPosition = (facts: ModuleFacts | undefined): boolean =>
  facts !== undefined && facts.allocators.length > 0;

const isOpenerOnly = (facts: ModuleFacts | undefined): boolean =>
  facts !== undefined &&
  facts.allocators.length > 0 &&
  facts.allocators.every((name) => name === "openToolWindow");

const modulesOf = (row: KindLanes | undefined): readonly string[] =>
  row === undefined ? [] : [...new Set(row.lanes.flatMap((entry) => entry.modules))];

const modulesInLane = (row: KindLanes, lane: GuaranteeLane): ReadonlySet<string> =>
  new Set(row.lanes.filter((entry) => entry.lane === lane).flatMap((entry) => entry.modules));

/** Directions 3 and 6: no producer ⇒ unavailable; producers ⇒ exactly the fold. */
const statementViolations = (where: string, row: KindLanes): readonly string[] => {
  const folded = foldLanes(row.lanes.filter((entry) => entry.modules.length > 0));
  if (folded === null) {
    return row.guarantee === "unavailable" && ABSENT_REASONS.has(row.reason)
      ? []
      : [`${where}: no producing module, yet declared ${row.guarantee} / ${row.reason}`];
  }
  return folded.guarantee === row.guarantee && folded.reason === row.reason
    ? []
    : [
        `${where}: declared ${row.guarantee} / ${row.reason}, but its weakest lane reads ${folded.guarantee} / ${folded.reason}`,
      ];
};

/** Direction 2: `guaranteed / bracketed_by_pre_tool` admits no other lane. */
const bracketedDeclarationViolations = (where: string, row: KindLanes): readonly string[] =>
  row.reason !== "bracketed_by_pre_tool"
    ? []
    : row.lanes
        .filter((entry) => entry.lane !== "pre_tool_bracketed")
        .flatMap((entry) => entry.modules)
        .map(
          (module) =>
            `${where}: declared bracketed, with ${module} outside a pre-tool-bracketed lane`,
        );

/**
 * A bracketed lane needs a module that opens the window and modules that
 * close it; and a closer whose post hook also fires for tools no pre hook
 * matches (Claude's Bash) positions those calls unbracketed — so it must be
 * listed in an unbracketed lane of the same kind as well.
 */
const bracketLaneViolations = (
  where: string,
  row: KindLanes,
  facts: Facts,
  connector: ConnectorFacts,
): readonly string[] => {
  const bracketed = [...modulesInLane(row, "pre_tool_bracketed")];
  if (bracketed.length === 0) {
    return [];
  }
  const opens = bracketed.some((module) => facts.get(module)?.allocators.includes("openToolWindow"));
  const closers = bracketed.filter((module) => !isOpenerOnly(facts.get(module)));
  const unbracketed = modulesInLane(row, "post_tool_unbracketed");
  const leaky = connector.toolsWithoutPreBracket.join("|");
  return [
    ...(opens ? [] : [`${where}: a bracketed lane with no module that opens a window`]),
    ...closers
      .filter((module) => facts.get(module)?.allocators.includes("allocateToolSeq") !== true)
      .map((module) => `${where}: ${module} is in a bracketed lane and closes no window`),
    ...(leaky.length === 0
      ? []
      : closers
          .filter((module) => !unbracketed.has(module))
          .map(
            (module) =>
              `${where}: ${module} also positions ${leaky} with no pre-tool window and is in no unbracketed lane`,
          )),
  ];
};

/** Direction 4 for the target kinds: the lane's reading is what `seqKindFor` stores. */
const projectionViolations = (
  where: string,
  kind: string,
  row: KindLanes,
  projection: ProjectionFacts,
): readonly string[] =>
  !projection.targetKinds.includes(kind)
    ? []
    : row.lanes.flatMap((entry) => {
        if (!TARGET_LANES.has(entry.lane)) {
          return [`${where}: a ${entry.lane} lane cannot produce a target record`];
        }
        const stored = projection.seqKindOfLane(entry.lane);
        const promised = entry.lane === "pre_tool_bracketed" ? "emitted" : "observed";
        return stored === promised
          ? []
          : [
              `${where}: the hub stores a ${entry.lane} position ${String(stored)}, the table reads ${promised}`,
            ];
      });

/** Direction 5: a module is under a kind only if its source builds that kind. */
const evidenceViolations = (
  where: string,
  kind: string,
  row: KindLanes,
  facts: Facts,
): readonly string[] =>
  row.lanes.flatMap((entry) =>
    entry.modules.flatMap((module) => {
      if (entry.lane === "lifecycle") {
        return LIFECYCLE_KINDS.has(kind) ? [] : [`${where}: a lifecycle lane on a non-lifecycle kind`];
      }
      const known = facts.get(module);
      if (entry.lane === "pre_tool_bracketed" && isOpenerOnly(known)) {
        return [];
      }
      return known?.evidence.includes(kind) === true
        ? []
        : [`${where}: ${module} does not build ${kind}`];
    }),
  );

/** session.started is the origin module; session.ended's modules allocate. */
const lifecycleViolations = (
  where: string,
  kind: string,
  row: KindLanes,
  facts: Facts,
): readonly string[] =>
  [...modulesInLane(row, "lifecycle")].flatMap((module) => {
    const known = facts.get(module);
    const holds = kind === "session.started" ? known?.origin === true : takesPosition(known);
    return holds ? [] : [`${where}: ${module} holds no ${kind} position`];
  });

const rowViolations = (
  connector: ConnectorFacts,
  kind: string,
  row: KindLanes,
  facts: Facts,
  projection: ProjectionFacts,
): readonly string[] => {
  const where = `${connector.connector} ${kind}`;
  return [
    ...statementViolations(where, row),
    ...bracketedDeclarationViolations(where, row),
    ...bracketLaneViolations(where, row, facts, connector),
    ...projectionViolations(where, kind, row, projection),
    ...evidenceViolations(where, kind, row, facts),
    ...lifecycleViolations(where, kind, row, facts),
  ];
};

/** Direction 4 for the kind set: nine rows, and every projected kind among them. */
const kindSetViolations = (
  connector: ConnectorFacts,
  table: ConnectorTable,
  projection: ProjectionFacts,
): readonly string[] => {
  const declared = new Set(Object.keys(table));
  const canonical: ReadonlySet<string> = new Set(GUARANTEE_KINDS);
  return [
    ...GUARANTEE_KINDS.filter((kind) => !declared.has(kind)).map(
      (kind) => `${connector.connector}: no row for ${kind}`,
    ),
    ...[...declared]
      .filter((kind) => !canonical.has(kind))
      .map((kind) => `${connector.connector}: a row for ${kind}, which is no canonical kind`),
    ...projection.targetKinds
      .filter((kind) => !declared.has(kind))
      .map((kind) => `${connector.connector}: the hub projects ${kind} and the table has no row for it`),
  ];
};

/** A mapped module must take a position (the origin module only under session.started). */
const mappedModuleViolations = (
  connector: ConnectorFacts,
  table: ConnectorTable,
  facts: Facts,
): readonly string[] => {
  const rows = Object.entries(table) as [string, KindLanes][];
  const mapped = new Set(rows.flatMap(([, row]) => modulesOf(row)));
  return [...mapped].flatMap((module) => {
    const known = facts.get(module);
    const onlyOrigin =
      known?.origin === true &&
      rows.every(([kind, row]) => kind === "session.started" || !modulesOf(row).includes(module));
    return [
      ...(takesPosition(known) || onlyOrigin
        ? []
        : [`${connector.connector}: ${module} is mapped and takes no position`]),
      ...(connector.reachable.has(module)
        ? []
        : [`${connector.connector}: ${module} is mapped and not reachable from ${connector.packageDir}`]),
    ];
  });
};

/** Every module this connector can run that takes a position is mapped — under each kind it builds. */
const runnableModuleViolations = (
  connector: ConnectorFacts,
  table: ConnectorTable,
  facts: Facts,
): readonly string[] => {
  const mapped = new Set(Object.values(table).flatMap((row) => modulesOf(row)));
  const runnable = [...facts.values()].filter(
    (known) =>
      takesPosition(known) && !WRAPPERS.has(known.path) && connector.reachable.has(known.path),
  );
  return [
    ...runnable
      .filter((known) => known.path.startsWith(`${connector.packageDir}/`) && !mapped.has(known.path))
      .map((known) => `${connector.connector}: ${known.path} takes a position and is in no lane`),
    ...runnable.flatMap((known) =>
      known.evidence
        .filter((kind) => !modulesOf(table[kind as GuaranteeKind]).includes(known.path))
        .map(
          (kind) =>
            `${connector.connector}: ${known.path} builds ${kind} and is in none of its lanes`,
        ),
    ),
  ];
};

/** Direction 1, across connectors: no allocating module is mapped by nobody. */
const globalViolations = (table: Table, facts: Facts): readonly string[] => {
  const mapped = new Set(
    Object.values(table).flatMap((rows) => Object.values(rows).flatMap((row) => modulesOf(row))),
  );
  const known = [...facts.values()];
  return [
    ...known
      .filter((entry) => takesPosition(entry) && !WRAPPERS.has(entry.path) && !mapped.has(entry.path))
      .map((entry) => `${entry.path} takes a position and no connector maps it`),
    ...ALLOCATOR_WRAPPERS.filter((wrapper) => !takesPosition(facts.get(wrapper))).map(
      (wrapper) => `${wrapper} is listed as an allocator wrapper and allocates nothing`,
    ),
    ...(known.some((entry) => entry.allocators.includes("mcp:allocateToolSeq"))
      ? []
      : ["no module calls the MCP allocateToolSeq helper"]),
  ];
};

export const checkDeclarationTable = (
  table: Table,
  modules: readonly ModuleFacts[],
  connectors: readonly ConnectorFacts[],
  projection: ProjectionFacts,
): readonly string[] => {
  const facts: Facts = new Map(modules.map((known) => [known.path, known]));
  return [
    ...globalViolations(table, facts),
    ...connectors.flatMap((connector) => {
      const rows = table[connector.connector];
      return [
        ...kindSetViolations(connector, rows, projection),
        ...mappedModuleViolations(connector, rows, facts),
        ...runnableModuleViolations(connector, rows, facts),
        ...(Object.entries(rows) as [string, KindLanes][]).flatMap(([kind, row]) =>
          rowViolations(connector, kind, row, facts, projection),
        ),
      ];
    }),
  ];
};
