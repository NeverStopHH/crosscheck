/**
 * THE DECLARED-GUARANTEE BUILD CHECK (1.0 spec 01a §3.6, CSK-7 and CSK-27).
 *
 * A connector's declaration table says, per canonical kind, which lanes can
 * produce it and therefore what its positions can support. The table is data
 * a person wrote, so this file reads the CODE and holds the table to it in
 * the four directions §3.6 lists:
 *
 *   1. every module that takes a position — connector-core's `allocateSeq`,
 *      `allocateToolSeq` or `openToolWindow`, resolved through its import, not
 *      the MCP helper that shares a name — is in the map, and every module in
 *      the map takes one (or sends the origin position n = 0);
 *   2. a kind declared `guaranteed / bracketed_by_pre_tool` has no producing
 *      module outside a pre-tool-bracketed lane;
 *   3. a kind with no producing module is `unavailable / no_emitter` or
 *      `not_built` — the direction the runtime cap cannot guard, since a kind
 *      nobody emits produces no row to contradict anything;
 *   4. the map's kinds agree with the hub's projection (`TARGET_EVENT_KINDS`,
 *      `seqKindFor`).
 *
 * The scan is facts only; the judgement is `checkDeclarationTable`, a pure
 * function, so every rule is also tested against a table built to break it.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { GUARANTEE_KINDS, foldGuaranteeDeclaration } from "@crosscheck/schema";
import { TARGET_EVENT_KINDS, seqKindFor } from "@crosscheck/server";

import {
  POST_TOOL_USE_MATCHER,
  PRE_TOOL_USE_MATCHER,
} from "../src/constants.ts";
import {
  checkDeclarationTable,
} from "../src/guarantees/check.ts";
import type {
  AllocatorName,
  ConnectorFacts,
  ModuleFacts,
  ProjectionFacts,
} from "../src/guarantees/check.ts";
import {
  DECLARATION_TABLE,
  GUARANTEE_CONNECTORS,
  MCP_SERVER_MODULE,
  declarationRowsFor,
  foldLanes,
  guaranteeDeclarationFor,
} from "../src/guarantees/declarations.ts";
import type {
  ConnectorTable,
  GuaranteeConnector,
  KindLanes,
  LaneProducers,
} from "../src/guarantees/declarations.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const PACKAGES = ["connector-core", "connector-claude", "connector-cursor", "connector-acp"];
const SESSION_STATE = "packages/connector-core/src/state/session-state.ts";
const MCP_SHARED = "packages/connector-core/src/mcp/tools/shared.ts";
const CORE_ALLOCATORS = new Set(["allocateSeq", "allocateToolSeq", "openToolWindow"]);

/** The package each connector's own modules live in. */
const PACKAGE_OF: Readonly<Record<GuaranteeConnector, string>> = {
  "claude-code": "packages/connector-claude",
  "cursor-ide": "packages/connector-cursor",
  "acp:*": "packages/connector-acp",
};

/**
 * WHAT PROVES A MODULE BUILDS A KIND'S RECORD. The capture flows are the only
 * builders of target records (flows/capture-touched-files.ts's directive), the
 * commit aggregate has one constructor, a claim and an edge are envelopes of
 * their record kind, and every intent writer books `withRecordedIntent`.
 * session.started / session.ended are lifecycle positions and carry no
 * builder name: they are checked as the origin module and as the allocating
 * modules that build nothing else.
 */
