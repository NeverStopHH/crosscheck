/**
 * PostToolUseFailure end to end (VISION.md §1 collective memory).
 *
 * Two things are pinned here, and the first is a CAPTURE defect rather than
 * a feature: Claude Code's PostToolUse fires when a tool completes
 * SUCCESSFULLY and routes failures to PostToolUseFailure, which this
 * connector never registered — so a failing `bun test` produced no
 * `error_fingerprint` target at all, and the strongest matching signal the
 * product has had no input on its main host. The second is the delivery that
 * fingerprint then earns: the moment the symptom appears, not at the next
 * SessionStart, which on a long agent turn can be an hour later.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const SOLVED_CONTEXT_ID = "wc_prev";
const SOLVED_ROOT_CAUSE = "The ingestion mapping drops the key id on rotation";
const FAILURE_TEXT =
  "Exit code 1\nerror: expected 3 to be 4\n  at limiter.test.ts";

interface RecordedEnvelope {
  readonly kind: string;
  readonly body: Record<string, unknown>;
}

interface FakeHub {
  readonly url: string;
  readonly recordsSeen: RecordedEnvelope[];
  readonly solvedQueries: string[];
  readonly stop: () => void;
}

/** A hub that answers the fingerprint probe with `matches`. */
const startHub = (matches: readonly unknown[]): FakeHub => {
  const recordsSeen: RecordedEnvelope[] = [];
  const solvedQueries: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/records") {
        const body = (await request.json()) as {
          records: readonly RecordedEnvelope[];
        };
        recordsSeen.push(...body.records);
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
      if (url.pathname === "/api/solved-matches") {
        const probe = url.searchParams.get("fingerprint");
        // The LISTING (no fingerprint) answers nothing on purpose: at
        // SessionStart this session has captured no target yet, so the
        // briefing has nothing to match on. Answering it here would put the
        // tree in `briefingSolvedRefs` and the seen-set would then correctly
        // silence the failure hint — the very path under test.
        if (probe === null) {
          return Response.json({ ok: true, data: { matches: [] } });
        }
        solvedQueries.push(probe);
        return Response.json({ ok: true, data: { matches } });
      }
      if (url.pathname === "/api/presence") {
        return Response.json({ ok: true, data: { sessions: [] } });
      }
      if (url.pathname === "/api/work-contexts") {
        return Response.json({ ok: true, data: { workContexts: [] } });
      }
      return Response.json({
        ok: true,
        data: { session: { id: "cc_x", developerId: "dev_self" } },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    recordsSeen,
    solvedQueries,
    stop: () => {
      server.stop(true);
    },
  };
};

const solvedMatch = (): Record<string, unknown> => ({
  workContextId: SOLVED_CONTEXT_ID,
  title: "Refresh 500s after key rotation",
  developerName: "Robin",
  repo: "github.com/acme/web",
  solvedAt: "2026-03-12T08:00:00.000Z",
  landedAt: null,
  matchedTargetKind: "error_fingerprint",
  rootCause: SOLVED_ROOT_CAUSE,
});

const paths: string[] = [];
const hubs: FakeHub[] = [];

afterEach(async () => {
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: FakeHub;
  readonly env: Env;
}

const fixture = async (
  label: string,
  matches: readonly unknown[] = [solvedMatch()],
): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startHub(matches);
  hubs.push(hub);
  return {
    repo,
    home,
    hub,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: "2000",
    },
  };
};

const sessionStart = (repo: string, sessionId: string): string =>
  JSON.stringify({
    session_id: sessionId,
    cwd: repo,
    hook_event_name: "SessionStart",
    source: "startup",
  });

const failurePayload = (
  repo: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    session_id: sessionId,
    cwd: repo,
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "bun test" },
    error: FAILURE_TEXT,
    is_interrupt: false,
    ...overrides,
  });

const fingerprintTargets = (hub: FakeHub): readonly string[] =>
  hub.recordsSeen
    .filter(
      (record) =>
        record.kind === "target" && record.body["kind"] === "error_fingerprint",
    )
    .map((record) => String(record.body["value"]));

