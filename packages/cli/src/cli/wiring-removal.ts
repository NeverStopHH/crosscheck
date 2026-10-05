/**
 * Which entries in a wiring file are crosscheck's — ONE spelling for both
 * uninstalls: `init --global --remove` (the user-level files) and
 * `init --remove` (this repo's project copy, pilot 2026-10). Two removals
 * that each paired files with strips on their own would drift apart the
 * first time a connector learned a new launcher shape, and the project side
 * would start leaving entries the user-level side recognises (or the
 * reverse).
 *
 * Every strip DELEGATES to the connector's own pure inverse of the merge
 * install ran — `removeClaudeSettings` (connector-claude), `removeMcpConfig`
 * (connector-core), `removeCursorHooks` (connector-cursor) — so the
 * ownership patterns stay beside the code that writes them. This file adds
 * only what a caller needs to REPORT a strip: what went, and whether what
 * remains is nothing but structure an install creates.
 */
import { join } from "node:path";

import { removeMcpConfig } from "@crosscheck/connector-core/config/mcp-config.ts";
import { removeClaudeSettings } from "@crosscheck/connector-claude";
import type { CursorRemovalResult } from "@crosscheck/connector-cursor";
import { readJsonConfig } from "./init-io.ts";
import type { ReadRefusal } from "./init-io.ts";

/**
 * The last line of both removals, the mirror of init's restart hint: hooks
 * already loaded by a running agent stay loaded until that process restarts.
 */
export const REMOVE_RESTART_LINE =
  "agents already running keep the removed hooks loaded until they are restarted";

export interface Stripped {
  readonly value: Record<string, unknown>;
  /** False = nothing crosscheck-owned was found; `value` is the input. */
  readonly changed: boolean;
  /** What went, in words — meaningful only when `changed`. */
  readonly removed: string;
  /**
   * True = nothing is left but structure an install creates (an empty
   * object, or Cursor's `{version, hooks: {}}` skeleton). Read only when
   * `changed`: a file crosscheck took nothing from is never our leftover.
   */
  readonly leftover: boolean;
}

export interface RemovalTarget {
  readonly path: string;
  readonly strip: (value: Record<string, unknown>) => Stripped;
}