const EVIDENCE_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "file.modified": ["captureTouchedFiles", "captureFileTargets", "captureGitTouches"],
  "tool.failed": ["captureFailure"],
  "commit.observed": ["commitEvidenceRecord"],
  "intent.declared": ["withRecordedIntent"],
  "intent.amended": ["withRecordedIntent"],
};
const ENVELOPE_KIND_PATTERN =
  /(?:buildEnvelope|envelopeFor)\(\s*(?:[\w.]+,\s*){0,2}"(claim|claim_edge)"/g;
const EVIDENCE_ENVELOPES: Readonly<Record<string, string>> = {
  claim: "claim.created",
  claim_edge: "claim.invalidated",
};
/** The register flow's literal origin: `session.started` is n = 0 by construction. */
const ORIGIN_PATTERN = /seq:\s*\{\s*epoch,\s*n:\s*0\s*\}/;

const IMPORT_PATTERN =
  /(?:import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /import\(\s*["']([^"']+)["']\s*\)/g;

interface ParsedImport {
  readonly names: readonly string[];
  readonly target: string | null;
}

const resolveSpecifier = (from: string, specifier: string): string | null => {
  if (specifier.startsWith(".")) {
    return relative(REPO_ROOT, resolve(REPO_ROOT, dirname(from), specifier));
  }
  const scoped = /^@crosscheck\/([\w-]+)(?:\/(.+))?$/.exec(specifier);
  if (scoped?.[1] === undefined) {
    return null;
  }
  return `packages/${scoped[1]}/src/${scoped[2] ?? "index.ts"}`;
};

const braced = (clause: string): readonly string[] =>
  (/\{([\s\S]*?)\}/.exec(clause)?.[1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("type "))
    .map((entry) => (entry.split(/\s+as\s+/)[0] ?? entry).trim());

const parseImports = (path: string, source: string): readonly ParsedImport[] => [
  ...[...source.matchAll(IMPORT_PATTERN)]
    .filter((match) => match[1] === undefined && match[3] !== undefined)
    .map((match) => ({
      names: braced(match[2] ?? ""),
      target: resolveSpecifier(path, match[3] ?? ""),
    })),
  ...[...source.matchAll(DYNAMIC_IMPORT_PATTERN)].map((match) => ({
    names: [],
    target: resolveSpecifier(path, match[1] ?? ""),
  })),
];

const allocatorsOf = (imports: readonly ParsedImport[]): readonly AllocatorName[] =>
  imports.flatMap((entry) =>
    entry.names.flatMap((name): AllocatorName[] => {
      if (entry.target === SESSION_STATE && CORE_ALLOCATORS.has(name)) {
        return [name as AllocatorName];
      }
      return entry.target === MCP_SHARED && name === "allocateToolSeq"
        ? ["mcp:allocateToolSeq"]
        : [];
    }),
  );

const evidenceOf = (source: string, imports: readonly ParsedImport[]): readonly string[] => {
  const names = new Set(imports.flatMap((entry) => entry.names));
  const byImport = Object.entries(EVIDENCE_IMPORTS)
    .filter(([, identifiers]) => identifiers.some((identifier) => names.has(identifier)))
    .map(([kind]) => kind);
  const byEnvelope = [...source.matchAll(ENVELOPE_KIND_PATTERN)].flatMap((match) => {
    const kind = EVIDENCE_ENVELOPES[match[1] ?? ""];
    return kind === undefined ? [] : [kind];
  });
  return [...new Set([...byImport, ...byEnvelope])];
};

interface ScannedModule {
  readonly facts: ModuleFacts;
  readonly imports: readonly string[];
}

const listSources = async (pkg: string): Promise<readonly string[]> => {
  const entries = await readdir(join(REPO_ROOT, "packages", pkg, "src"), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(REPO_ROOT, join(entry.parentPath, entry.name)));
};

const scan = async (): Promise<ReadonlyMap<string, ScannedModule>> => {
  const paths = (await Promise.all(PACKAGES.map(listSources))).flat();
  const scanned = await Promise.all(
    paths.map(async (path): Promise<[string, ScannedModule]> => {
      const source = await Bun.file(join(REPO_ROOT, path)).text();
      const imports = parseImports(path, source);
      const facts: ModuleFacts = {
        path,
        allocators: [...new Set(allocatorsOf(imports))],
        evidence: evidenceOf(source, imports),
        origin: ORIGIN_PATTERN.test(source),
      };
      const targets = imports.flatMap((entry) => (entry.target === null ? [] : [entry.target]));
      return [path, { facts, imports: targets }];
    }),
  );
  return new Map(scanned);
};

/** Every module reachable from these seeds through value imports. */
const closureOf = (
  modules: ReadonlyMap<string, ScannedModule>,
  seeds: readonly string[],
): ReadonlySet<string> => {
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined || seen.has(next) || !modules.has(next)) {
      continue;
    }
    seen.add(next);
    queue.push(...(modules.get(next)?.imports ?? []));
  }
  return seen;
};

const matcherTools = (matcher: string): readonly string[] => matcher.split("|");

/** Tools whose post-hook fires with no pre-hook to open a window (claude only). */
const toolsWithoutPreBracket = (connector: GuaranteeConnector): readonly string[] =>
  connector === "claude-code"
    ? matcherTools(POST_TOOL_USE_MATCHER).filter(
        (tool) => !matcherTools(PRE_TOOL_USE_MATCHER).includes(tool),
      )
    : [];

const BRACKETED_STAMP = { epoch: "e", n: 3, after: 1 } as const;

const PROJECTION: ProjectionFacts = {
  targetKinds: Object.values(TARGET_EVENT_KINDS),
  seqKindOfLane: (lane) => {
    if (lane === "pre_tool_bracketed") {
      return seqKindFor("tool_edit", BRACKETED_STAMP);
    }
    if (lane === "post_tool_unbracketed") {
      return seqKindFor("tool_edit", { epoch: "e", n: 3 });
    }
    return lane === "observing" ? seqKindFor("git_diff", BRACKETED_STAMP) : null;
  },
};

let MODULES: readonly ModuleFacts[] = [];
let CONNECTORS: readonly ConnectorFacts[] = [];

beforeAll(async () => {
  const scanned = await scan();
  MODULES = [...scanned.values()].map((entry) => entry.facts);
  const mcpClosure = closureOf(scanned, [MCP_SERVER_MODULE]);
  CONNECTORS = GUARANTEE_CONNECTORS.map((connector) => {
    const own = [...scanned.keys()].filter((path) =>
      path.startsWith(`${PACKAGE_OF[connector]}/src/`),
    );
    return {
      connector,
      packageDir: PACKAGE_OF[connector],
      reachable: new Set([...closureOf(scanned, own), ...mcpClosure]),
      toolsWithoutPreBracket: toolsWithoutPreBracket(connector),
    };
  });
});

const withKind = (
  connector: GuaranteeConnector,
  kind: string,
  replacement: KindLanes,
): Readonly<Record<GuaranteeConnector, ConnectorTable>> => ({
  ...DECLARATION_TABLE,
  [connector]: { ...DECLARATION_TABLE[connector], [kind]: replacement },
});

const check = (table = DECLARATION_TABLE): readonly string[] =>
  checkDeclarationTable(table, MODULES, CONNECTORS, PROJECTION);

describe("the declaration table against the code", () => {
  test("the shipped table satisfies all four directions", () => {
    // Arrange: the scan in beforeAll. Act
    const violations = check();
    // Assert
    expect(violations).toEqual([]);
  });

  test("the scan found the allocators it has to find, so a green check is not an empty one", () => {
    // Arrange
    const allocating = MODULES.filter((entry) => entry.allocators.length > 0).map(
      (entry) => entry.path,
    );
    // Assert
    expect(allocating).toContain("packages/connector-claude/src/hooks/post-tool-use.ts");
    expect(allocating).toContain("packages/connector-claude/src/hooks/pre-tool-use.ts");
    expect(allocating).toContain("packages/connector-cursor/src/handlers/file-edit.ts");
    expect(allocating).toContain("packages/connector-acp/src/capture/engine.ts");
    expect(allocating).toContain("packages/connector-core/src/mcp/tools/publish-claim.ts");
    expect(allocating.length).toBeGreaterThanOrEqual(19);
  });

  test("Claude Code's file.modified is partial because Bash and the Stop git lane produce it too", () => {
    // Act
    const row = declarationRowsFor("claude-code").find((entry) => entry.kind === "file.modified");
    // Assert
    expect(row?.guarantee).toBe("partial");
    expect(row?.reason).toBe("unbracketed_lane");
  });

  test("commit.observed is partial on Claude Code because the hub stores every commit row observed", () => {
    // Act
    const row = declarationRowsFor("claude-code").find((entry) => entry.kind === "commit.observed");
    // Assert
    expect(row?.guarantee).toBe("partial");
    expect(row?.reason).toBe("observed_lane_only");
  });

  test("a claim kind takes the summarizer's weaker reason over the MCP picker's", () => {
    // Act
    const row = declarationRowsFor("cursor-ide").find((entry) => entry.kind === "claim.created");
    // Assert
    expect(row?.reason).toBe("derived_after_the_fact");
  });
});

describe("a table built to break a rule fails the build", () => {
  test("file.modified declared bracketed while a Bash-reachable module allocates for it (CSK-7)", () => {
    // Arrange: drop the unbracketed and observing lanes, keep the Edit lane.
    const original = DECLARATION_TABLE["claude-code"]["file.modified"];
    const bracketedOnly: KindLanes = {
      ...original,
      guarantee: "guaranteed",
      reason: "bracketed_by_pre_tool",
      lanes: original.lanes.filter((lane) => lane.lane === "pre_tool_bracketed"),
    };
    // Act
    const violations = check(withKind("claude-code", "file.modified", bracketedOnly));
    // Assert
    expect(violations.some((line) => line.includes("Bash"))).toBe(true);
  });

  test("a declaration stronger than its weakest lane", () => {
    // Arrange
    const original = DECLARATION_TABLE["claude-code"]["file.modified"];
    const overclaimed: KindLanes = { ...original, guarantee: "guaranteed", reason: "bracketed_by_pre_tool" };
    // Act
    const violations = check(withKind("claude-code", "file.modified", overclaimed));
    // Assert
    expect(violations.some((line) => line.includes("weakest lane"))).toBe(true);
    expect(violations.some((line) => line.includes("outside a pre-tool-bracketed lane"))).toBe(true);
  });

  test("an allocating module missing from the map", () => {
    // Arrange: cursor's shell handler removed from tool.failed.
    const original = DECLARATION_TABLE["cursor-ide"]["tool.failed"];
    const missing: KindLanes = {
      ...original,
      lanes: original.lanes.map((lane) => ({
        ...lane,
        modules: lane.modules.filter((module) => !module.endsWith("handlers/shell.ts")),
      })),
    };
    // Act
    const violations = check(withKind("cursor-ide", "tool.failed", missing));
    // Assert
    expect(violations.some((line) => line.includes("handlers/shell.ts"))).toBe(true);
  });

  test("a mapped module that takes no position", () => {
    // Arrange
    const original = DECLARATION_TABLE["acp:*"]["tool.failed"];
    const padded: KindLanes = {
      ...original,
      lanes: [
        ...original.lanes,
        { lane: "post_tool_unbracketed", modules: ["packages/connector-acp/src/capabilities.ts"] },
      ],
    };
    // Act
    const violations = check(withKind("acp:*", "tool.failed", padded));
    // Assert
    expect(violations.some((line) => line.includes("takes no position"))).toBe(true);
  });

  test("ordering declared for a kind the connector never emits (CSK-27)", () => {
    // Arrange: cursor has no commit lane at all.
    const claimed: KindLanes = { guarantee: "guaranteed", reason: "lifecycle", lanes: [] };
    // Act
    const violations = check(withKind("cursor-ide", "commit.observed", claimed));
    // Assert
    expect(violations.some((line) => line.includes("no producing module"))).toBe(true);
  });

  test("a module listed for a kind its source does not build", () => {
    // Arrange: cursor's file-edit handler claimed as a tool.failed producer.
    const original = DECLARATION_TABLE["cursor-ide"]["tool.failed"];
    const wrong: KindLanes = {
      ...original,
      lanes: [
        ...original.lanes,
        { lane: "post_tool_unbracketed", modules: ["packages/connector-cursor/src/handlers/file-edit.ts"] },
      ],
    };
    // Act
    const violations = check(withKind("cursor-ide", "tool.failed", wrong));
    // Assert
    expect(violations.some((line) => line.includes("does not build"))).toBe(true);
  });

  test("an observing lane relabelled as bracketed disagrees with the hub's projection", () => {
    // Arrange: the Stop git lane relabelled as a bracketed lane.
    const original = DECLARATION_TABLE["claude-code"]["file.modified"];
    const relabelled: KindLanes = {
      ...original,
      lanes: original.lanes.map((lane) =>
        lane.lane === "observing" ? { ...lane, lane: "pre_tool_bracketed" as const } : lane,
      ),
    };
    // Act
    const violations = check(withKind("claude-code", "file.modified", relabelled));
    // Assert
    expect(violations).toContain(
      "claude-code file.modified: packages/connector-claude/src/hooks/stop.ts is in a bracketed lane and closes no window",
    );
  });

  test("a bracketed lane whose window-opening module was left out of the map", () => {
    // Arrange: pre-tool-use.ts dropped from both of Claude's bracketed lanes.
    const strip = (kind: "file.modified" | "tool.failed"): KindLanes => {
      const original = DECLARATION_TABLE["claude-code"][kind];
      return {
        ...original,
        lanes: original.lanes.map((lane) => ({
          ...lane,
          modules: lane.modules.filter((module) => !module.endsWith("hooks/pre-tool-use.ts")),
        })),
      };
    };
    const table = {
      ...DECLARATION_TABLE,
      "claude-code": {
        ...DECLARATION_TABLE["claude-code"],
        "file.modified": strip("file.modified"),
        "tool.failed": strip("tool.failed"),
      },
    };
    // Act
    const violations = check(table);
    // Assert
    const preTool = "packages/connector-claude/src/hooks/pre-tool-use.ts";
    expect(violations).toContain(`claude-code: ${preTool} takes a position and is in no lane`);
    expect(violations).toContain(`${preTool} takes a position and no connector maps it`);
    expect(violations).toContain("claude-code file.modified: a bracketed lane with no module that opens a window");
  });

  test("a module that builds a kind and is missing from that kind's lanes", () => {
    // Arrange: cursor's shell handler removed from tool.failed (it stays mapped nowhere else).
    const original = DECLARATION_TABLE["cursor-ide"]["tool.failed"];
    const missing: KindLanes = {
      ...original,
      lanes: original.lanes.map((lane) => ({
        ...lane,
        modules: lane.modules.filter((module) => !module.endsWith("handlers/shell.ts")),
      })),
    };
    // Act
    const violations = check(withKind("cursor-ide", "tool.failed", missing));
    // Assert
    expect(violations).toContain(
      "cursor-ide: packages/connector-cursor/src/handlers/shell.ts builds tool.failed and is in none of its lanes",
    );
  });

  test("a module mapped under a connector that cannot run it", () => {
    // Arrange: Claude's Stop git lane claimed for Cursor.
    const original = DECLARATION_TABLE["cursor-ide"]["file.modified"];
    const borrowed: KindLanes = {
      ...original,
      lanes: [...original.lanes, { lane: "observing", modules: ["packages/connector-claude/src/hooks/stop.ts"] }],
    };
    // Act
    const violations = check(withKind("cursor-ide", "file.modified", borrowed));
    // Assert
    expect(violations).toContain(
      "cursor-ide: packages/connector-claude/src/hooks/stop.ts is mapped and not reachable from packages/connector-cursor",
    );
  });

  test("a session.started module that does not send the origin position", () => {
    // Arrange
    const ended: KindLanes = {
      ...DECLARATION_TABLE["claude-code"]["session.started"],
      lanes: [{ lane: "lifecycle", modules: ["packages/connector-core/src/flows/end-session.ts"] }],
    };
    // Act
    const violations = check(withKind("claude-code", "session.started", ended));
    // Assert
    expect(violations).toContain(
      "claude-code session.started: packages/connector-core/src/flows/end-session.ts holds no session.started position",
    );
  });

  test("a hub that stored an unbracketed tool position as emitted disagrees with the table", () => {
    // Arrange: a projection whose seqKindFor no longer downgrades.
    const projection: ProjectionFacts = { ...PROJECTION, seqKindOfLane: () => "emitted" };
    // Act
    const violations = checkDeclarationTable(DECLARATION_TABLE, MODULES, CONNECTORS, projection);
    // Assert
    expect(violations).toContain(
      "cursor-ide file.modified: the hub stores a post_tool_unbracketed position emitted, the table reads observed",
    );
  });

  test("a table missing one of the nine kinds", () => {
    // Arrange
    const { ["intent.amended"]: _dropped, ...rest } = DECLARATION_TABLE["acp:*"];
    const table = { ...DECLARATION_TABLE, "acp:*": rest as ConnectorTable };
    // Act
    const violations = check(table);
    // Assert
    expect(violations).toContain("acp:*: no row for intent.amended");
  });

  test("a projection that adds a target kind the map does not declare", () => {
    // Arrange
    const projection: ProjectionFacts = {
      ...PROJECTION,
      targetKinds: [...PROJECTION.targetKinds, "symbol.renamed"],
    };
    // Act
    const violations = checkDeclarationTable(DECLARATION_TABLE, MODULES, CONNECTORS, projection);
    // Assert
    expect(violations.some((line) => line.includes("symbol.renamed"))).toBe(true);
  });
});

describe("the weakest-lane fold", () => {
  const at = (lane: LaneProducers["lane"]): LaneProducers => ({ lane, modules: ["m.ts"] });

  test("one unbracketed lane beside a bracketed one makes the kind partial", () => {
    // Act
    const reading = foldLanes([at("pre_tool_bracketed"), at("post_tool_unbracketed")]);
    // Assert
    expect(reading).toEqual({ guarantee: "partial", reason: "unbracketed_lane" });
  });

  test("an observing lane beside a tool lane reads unbracketed, not observed-only", () => {
    // Act
    const reading = foldLanes([at("pre_tool_bracketed"), at("observing")]);
    // Assert
    expect(reading).toEqual({ guarantee: "partial", reason: "unbracketed_lane" });
  });

  test("a kind produced only by observing lanes reads observed-only", () => {
    // Act
    const reading = foldLanes([at("observing")]);
    // Assert
    expect(reading).toEqual({ guarantee: "partial", reason: "observed_lane_only" });
  });

  test("the derived worker is weaker than the MCP picker, in either order", () => {
    // Act
    const forward = foldLanes([at("mcp_tool"), at("derived_worker")]);
    const backward = foldLanes([at("derived_worker"), at("mcp_tool")]);
    // Assert
    expect(forward?.reason).toBe("derived_after_the_fact");
    expect(backward?.reason).toBe("derived_after_the_fact");
  });

  test("no lane folds to nothing, never to the strongest value", () => {
    // Act
    const reading = foldLanes([]);
    // Assert
    expect(reading).toBeNull();
  });
});

describe("the wire block a connector sends", () => {
  test("every connector sends nine triples a hub folds back to the same values", () => {
    for (const connector of GUARANTEE_CONNECTORS) {
      // Act
      const block = guaranteeDeclarationFor(connector);
      // Assert
      expect(block.map((triple) => triple.kind)).toEqual([...GUARANTEE_KINDS]);
      expect(foldGuaranteeDeclaration(block)).toEqual(block);
    }
  });
});
