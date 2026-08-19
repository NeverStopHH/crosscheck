/**
 * The doctor's Cursor section (design §3.4): hooks file present + entries
 * owned + all seven events registered + nothing failClosed, launcher health
 * (the shared core probes — a bare `crosscheck` is executed via --version,
 * absolute-path launchers are existence/cache-checked), `.cursor/mcp.json` entry
 * owned, last-observed cursor_version ≥ 1.7, and the contract-drift
 * counters — rule 6 on this surface: cursor hooks are silent by design, so
 * doctor is the only place a renamed payload field ever becomes a sentence.
 *
 * "Not installed" is a PASS, not a warning: the Cursor connector is
 * optional per repo, and a warning nobody can act on teaches people to
 * ignore doctor (the absence-check lesson).
 */
import { join } from "node:path";

import { checkLauncherCommand } from "@crosscheck/connector-core/config/launcher-check.ts";
import { isOwnedMcpEntry } from "@crosscheck/connector-core/config/mcp-config.ts";
import { MCP_SERVER_KEY } from "@crosscheck/connector-core/constants.ts";
import { readTextOrNull } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { readSyncState } from "@crosscheck/connector-core/state/sync-state.ts";

import {
  CURSOR_DIR,
  CURSOR_HOOKS_FILE,
  CURSOR_MCP_FILE,
  MIN_CURSOR_HOOKS_MAJOR,
  MIN_CURSOR_HOOKS_MINOR,
} from "./constants.ts";
import { readContractDrift } from "./drift.ts";
import { isOwnedCursorCommand } from "./init/hooks-merge.ts";
import { CURSOR_HOOK_EVENTS } from "./payload.ts";

/** Structurally the Claude doctor's Check — no cross-package type import. */
export interface CursorCheck {
  readonly level: "PASS" | "WARN" | "FAIL";
  readonly name: string;
  readonly detail: string;
}

const check = (
  level: CursorCheck["level"],
  name: string,
  detail: string,
): CursorCheck => ({ level, name, detail });

export interface CursorDoctorInput {
  readonly repoRoot: string;
  readonly env: Env;
  readonly home: string;
  readonly repoKey: string;
}

interface OwnedEntry {
  readonly event: string;
  readonly command: string;
  readonly failClosed: boolean;
}

const collectOwnedEntries = (
  hooks: Record<string, unknown>,
): readonly OwnedEntry[] =>
  Object.entries(hooks).flatMap(([event, definitions]) =>
    (Array.isArray(definitions) ? definitions : []).flatMap((definition) => {
      const record =
        typeof definition === "object" && definition !== null
          ? (definition as Record<string, unknown>)
          : {};
      const command = record["command"];
      return isOwnedCursorCommand(command)
        ? [
            {
              event,
              command: String(command),
              failClosed: record["failClosed"] === true,
            },
          ]
        : [];
    }),
  );

/** "1.7.2" → [1, 7]; null when the string has no parseable major.minor. */
const parseMajorMinor = (version: string): readonly [number, number] | null => {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isFinite(major) && Number.isFinite(minor)
    ? [major, minor]
    : null;
};

const versionCheck = (cursorVersion: string | null): CursorCheck => {
  if (cursorVersion === null) {
    return check(
      "PASS",
      "cursor version",
      "not yet observed — the first sessionStart records it",
    );
  }
  const parsed = parseMajorMinor(cursorVersion);
  if (parsed === null) {
    return check("PASS", "cursor version", `unrecognised: ${cursorVersion}`);
  }
  const [major, minor] = parsed;
  const isBelow =
    major < MIN_CURSOR_HOOKS_MAJOR ||
    (major === MIN_CURSOR_HOOKS_MAJOR && minor < MIN_CURSOR_HOOKS_MINOR);
  return isBelow
    ? check(
        "WARN",
        "cursor version",
        `${cursorVersion} observed — hooks exist since ${MIN_CURSOR_HOOKS_MAJOR}.${MIN_CURSOR_HOOKS_MINOR}; this build never fires them`,
      )
    : check("PASS", "cursor version", cursorVersion);
};

