/**
 * Block 7 (design §3.3 + §5 row 7): the Cursor injection surfaces —
 * `sessionStart` briefing and failure-matched hints via the documented
 * `additional_context` output — driven through the REAL handlers
 * (`runCursorHook`), asserted on the REAL stdout JSON the hook prints.
 *
 * Parity contract (the Claude connector's SessionStart briefing +
 * UserPromptSubmit hint paths are the exact siblings): same kit calls
 * (`assembleBriefing`, `selectAndRenderHint`), same budgets, same caps —
 * 1 hint per event (structural: the selector returns ONE selection),
 * MAX_HINTS_PER_SESSION per session, seen-set persisted in session state,
 * echo-exclusion body hashes in the per-repo delivered store,
 * `hint_deliveries` telemetry rows with deterministic ids. Each is pinned
 * HERE through the cursor path, not assumed from the core flow suites.
 *
 * Open-q4 discipline: the hint attaches at EVERY documented failure signal
 * — postToolUse's embedded exitCode encoding and postToolUseFailure's
 * error_message — through the one shared flow, so whichever event reality
 * fires delivers it, and the seen-set claim — a locked check-and-set in the
 * core flow, first writer wins — makes double delivery impossible even when
 * both events fire CONCURRENTLY for one failure (pinned below).
 * The injection ledger records WHICH event delivered: the §6-q4 instrument
 * the dogfood checklist reads.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MAX_HINTS_PER_SESSION } from "@crosscheck/connector-core/constants.ts";
import { QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { registerSession } from "@crosscheck/connector-core/http/hub.ts";
import { readDeliveredHintHashes } from "@crosscheck/connector-core/hints/delivered-store.ts";
import { hintBodyHash } from "@crosscheck/connector-core/hints/echo.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { runCursorHook } from "../src/index.ts";
import { cursorDoctorChecks } from "../src/doctor.ts";
import {
  cursorInjectionOutput,
  deliveredAdditionalContext,
} from "../src/inject/output.ts";
import {
  injectionLedgerPath,
  readInjectionLedger,
  recordInjectionOutcome,
} from "../src/inject/ledger.ts";
import {
  CURSOR_DIR,
  CURSOR_HOOKS_FILE,
  MAX_INJECTION_LEDGER_BYTES,
} from "../src/constants.ts";
import {
  buildCursorHooksPlan,
  mergeCursorHooks,
} from "../src/init/hooks-merge.ts";
import {
  POST_TOOL_USE_FAILING_COMMAND,
  POST_TOOL_USE_FAILURE_DENIED,
  POST_TOOL_USE_FAILURE_INPUT,
  POST_TOOL_USE_FAILURE_INTERRUPT,
  POST_TOOL_USE_INPUT,
  SESSION_START_INPUT,
  SESSION_START_INPUT_BACKGROUND,
} from "./fixtures/cursor-contract/payloads.ts";
import { bootCursorHub } from "./fixtures/hub.ts";
import type { CursorTestHub } from "./fixtures/hub.ts";
import {
  CANDIDATE_BODY,
  CANDIDATE_CLAIM_ID,
  rejectedApproachCandidate,
} from "../../connector-core/test/fixtures/hint-hub.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const REMOTE = "git@github.com:acme/api.git";
const TIMEOUT_MS = "4000";

let hub: CursorTestHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCursorHub("cursor-injection");
});

afterAll(async () => {
  await hub.close();
});

afterEach(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
  cleanups.length = 0;
});

/**
 * A canned hub for the hint paths, LOCAL so the posted record bodies are
 * capturable — the shared hint-hub fixture answers but does not retain, and
 * the telemetry-idempotency pins below need to count `hint_delivery` rows.
 */
interface CapturingHub {
  readonly url: string;
  readonly calls: { candidates: number };
  readonly postedRecords: unknown[];
  readonly stop: () => void;
}

