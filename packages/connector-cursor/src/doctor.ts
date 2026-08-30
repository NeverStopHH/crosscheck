/**
 * The doctor's Cursor section (design §3.4): hooks file present + entries
 * owned + all eight events registered + nothing failClosed, launcher health
 * (the shared core probes — a bare `crosscheck` is executed via --version,
 * absolute-path launchers are existence/cache-checked), `.cursor/mcp.json` entry
 * owned, last-observed cursor_version ≥ 1.7, and the contract-drift
 * counters — rule 6 on this surface: cursor hooks are silent by design, so
 * doctor is the only place a renamed payload field ever becomes a sentence.
 *
 * SINCE THE DERIVE RUNGS: what crosscheck INFERS inside Cursor, and what it
 * deliberately does not, one sentence each from the static manifest
 * (capabilities.ts). The refusals are printed ALWAYS and as PASS lines — a
 * decision nobody can find is indistinguishable from a bug nobody fixed, and
 * every one of them is the platform working as documented, not this machine
 * failing.
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
import { summarizeSummarizerCost } from "@crosscheck/connector-core/derive/summarizer/cost.ts";
import { bareSummarizerLine } from "@crosscheck/connector-core/model/runner.ts";
import { CURSOR_HOST_KEY_PREFIX } from "@crosscheck/connector-core/state/host-session-key.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { readSyncState } from "@crosscheck/connector-core/state/sync-state.ts";

import {
  CURSOR_DIR,
  CURSOR_HOOKS_FILE,
  CURSOR_MCP_FILE,
  MIN_CURSOR_HOOKS_MAJOR,
  MIN_CURSOR_HOOKS_MINOR,
} from "./constants.ts";
import { CURSOR_CAPABILITY_MANIFEST } from "./capabilities.ts";
import { NO_SLICE_NO_TRANSCRIPT } from "./derive/transcript.ts";
import { readContractDrift } from "./drift.ts";
import { readInjectionLedger } from "./inject/ledger.ts";
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
  /**
   * The live session states the CALLER already read (`doctor` scans the
   * session directory once for all its model-cost lines). Optional, and its
   * absence is honest rather than convenient: with no states the capability
   * lines say what the platform allows and stay quiet about what has happened,
   * which is exactly true on a machine where nothing has run yet.
   */
  readonly liveStates?: readonly SessionState[];
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

/**
 * Injection state from the ledger (Block 7 item 5): was the briefing
 * delivered, how many hints, WHICH events carried them — the §6-q4
 * instrument. Always PASS: these are telemetry facts a human reads during
 * the dogfood, not health judgments (a suppressed briefing in a solo repo
 * is correct behavior, and warning on it would teach people to ignore
 * doctor — the absence-check lesson).
 */
const injectionCheck = async (home: string): Promise<CursorCheck> => {
  const summary = await readInjectionLedger(home);
  const total =
    summary.briefings.delivered +
    summary.briefings.suppressed +
    summary.hints.delivered +
    summary.hints.suppressed;
  if (total === 0 && summary.malformed === 0) {
    return check(
      "PASS",
      "cursor injection",
      "none recorded yet — the first connected sessionStart delivers or counts a briefing",
    );
  }
  const hintEvents = Object.entries(summary.hintEvents)
    .sort((a, b) => b[1] - a[1])
    .map(([event, count]) => `${event} ×${count}`);
  return check(
    "PASS",
    "cursor injection",
    `briefings ${summary.briefings.delivered} delivered / ${summary.briefings.suppressed} suppressed · ` +
      `hints ${summary.hints.delivered} delivered / ${summary.hints.suppressed} suppressed` +
      (hintEvents.length > 0 ? ` (via ${hintEvents.join(", ")})` : "") +
      (summary.lastDeliveredAt === null
        ? ""
        : `, last ${summary.lastDeliveredAt}`) +
      (summary.malformed > 0
        ? `, ${summary.malformed} ledger lines unreadable`
        : "") +
      (summary.atCap ? " — ledger at cap, counts are a floor" : ""),
  );
};