const driftCheck = async (home: string): Promise<CursorCheck> => {
  const drift = await readContractDrift(home);
  if (drift.total === 0 && drift.malformed === 0) {
    return check("PASS", "cursor contract drift", "none");
  }
  const topFields = Object.entries(drift.byField)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([field, count]) => `${field} ×${count}`);
  return check(
    "WARN",
    "cursor contract drift",
    `${drift.total} payload${drift.total === 1 ? "" : "s"} lacked mapped fields` +
      (topFields.length > 0 ? ` (${topFields.join(", ")})` : "") +
      (drift.lastAt === null ? "" : `, last ${drift.lastAt}`) +
      (drift.malformed > 0 ? `, ${drift.malformed} ledger lines unreadable` : "") +
      (drift.atCap ? " — ledger at cap, counts are a floor" : "") +
      " — Cursor may have renamed a payload field; capture degrades silently until this is investigated",
  );
};

const mcpCheck = async (repoRoot: string): Promise<CursorCheck> => {
  const path = join(repoRoot, CURSOR_DIR, CURSOR_MCP_FILE);
  const raw = await readTextOrNull(path);
  if (raw === null) {
    return check(
      "FAIL",
      "cursor mcp tools",
      `${path} not found — run crosscheck init --cursor`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return check(
      "WARN",
      "cursor mcp tools",
      `${path} is not valid json — init --cursor will refuse to touch it until that is fixed`,
    );
  }
  const servers =
    typeof parsed === "object" && parsed !== null
      ? ((parsed as Record<string, unknown>)["mcpServers"] as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const entry = servers?.[MCP_SERVER_KEY];
  if (entry === undefined) {
    return check(
      "FAIL",
      "cursor mcp tools",
      `${path} has no "${MCP_SERVER_KEY}" server — run crosscheck init --cursor`,
    );
  }
  return isOwnedMcpEntry(entry)
    ? check("PASS", "cursor mcp tools", path)
    : check(
        "FAIL",
        "cursor mcp tools",
        `${path} has a "${MCP_SERVER_KEY}" server, but not the one init --cursor writes — rerun crosscheck init --cursor`,
      );
};

/**
 * The whole section. When no `.cursor/hooks.json` exists (or none of its
 * entries are ours), one informational PASS line — everything else only
 * renders for an actual install.
 */
export const cursorDoctorChecks = async (
  input: CursorDoctorInput,
): Promise<readonly CursorCheck[]> => {
  const hooksPath = join(input.repoRoot, CURSOR_DIR, CURSOR_HOOKS_FILE);
  const raw = await readTextOrNull(hooksPath);
  if (raw === null) {
    return [
      check(
        "PASS",
        "cursor hooks",
        "not installed — crosscheck init --cursor adds Cursor capture",
      ),
    ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [
      check("FAIL", "cursor hooks", `${hooksPath} is not valid json`),
    ];
  }
  const hooks =
    typeof parsed === "object" && parsed !== null
      ? ((parsed as Record<string, unknown>)["hooks"] as
          | Record<string, unknown>
          | undefined) ?? {}
      : {};
  const owned = collectOwnedEntries(hooks);
  if (owned.length === 0) {
    return [
      check(
        "PASS",
        "cursor hooks",
        `${hooksPath} has no crosscheck entries — crosscheck init --cursor adds them`,
      ),
    ];
  }

  const missing = CURSOR_HOOK_EVENTS.filter(
    (event) => !owned.some((entry) => entry.event === event),
  );
  const failClosed = owned.filter((entry) => entry.failClosed);
  const hooksCheck =
    missing.length > 0
      ? check(
          "FAIL",
          "cursor hooks",
          `missing: ${missing.join(", ")} — rerun crosscheck init --cursor`,
        )
      : failClosed.length > 0
        ? check(
            "FAIL",
            "cursor hooks",
            `failClosed on ${failClosed.map((entry) => entry.event).join(", ")} — crosscheck hooks must fail OPEN; a dead hub would block the session`,
          )
        : check("PASS", "cursor hooks", CURSOR_HOOK_EVENTS.join(", "));

  const firstOwned = owned[0];
  const launcher =
    firstOwned === undefined
      ? null
      : await checkLauncherCommand(firstOwned.command, input.env, [
          "cursor-hook",
        ]);
  const sync = await readSyncState(input.home, input.repoKey);

  return [
    hooksCheck,
    ...(launcher === null
      ? []
      : [check(launcher.level, "cursor hook launcher", launcher.detail)]),
    await mcpCheck(input.repoRoot),
    versionCheck(sync.cursorVersion),
    await driftCheck(input.home),
  ];
};