const startCapturingHub = (): CapturingHub => {
  const calls = { candidates: 0 };
  const postedRecords: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/hints/candidates") {
        calls.candidates += 1;
        return Response.json({
          ok: true,
          data: { candidates: [rejectedApproachCandidate()] },
        });
      }
      if (pathname === "/api/records") {
        const body = (await request.json()) as { records: readonly unknown[] };
        postedRecords.push(...body.records);
        return Response.json({
          ok: true,
          data: {
            accepted: body.records.length,
            duplicates: 0,
            ignored: 0,
            rejected: 0,
          },
        });
      }
      return Response.json({
        ok: true,
        data: { session: { id: "cc_x", developerId: "dev_self" } },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    postedRecords,
    stop: () => {
      server.stop(true);
    },
  };
};

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly key: string;
  readonly env: Env;
}

const fixture = async (label: string, hubUrl: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: REMOTE });
  const home = await makeHome(label);
  cleanups.push(repo, home);
  return {
    repo,
    home,
    key: repoKey(hubUrl, REPO_ID),
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    },
  };
};

/** Session state as sessionStart would have written it, `cur-` keyed. */
const seededState = (
  f: Fixture,
  hubUrl: string,
  conversationId: string,
  overrides: Partial<SessionState> = {},
): SessionState => ({
  hostSessionKey: `cur-${conversationId}`,
  crosscheckSessionId: `cc_cur-${conversationId}`,
  workContextId: `wc_cc_cur-${conversationId}`,
  repoId: REPO_ID,
  repoRoot: f.repo,
  hubUrl,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: null,
  seenTargets: [],
  deliveredHintRefs: [],
  deliveredHintHashes: [],
  tripwireAskedFiles: [],
  briefingSolvedRefs: [],
  foreignRepoDrops: 0,
  briefingPending: false,
  stopTurnCount: 0,
  summarizerFireCount: 0,
  summarizerLastFireTurn: null,
  summarizerEstimatedTokens: 0,
  summarizerNoneCount: 0,
  summarizerDraftCount: 0,
  ...overrides,
});

const inRepo = <T extends object>(
  payload: T,
  repo: string,
  conversationId: string,
): Record<string, unknown> => ({
  ...payload,
  conversation_id: conversationId,
  ...("session_id" in payload ? { session_id: conversationId } : {}),
  workspace_roots: [repo],
});

const run = (
  event: Parameters<typeof runCursorHook>[0],
  payload: Record<string, unknown>,
  env: Env,
): Promise<string> => runCursorHook(event, JSON.stringify(payload), env);