/**
 * ONE capability line's text — the rung and its platform sentence, plus what
 * this machine has booked against it.
 *
 * A REGISTERED RENDER SURFACE (§4.4, `cursor-derive-capability-line`), and
 * not decoratively: `lastFailure` is the model BINARY's own stdout on its way
 * out of session state, so it goes through `bareSummarizerLine` here — the
 * same door core's `model-failure-line` uses — before it can reach a terminal
 * or, through a Bash `crosscheck doctor`, an agent's context. The writers
 * that fill the field already bound it, and this is the second lock rather
 * than the first: a state file is a file, and a doctor line that trusts one
 * is one hostile write away from carrying whatever is in it.
 */
export const cursorCapabilityDetail = (input: {
  readonly rung: string;
  readonly sentence: string;
  readonly failures: number;
  readonly lastFailure: string | null;
  /**
   * One extra fact this machine knows about the rung, already in crosscheck's
   * own words — printed whether or not anything failed, because the facts
   * that ride here are the ones that move NO counter (see the slice shape).
   */
  readonly note?: string | null;
}): string => {
  const note = input.note === undefined || input.note === null ? "" : `; ${input.note}`;
  const head = `${input.rung} — ${input.sentence}${note}`;
  if (input.failures === 0) {
    return head;
  }
  const said =
    input.lastFailure === null ? "" : bareSummarizerLine(input.lastFailure);
  return (
    `${head}; ${String(input.failures)} fire${input.failures === 1 ? "" : "s"} booked a failure` +
    (said.length === 0 ? "" : `, last "${said}"`) +
    " — see the summarizer runner check (counts are per live session and clear at SessionEnd)"
  );
};

/**
 * WHICH DECODER LAST READ A TURN — the Cursor rung's drift tripwire, and the
 * only surface it has.
 *
 * `derive/transcript.ts` tries a line-delimited-JSON decoder and falls back to
 * reading the tail as prose. The first is a HYPOTHESIS about a format Cursor
 * documents nowhere. If it stops matching, the fallback takes over, the gate
 * is handed a strictly weaker slice, and every counter stays where it was — a
 * slice WAS produced (so no noSlice) and no model ran (so no failure). Printed
 * as a PASS-level fact and never a WARN: prose is a documented, deliberate
 * fallback, and a machine whose Cursor never wrote JSONL would otherwise WARN
 * forever with nothing to fix.
 *
 * The token is the connector's own union member, mapped to words here — the
 * state file is a file, and a doctor line never prints what it merely found
 * in one.
 */
const sliceShapeNote = (
  liveStates: readonly SessionState[],
): string | null => {
  const shape = liveStates.reduce<string | null>(
    (last, state) => state.summarizerLastSliceShape ?? last,
    null,
  );
  if (shape === "jsonl") {
    return "last tail decoded as structured entries";
  }
  return shape === "text"
    ? "last tail decoded as prose, not as structured entries"
    : null;
};

/**
 * WHAT CROSSCHECK INFERS INSIDE CURSOR, printed as sentences.
 *
 * One line per declared capability and one per declared refusal
 * (capabilities.ts holds both as data). The refusals are the half that is
 * easy to skip and the half rule 4 is about: a thing this product decided not
 * to do on this platform, printed in words, so nobody has to reverse-engineer
 * a silence. They are PASS lines — a refusal is a decision working, not a
 * fault — and they say the platform reason, never a roadmap.
 *
 * A capability WARNs only when this machine has booked something against it:
 * a rung is not a health check, and warning on a platform limit nobody can
 * act on is how doctor gets ignored (the absence-check lesson).
 */