export interface WiringFiles {
  readonly claudeSettingsPath: string;
  readonly mcpPath: string;
  /** The directory holding Cursor's hooks.json + mcp.json; null = leave Cursor out. */
  readonly cursorDir: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const isEmpty = (value: Record<string, unknown>): boolean =>
  Object.keys(value).length === 0;

const entries = (count: number, noun: string): string =>
  `${String(count)} ${noun} ${count === 1 ? "entry" : "entries"}`;

/** Every hook entry in a Claude settings object, owned or not. */
const claudeHookCount = (settings: Record<string, unknown>): number =>
  Object.values(asRecord(settings["hooks"]))
    .flatMap(asArray)
    .reduce<number>((count, group) => count + asArray(asRecord(group)["hooks"]).length, 0);

/** Every hook definition in a Cursor hooks.json, owned or not. */
const cursorHookCount = (file: Record<string, unknown>): number =>
  Object.values(asRecord(file["hooks"])).reduce<number>(
    (count, definitions) => count + asArray(definitions).length,
    0,
  );

/**
 * What a strip took, read off the before/after pair rather than re-matched:
 * the strip already decided ownership, and counting entries a second way
 * would be the second copy of the matching rule this file exists to prevent.
 */
const describeClaudeRemoval = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string => {
  const hooks = claudeHookCount(before) - claudeHookCount(after);
  return [
    ...(hooks > 0 ? [entries(hooks, "hook")] : []),
    ...("statusLine" in before && !("statusLine" in after) ? ["the statusline"] : []),
  ].join(" and ");
};

const stripClaudeSettings = (value: Record<string, unknown>): Stripped => {
  const removed = removeClaudeSettings(value);
  return {
    value: removed.settings,
    changed: removed.changed,
    removed: describeClaudeRemoval(value, removed.settings),
    leftover: isEmpty(removed.settings),
  };
};

const stripMcpServers = (value: Record<string, unknown>): Stripped => {
  const removed = removeMcpConfig(value);
  return {
    value: removed.config,
    changed: removed.changed,
    removed: "the crosscheck mcp server",
    leftover: isEmpty(removed.config),
  };
};

/**
 * Cursor's skeleton is `{version, hooks}`: `mergeCursorHooks` writes both,
 * and `removeCursorHooks` deliberately leaves them (a user-level
 * ~/.cursor/hooks.json may have existed before install). Nothing else left,
 * and an empty hooks record, is that skeleton and nothing of the user's.
 */
const isCursorSkeleton = (file: Record<string, unknown>): boolean =>
  Object.keys(file).every((key) => key === "version" || key === "hooks") &&
  isEmpty(asRecord(file["hooks"]));

const cursorHooksStrip =
  (removeCursorHooks: (value: Record<string, unknown>) => CursorRemovalResult) =>
  (value: Record<string, unknown>): Stripped => {
    const removed = removeCursorHooks(value);
    return {
      value: removed.hooks,
      changed: removed.changed,
      removed: entries(cursorHookCount(value) - cursorHookCount(removed.hooks), "cursor hook"),
      leftover: isCursorSkeleton(removed.hooks),
    };
  };

/** The files a removal walks, each paired with the strip that knows its shape. */
export const removalTargets = async (
  files: WiringFiles,
): Promise<readonly RemovalTarget[]> => {
  const claudeTargets: readonly RemovalTarget[] = [
    { path: files.claudeSettingsPath, strip: stripClaudeSettings },
    { path: files.mcpPath, strip: stripMcpServers },
  ];
  return files.cursorDir === null
    ? claudeTargets
    : [...claudeTargets, ...(await cursorTargets(files.cursorDir))];
};

/** Cursor's pair alone — for a run that leaves it in place but must say so. */
export const cursorTargets = async (
  cursorDir: string,
): Promise<readonly RemovalTarget[]> => {
  // DYNAMIC like every Cursor branch of init: hooks and the statusline must
  // not pay connector-cursor's load.
  const { CURSOR_HOOKS_FILE, CURSOR_MCP_FILE, removeCursorHooks } = await import(
    "@crosscheck/connector-cursor"
  );
  return [
    { path: join(cursorDir, CURSOR_HOOKS_FILE), strip: cursorHooksStrip(removeCursorHooks) },
    { path: join(cursorDir, CURSOR_MCP_FILE), strip: stripMcpServers },
  ];
};

export interface WiringState {
  /** Files holding crosscheck's entries, with what a removal would take. */
  readonly wired: readonly { readonly path: string; readonly removed: string }[];
  /** Files that exist but could not be read as a json object. */
  readonly unreadable: readonly { readonly path: string; readonly reason: ReadRefusal }[];
}

/**
 * READ-ONLY: which of these files still hold crosscheck's entries — the same
 * strips decide it, run and thrown away, so "still wired" can never disagree
 * with what a removal would take (review 2026-10-05: a `.cursor/mcp.json`
 * holding only the user's own server was called crosscheck's). Missing files
 * are neither.
 */
export const readWiringState = async (
  targets: readonly RemovalTarget[],
): Promise<WiringState> => {
  const reads = await Promise.all(
    targets.map(async (target) => ({ target, read: await readJsonConfig(target.path) })),
  );
  return {
    wired: reads.flatMap(({ target, read }) => {
      if (!read.ok || read.raw === null) {
        return [];
      }
      const stripped = target.strip(read.value);
      return stripped.changed ? [{ path: target.path, removed: stripped.removed }] : [];
    }),
    unreadable: reads.flatMap(({ target, read }) =>
      read.ok ? [] : [{ path: target.path, reason: read.reason }],
    ),
  };
};

/** The same files' paths alone, for a command that writes rather than strips. */
export const wiringPaths = async (files: WiringFiles): Promise<readonly string[]> =>
  (await removalTargets(files)).map((target) => target.path);