const parsedOutput = (out: string): Record<string, unknown> =>
  JSON.parse(out) as Record<string, unknown>;

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** A teammate session on the REAL hub, so the briefing has something to say. */
const seedTeammate = async (label: string): Promise<void> => {
  const response = await fetch(`${hub.hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: "Bearer cursor-injection-admin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Mara", email: `${label}@example.com` }),
  });
  const body = (await response.json()) as { data: { apiKey: string } };
  const mateHome = await makeHome(`${label}-mate`);
  cleanups.push(mateHome);
  const result = await registerSession(
    {
      hubUrl: hub.hubUrl,
      apiKey: body.data.apiKey,
      timeoutMs: 4000,
      home: mateHome,
      repoKey: repoKey(hub.hubUrl, REPO_ID),
      now: () => new Date(),
    },
    {
      id: `cc_mate-${label}`,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "feat/refresh-fix",
      baseCommit: "a1b2c3d4e5f6a7b8",
      status: "implementing",
    },
  );
  if (!result.ok) {
    throw new Error("teammate session did not register");
  }
};

describe("the notice + frame survive JSON encoding into the response shape", () => {
  test("a multi-line framed text round-trips byte-identically through the real stdout JSON", () => {
    // Arrange: newlines, the « » frame, quotes and backslashes — everything
    // JSON encoding could plausibly mangle.
    const text = `crosscheck facts about github.com/acme/api. ${QUOTED_DATA_NOTICE}\nTeammate work contexts on this repo:\n- Mara, 5m ago, status implementing: «fix "rate\\limit" retry»`;

    // Act
    const out = cursorInjectionOutput(text);

    // Assert: single-line valid JSON, exactly one key, lossless round trip.
    expect(out.includes("\n")).toBe(false);
    const parsed = parsedOutput(out);
    expect(Object.keys(parsed)).toEqual(["additional_context"]);
    expect(parsed["additional_context"]).toBe(text);
    expect(deliveredAdditionalContext(out)).toBe(text);
  });

  test("the output never carries a directive key", () => {
    const parsed = parsedOutput(cursorInjectionOutput("hello"));
    expect(parsed["permission"]).toBeUndefined();
    expect(parsed["followup_message"]).toBeUndefined();
    expect(parsed["continue"]).toBeUndefined();
    expect(parsed["env"]).toBeUndefined();
  });
});

describe("sessionStart briefing (§3.3): additional_context per the documented hook output", () => {
  test("a teammate on the hub → the briefing is delivered, framed, directive-free; the ledger counts it", async () => {
    // Arrange
    await seedTeammate("brief-mate");
    const f = await fixture("brief", hub.hubUrl);
    const conv = "conv-brief-1";

    // Act
    const out = await run(
      "sessionStart",
      inRepo(SESSION_START_INPUT, f.repo, conv),
      f.env,
    );

    // Assert: the REAL stdout JSON carries the core-rendered briefing.
    const parsed = parsedOutput(out);
    const context = parsed["additional_context"];
    if (typeof context !== "string") {
      throw new Error(`no additional_context in ${out}`);
    }
    expect(context).toContain(QUOTED_DATA_NOTICE);
    expect(context).toContain("Mara");
    expect(parsed["permission"]).toBeUndefined();
    expect(parsed["followup_message"]).toBeUndefined();
    expect(parsed["continue"]).toBeUndefined();
    // The session registered exactly as before — injection rides capture.
    const state = await readSessionState(f.home, `cur-${conv}`);
    expect(state?.crosscheckSessionId).toBe(`cc_cur-${conv}`);
    // Ledger: the delivered briefing is counted for doctor.
    const summary = await readInjectionLedger(f.home);
    expect(summary.briefings.delivered).toBe(1);
    expect(summary.briefings.suppressed).toBe(0);
  });

  test("solo developer → {} (empty briefing is silence) and a suppressed(empty) ledger row", async () => {
    // Arrange: a hub with nobody else on it — boot a private one so the
    // teammate seeded above cannot leak in.
    const solo = await bootCursorHub("cursor-injection-solo");
    try {
      const f = await fixture("brief-solo", solo.hubUrl);
      const env = { ...f.env, CROSSCHECK_API_KEY: solo.apiKey };

      // Act
      const out = await run(
        "sessionStart",
        inRepo(SESSION_START_INPUT, f.repo, "conv-solo-1"),
        env,
      );

      // Assert
      expect(out).toBe("{}");
      const summary = await readInjectionLedger(f.home);
      expect(summary.briefings.delivered).toBe(0);
      expect(summary.briefings.suppressed).toBe(1);
    } finally {
      await solo.close();
    }
  });

  test("background agent → no injection output even with a teammate present (§3.2 row 1)", async () => {
    // Arrange
    await seedTeammate("brief-bg-mate");
    const f = await fixture("brief-bg", hub.hubUrl);

    // Act
    const out = await run(
      "sessionStart",
      inRepo(SESSION_START_INPUT_BACKGROUND, f.repo, "conv-bg-1"),
      f.env,
    );

    // Assert: silence on stdout, the suppression counted with its reason.
    expect(out).toBe("{}");
    const summary = await readInjectionLedger(f.home);
    expect(summary.briefings.delivered).toBe(0);
    expect(summary.briefings.suppressed).toBe(1);
  });
});

describe("failure-matched hints (§3.3 + open-q4): every documented failure signal, one shared flow", () => {
  test("postToolUse with the documented embedded-exitCode encoding delivers ONE hint; seen-set, echo mark and telemetry all land", async () => {
    // Arrange
    const canned = startCapturingHub();
    try {
      const f = await fixture("hint-ptu", canned.url);
      const conv = "conv-hint-1";
      await writeSessionState(f.home, seededState(f, canned.url, conv));

      // Act
      const out = await run(
        "postToolUse",
        inRepo(POST_TOOL_USE_FAILING_COMMAND, f.repo, conv),
        f.env,
      );

      // Assert: the REAL stdout JSON carries the core-rendered hint.
      const parsed = parsedOutput(out);
      const context = parsed["additional_context"];
      if (typeof context !== "string") {
        throw new Error(`no additional_context in ${out}`);
      }
      expect(context).toContain(CANDIDATE_BODY);
      // Exactly ONE hint: one notice line (1/event ≡ the Claude 1/prompt).
      expect(countOf(context, QUOTED_DATA_NOTICE)).toBe(1);
      expect(parsed["permission"]).toBeUndefined();
      expect(parsed["followup_message"]).toBeUndefined();
      // Seen-set persisted in session state (no-repeats substrate).
      const state = await readSessionState(f.home, `cur-${conv}`);
      expect(state?.deliveredHintRefs).toContain(CANDIDATE_CLAIM_ID);
      // Echo-exclusion mark in the per-repo delivered store.
      const hashes = await readDeliveredHintHashes(f.home, f.key);
      expect(hashes).toContain(hintBodyHash(CANDIDATE_BODY));
      // hint_deliveries telemetry: exactly one row shipped.
      const deliveries = canned.postedRecords.filter(
        (record) => (record as { kind?: string }).kind === "hint_delivery",
      );
      expect(deliveries.length).toBe(1);
      // Ledger: delivered, attributed to the carrying event (q4 instrument).
      const summary = await readInjectionLedger(f.home);
      expect(summary.hints.delivered).toBe(1);
      expect(summary.hintEvents["postToolUse"]).toBe(1);
    } finally {
      canned.stop();
    }
  });

  test("the SAME failure again → {} — the seen-set forbids a repeat delivery, and no second telemetry row exists", async () => {
    // Arrange
    const canned = startCapturingHub();
    try {
      const f = await fixture("hint-repeat", canned.url);
      const conv = "conv-hint-repeat";
      await writeSessionState(f.home, seededState(f, canned.url, conv));

      // Act: the identical failing event twice.
      const first = await run(
        "postToolUse",
        inRepo(POST_TOOL_USE_FAILING_COMMAND, f.repo, conv),
        f.env,
      );
      const second = await run(
        "postToolUse",
        inRepo(POST_TOOL_USE_FAILING_COMMAND, f.repo, conv),
        f.env,
      );

      // Assert
      expect(typeof parsedOutput(first)["additional_context"]).toBe("string");
      expect(second).toBe("{}");
      const state = await readSessionState(f.home, `cur-${conv}`);
      expect(state?.deliveredHintRefs.length).toBe(1);
      const deliveries = canned.postedRecords.filter(
        (record) => (record as { kind?: string }).kind === "hint_delivery",
      );
      expect(deliveries.length).toBe(1);
      const summary = await readInjectionLedger(f.home);
      expect(summary.hints.delivered).toBe(1);
      expect(summary.hints.suppressed).toBe(1);
    } finally {
      canned.stop();
    }
  });

  test("BOTH failure signals firing CONCURRENTLY for one failure deliver exactly one hint — first writer wins under the state lock", async () => {
    // Arrange: the open-q4 both-fire case, actually concurrent — two hook
    // processes racing one failure, which sequential runs cannot see.
    const canned = startCapturingHub();
    try {
      const f = await fixture("hint-concurrent", canned.url);
      const conv = "conv-hint-concurrent";
      await writeSessionState(f.home, seededState(f, canned.url, conv));

      // Act
      const [ptu, ptuf] = await Promise.all([
        run(
          "postToolUse",
          inRepo(POST_TOOL_USE_FAILING_COMMAND, f.repo, conv),
          f.env,
        ),
        run(
          "postToolUseFailure",
          inRepo(POST_TOOL_USE_FAILURE_INPUT, f.repo, conv),
          f.env,
        ),
      ]);

      // Assert: exactly ONE of the two outputs carried the hint…
      const delivered = [ptu, ptuf].filter(
        (out) => typeof parsedOutput(out)["additional_context"] === "string",
      );
      expect(delivered.length).toBe(1);
      // …one cap slot spent, no doubled ref…
      const state = await readSessionState(f.home, `cur-${conv}`);
      expect(state?.deliveredHintRefs).toEqual([CANDIDATE_CLAIM_ID]);
      // …telemetry converges on ONE deterministic delivery id (a loser that
      // raced far enough to spool appends the SAME primary key — the real
      // hub dedups it; the id set makes that visible here)…
      const deliveryIds = new Set(
        canned.postedRecords
          .filter(
            (record) => (record as { kind?: string }).kind === "hint_delivery",
          )
          .map(
            (record) => (record as { body?: { id?: string } }).body?.id,
          ),
      );
      expect(deliveryIds.size).toBe(1);
      // …and the §6-q4 instrument counts what the hub counts: one delivery.
      const summary = await readInjectionLedger(f.home);
      expect(summary.hints.delivered).toBe(1);
    } finally {
      canned.stop();
    }
  });

  test("postToolUseFailure delivers the same hint through the tolerantly-emitted channel, ledger names the event", async () => {
    // Arrange
    const canned = startCapturingHub();
    try {
      const f = await fixture("hint-ptuf", canned.url);
      const conv = "conv-hint-ptuf";
      await writeSessionState(f.home, seededState(f, canned.url, conv));

      // Act
      const out = await run(
        "postToolUseFailure",
        inRepo(POST_TOOL_USE_FAILURE_INPUT, f.repo, conv),
        f.env,
      );

      // Assert: additional_context emitted per the shared response shape —
      // the documented postToolUseFailure output has no fields, so a build
      // that ignores this degrades silently; the ledger row is the record
      // of which event carried the delivery (the dogfood reads it).
      const parsed = parsedOutput(out);
      expect(typeof parsed["additional_context"]).toBe("string");
      const summary = await readInjectionLedger(f.home);
      expect(summary.hints.delivered).toBe(1);
      expect(summary.hintEvents["postToolUseFailure"]).toBe(1);
    } finally {
      canned.stop();
    }
  });

  test("interrupts and permission denials attempt NO hint — zero candidate calls", async () => {
    // Arrange
    const canned = startCapturingHub();
    try {
      const f = await fixture("hint-noattempt", canned.url);
      const conv = "conv-hint-noattempt";
      await writeSessionState(f.home, seededState(f, canned.url, conv));

      // Act
      const interrupt = await run(
        "postToolUseFailure",
        inRepo(POST_TOOL_USE_FAILURE_INTERRUPT, f.repo, conv),
        f.env,
      );
      const denied = await run(
        "postToolUseFailure",
        inRepo(POST_TOOL_USE_FAILURE_DENIED, f.repo, conv),
        f.env,
      );

      // Assert
      expect(interrupt).toBe("{}");
      expect(denied).toBe("{}");
      expect(canned.calls.candidates).toBe(0);
    } finally {
      canned.stop();
    }
  });

  test("a SUCCESSFUL tool result attempts no hint — the failure branch is the only query source", async () => {
    // Arrange
    const canned = startCapturingHub();
    try {
      const f = await fixture("hint-success", canned.url);
      const conv = "conv-hint-success";
      await writeSessionState(f.home, seededState(f, canned.url, conv));

      // Act
      const out = await run(
        "postToolUse",
        inRepo(POST_TOOL_USE_INPUT, f.repo, conv),
        f.env,
      );

      // Assert
      expect(out).toBe("{}");
      expect(canned.calls.candidates).toBe(0);
    } finally {
      canned.stop();
    }
  });

  test("the session cap holds: at MAX_HINTS_PER_SESSION delivered refs the flow goes silent before any hub call", async () => {
    // Arrange
    const canned = startCapturingHub();
    try {
      const f = await fixture("hint-cap", canned.url);
      const conv = "conv-hint-cap";
      await writeSessionState(
        f.home,
        seededState(f, canned.url, conv, {
          deliveredHintRefs: Array.from(
            { length: MAX_HINTS_PER_SESSION },
            (_, index) => `clm_prior_${index}`,
          ),
        }),
      );

      // Act
      const out = await run(
        "postToolUse",
        inRepo(POST_TOOL_USE_FAILING_COMMAND, f.repo, conv),
        f.env,
      );

      // Assert
      expect(out).toBe("{}");
      expect(canned.calls.candidates).toBe(0);
    } finally {
      canned.stop();
    }
  });
});

describe("injection ledger mechanics (the drift-ledger discipline, new file)", () => {
  test("rows accumulate per kind/outcome/event and read back as counters", async () => {
    // Arrange
    const home = await makeHome("ledger-roundtrip");
    cleanups.push(home);

    // Act
    await recordInjectionOutcome(home, {
      kind: "briefing",
      outcome: "delivered",
      event: "sessionStart",
    });
    await recordInjectionOutcome(home, {
      kind: "hint",
      outcome: "delivered",
      event: "postToolUse",
    });
    await recordInjectionOutcome(home, {
      kind: "hint",
      outcome: "suppressed",
      event: "postToolUseFailure",
      reason: "silence",
    });

    // Assert
    const summary = await readInjectionLedger(home);
    expect(summary.briefings.delivered).toBe(1);
    expect(summary.hints.delivered).toBe(1);
    expect(summary.hints.suppressed).toBe(1);
    expect(summary.hintEvents["postToolUse"]).toBe(1);
    expect(summary.lastDeliveredAt).not.toBeNull();
    expect(summary.malformed).toBe(0);
    expect(summary.atCap).toBe(false);
  });

  test("malformed lines are counted, never silently skipped; a full ledger stops detail and says so", async () => {
    // Arrange
    const home = await makeHome("ledger-cap");
    cleanups.push(home);
    const path = injectionLedgerPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `not-json\n${"x".repeat(MAX_INJECTION_LEDGER_BYTES)}\n`);

    // Act
    await recordInjectionOutcome(home, {
      kind: "hint",
      outcome: "delivered",
      event: "postToolUse",
    });
    const summary = await readInjectionLedger(home);

    // Assert: past the cap the append was refused — counts are a floor.
    expect(summary.malformed).toBeGreaterThan(0);
    expect(summary.atCap).toBe(true);
    expect(summary.hints.delivered).toBe(0);
  });
});

describe("doctor: the cursor section reports injection state from the ledger", () => {
  test("delivered/suppressed counters and the per-event hint breakdown reach the doctor line", async () => {
    // Arrange: an installed hooks.json (owned entries, absolute launcher so
    // nothing executes) and a ledger with one of everything.
    const f = await fixture("doctor-injection", hub.hubUrl);
    const hooksPath = join(f.repo, CURSOR_DIR, CURSOR_HOOKS_FILE);
    await mkdir(dirname(hooksPath), { recursive: true });
    const plan = buildCursorHooksPlan("/opt/crosscheck/bin/crosscheck");
    await writeFile(hooksPath, JSON.stringify(mergeCursorHooks({}, plan)));
    await recordInjectionOutcome(f.home, {
      kind: "briefing",
      outcome: "delivered",
      event: "sessionStart",
    });
    await recordInjectionOutcome(f.home, {
      kind: "hint",
      outcome: "delivered",
      event: "postToolUse",
    });
    await recordInjectionOutcome(f.home, {
      kind: "hint",
      outcome: "suppressed",
      event: "postToolUse",
      reason: "silence",
    });

    // Act
    const checks = await cursorDoctorChecks({
      repoRoot: f.repo,
      env: f.env,
      home: f.home,
      repoKey: f.key,
    });

    // Assert
    const injection = checks.find((check) => check.name === "cursor injection");
    if (injection === undefined) {
      throw new Error("no cursor injection check emitted");
    }
    expect(injection.level).toBe("PASS");
    expect(injection.detail).toContain("briefings 1 delivered");
    expect(injection.detail).toContain("hints 1 delivered");
    expect(injection.detail).toContain("1 suppressed");
    expect(injection.detail).toContain("postToolUse");
  });

  test("no injection activity yet → an honest PASS, not a warning nobody can act on", async () => {
    // Arrange
    const f = await fixture("doctor-injection-empty", hub.hubUrl);
    const hooksPath = join(f.repo, CURSOR_DIR, CURSOR_HOOKS_FILE);
    await mkdir(dirname(hooksPath), { recursive: true });
    const plan = buildCursorHooksPlan("/opt/crosscheck/bin/crosscheck");
    await writeFile(hooksPath, JSON.stringify(mergeCursorHooks({}, plan)));

    // Act
    const checks = await cursorDoctorChecks({
      repoRoot: f.repo,
      env: f.env,
      home: f.home,
      repoKey: f.key,
    });

    // Assert
    const injection = checks.find((check) => check.name === "cursor injection");
    expect(injection?.level).toBe("PASS");
    expect(injection?.detail).toContain("none recorded yet");
  });
});