const capabilityChecks = (
  liveStates: readonly SessionState[],
): readonly CursorCheck[] => {
  const summarizer = summarizeSummarizerCost(liveStates);
  const intentFails = liveStates.reduce(
    (total, state) => total + state.intentFailCount,
    0,
  );
  const intentLastFailure = liveStates.reduce<string | null>(
    (last, state) => state.intentLastFailure ?? last,
    null,
  );
  const ghostFails = liveStates.reduce(
    (total, state) => total + state.ghostFailCount,
    0,
  );
  const ghostLastFailure = liveStates.reduce<string | null>(
    (last, state) => state.ghostLastFailure ?? last,
    null,
  );
  const booked: Readonly<
    Record<string, { readonly count: number; readonly last: string | null }>
  > = {
    intent: { count: intentFails, last: intentLastFailure },
    ghost: { count: ghostFails, last: ghostLastFailure },
    summarizer: { count: summarizer.fails, last: summarizer.lastFailure },
    conference: { count: 0, last: null },
  };
  return CURSOR_CAPABILITY_MANIFEST.capabilities.map((capability) => {
    const outcome = booked[capability.name] ?? { count: 0, last: null };
    const detail = cursorCapabilityDetail({
      rung: capability.rung,
      sentence: capability.sentence,
      failures: outcome.count,
      lastFailure: outcome.last,
      note: capability.name === "summarizer" ? sliceShapeNote(liveStates) : null,
    });
    return check(
      outcome.count === 0 ? "PASS" : "WARN",
      `${capability.name} (cursor)`,
      detail,
    );
  });
};

/**
 * The CONDITIONAL refusal inside the summarizer rung, and the reason it is
 * its own line rather than a footnote on the one above: "your Cursor sends no
 * transcript" and "your model runner is broken" have nothing to do with each
 * other, and folding the first into the runner's WARN would send a reader
 * whose install is perfect to debug a binary that works. Only printed once
 * this machine has actually seen it — before that there is nothing to say.
 */
const transcriptRefusalCheck = (
  liveStates: readonly SessionState[],
): readonly CursorCheck[] => {
  const noTranscript = liveStates.filter(
    (state) => state.summarizerLastNoSlice === NO_SLICE_NO_TRANSCRIPT,
  );
  if (noTranscript.length === 0) {
    return [];
  }
  const turns = noTranscript.reduce(
    (total, state) => total + state.summarizerNoSliceCount,
    0,
  );
  return [
    check(
      "PASS",
      "summarizer transcript (cursor)",
      `this Cursor build provides no transcript — Tier-1 capture off; deterministic capture unaffected (${String(turns)} turn${turns === 1 ? "" : "s"} so far)`,
    ),
  ];
};

/** The refusals, always printed: a decision nobody can find is a bug. */
const refusalChecks = (): readonly CursorCheck[] =>
  CURSOR_CAPABILITY_MANIFEST.refusals.map((refusal) =>
    check("PASS", `${refusal.name} (cursor)`, refusal.sentence),
  );

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

  // THIS SECTION'S SESSIONS AND NOBODY ELSE'S. The caller hands every section
  // ONE scan of the session directory, and that scan filters on hub + repo
  // only (core state/session-state.ts readLiveSessionStates) — so on a machine
  // running Claude Code and Cursor in the same repo, which is this product's
  // own pitch, a Claude session's booked failure arrives here too. The ACP
  // twin has always filtered (connector-acp/src/doctor.ts) and its header
  // states the stake: a foreign session's failed fire lighting up this rung
  // makes the line stop meaning anything, in both directions — it cannot
  // answer "is MY Cursor rung failing" if it also counts someone else's.
  //
  // The prefix covers Cursor BACKGROUND agents too (host-session-key.ts: same
  // `cur-` namespace), so nothing Cursor-owned is filtered away.
  const cursorStates = (input.liveStates ?? []).filter((state) =>
    state.hostSessionKey.startsWith(CURSOR_HOST_KEY_PREFIX),
  );

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
    await injectionCheck(input.home),
    ...capabilityChecks(cursorStates),
    ...transcriptRefusalCheck(cursorStates),
    ...refusalChecks(),
  ];
};