const injectedContext = (stdout: string): string => {
  if (stdout.length === 0) {
    return "";
  }
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  expect(parsed.hookSpecificOutput?.hookEventName).toBe("PostToolUseFailure");
  return parsed.hookSpecificOutput?.additionalContext ?? "";
};

describe("PostToolUseFailure", () => {
  test("a failing tool records the fingerprint and is told it was solved", async () => {
    // Arrange
    const f = await fixture("ptuf-happy");
    await runHook("session-start", sessionStart(f.repo, "s1"), f.env);

    // Act
    const stdout = await runHook(
      "post-tool-use-failure",
      failurePayload(f.repo, "s1"),
      f.env,
    );

    // Assert: the symptom was captured — the half that makes THIS failure
    // findable for the next person…
    const captured = fingerprintTargets(f.hub);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatch(/^sha256:[0-9a-f]{32}$/);
    // …the probe asked with that exact fingerprint, never the failure text…
    expect(f.hub.solvedQueries).toEqual([captured[0] ?? ""]);
    expect(f.hub.solvedQueries[0]).not.toContain("limiter.test.ts");
    // …and the answer came back on THIS turn, with its recorded cause.
    const injected = injectedContext(stdout);
    expect(injected).toContain(`get_diagnosis ${SOLVED_CONTEXT_ID}`);
    expect(injected).toContain(SOLVED_ROOT_CAUSE);
    // One hint slot spent, claimed before the text was returned.
    const state = await readSessionState(f.home, "s1");
    expect(state?.deliveredHintRefs).toEqual([SOLVED_CONTEXT_ID]);
  });

  test("an interrupted tool is not a failure — nothing captured, nothing said", async () => {
    // Arrange: the developer pressed escape. The CONTRAST runs first, so
    // this cannot pass by the hook simply doing nothing at all.
    const f = await fixture("ptuf-interrupt");
    await runHook("session-start", sessionStart(f.repo, "s1"), f.env);
    const real = await runHook(
      "post-tool-use-failure",
      failurePayload(f.repo, "s1"),
      f.env,
    );
    expect(real.length).toBeGreaterThan(0);

    // Act
    const aborted = await runHook(
      "post-tool-use-failure",
      failurePayload(f.repo, "s1", {
        error: "Interrupted by user",
        is_interrupt: true,
      }),
      f.env,
    );

    // Assert: still exactly the one fingerprint from the real failure.
    expect(aborted).toBe("");
    expect(fingerprintTargets(f.hub)).toHaveLength(1);
  });

  test("an unregistered session captures nothing and registers nothing", async () => {
    // Arrange: a REGISTERED session first, so "silence" cannot be mistaken
    // for a hook that never runs — then the same failure under a session id
    // nobody started. A failure is never worth a hub round trip to invent a
    // session for.
    const f = await fixture("ptuf-nostate");
    await runHook("session-start", sessionStart(f.repo, "s1"), f.env);
    await runHook(
      "post-tool-use-failure",
      failurePayload(f.repo, "s1"),
      f.env,
    );
    expect(f.hub.solvedQueries).toHaveLength(1);

    // Act
    const stdout = await runHook(
      "post-tool-use-failure",
      failurePayload(f.repo, "s-unknown"),
      f.env,
    );

    // Assert: no second probe, no output, nothing registered.
    expect(stdout).toBe("");
    expect(f.hub.solvedQueries).toHaveLength(1);
  });

  test("a hub with nothing solved still captures the fingerprint", async () => {
    // Arrange: capture is the half that must never depend on the answer.
    const f = await fixture("ptuf-unsolved", []);
    await runHook("session-start", sessionStart(f.repo, "s1"), f.env);

    // Act
    const stdout = await runHook(
      "post-tool-use-failure",
      failurePayload(f.repo, "s1"),
      f.env,
    );

    // Assert
    expect(stdout).toBe("");
    expect(fingerprintTargets(f.hub)).toHaveLength(1);
  });
});
