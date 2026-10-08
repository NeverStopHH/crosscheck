/**
 * A content-free prompt through the REAL hooks (DESIGN.md §4): "mache
 * weiter", "ja", a retry note. The hint half may go quiet or match the
 * session's intent instead — and NOTHING about what the agent then does is
 * captured any differently. Capture never depended on what the prompt said;
 * these tests keep it that way, against the one change that could have made
 * it so (the prompt path now reads the session's intent).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { HTTP_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import {
  injectableCandidate,
  startHintHub,
} from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const REPO_ID = "github.com/acme/api";
const EDITED_FILE = "src/limiter.ts";
const SESSION_INTENT = "Make the practice video upload survive the gateway body limit";

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly hub: HintHub;
  readonly env: Env;
  readonly sessionId: string;
}

const fixture = async (label: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  await writeRepoFile(repo, EDITED_FILE, "export const a = 1;\n");
  const hub = startHintHub();
  // A hub that finds nothing for the content-free prompt, as a real one does
  // (server test/hint-content-floor.test.ts) — so the only thing the prompt
  // hook could change here is state, never a delivery record.
  hub.setCandidates([]);
  hubs.push(hub);
  const sessionId = `${label}-uuid`;
  await writeSessionState(home, {
    hostSessionKey: sessionId,
    crosscheckSessionId: `cc_${sessionId}`,
    workContextId: `wc_cc_${sessionId}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: hub.url,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: null,
    seenTargets: [],
    deliveredHintRefs: [],
    deliveredHintHashes: [],
    tripwireAskedFiles: [],
    landedAskedFiles: [],
    landedCleanKeys: [],
    workContextIntent: SESSION_INTENT,
  });
  return {
    repo,
    home,
    hub,
    sessionId,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
      // A fired intent worker must never reach a real model from a test.
      CROSSCHECK_SUMMARIZER_CMD: "/usr/bin/false",
    },
  };
};

const promptPayload = (f: Fixture, prompt: string): string =>
  JSON.stringify({
    session_id: f.sessionId,
    cwd: f.repo,
    hook_event_name: "UserPromptSubmit",
    prompt,
  });

const editPayload = (f: Fixture): string =>
  JSON.stringify({
    session_id: f.sessionId,
    cwd: f.repo,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: `${f.repo}/${EDITED_FILE}` },
    tool_response: {},
  });

interface SpooledRecord {
  readonly kind: string;
  readonly body: Record<string, unknown>;
}

/**
 * Everything capture produced — what the hooks already shipped to the hub
 * (PostToolUse flushes) and what is still spooled — as one list.
 */
const capturedRecords = async (f: Fixture): Promise<readonly SpooledRecord[]> => {
  const lines = await readSpoolLines(f.home, repoKey(f.hub.url, REPO_ID));
  return [
    ...(f.hub.postedRecords as readonly unknown[] as readonly SpooledRecord[]),
    ...lines.map((line) => JSON.parse(line) as SpooledRecord),
  ];
};

/**
 * What capture wrote, minus what differs between any two sessions by
 * construction — ids and instants: the record kinds in order, and every
 * target's kind and value.
 */
const capturedShape = async (f: Fixture): Promise<readonly string[]> =>
  (await capturedRecords(f)).map((record) =>
      record.kind === "target"
      ? `target ${String(record.body["kind"])} ${String(record.body["value"])}`
      : record.kind,
  );

/** The capture counters session state keeps per tool event — none is path- or id-shaped. */
const captureCounters = async (f: Fixture): Promise<Record<string, unknown>> => {
  const state = await readSessionState(f.home, f.sessionId);
  return {
    editToolFires: state?.editToolFires,
    targetsCapturedCount: state?.targetsCapturedCount,
    lastPostToolUseTool: state?.lastPostToolUseTool,
    seenTargets: state?.seenTargets.length,
    foreignRepoDrops: state?.foreignRepoDrops,
    outsideRootDrops: state?.outsideRootDrops,
  };
};

/** A background task's notification, delivered by Claude Code as a user turn (live, 0.10.0). */
const TASK_NOTIFICATION =
  "<task-notification><task-id>bp1v5vsl4</task-id>" +
  '<summary>Monitor event: "PR #74 CI checks for 493ffb4f"</summary>' +
  "<event>Comment claims (macos-latest): pass</event></task-notification>";

/** The turns the live pilot pointed on: content-free human prompts and harness turns. */
const FLOORED_TURNS = [
  ["mache weiter"],
  ["macxhe weiter, limit ist zurukgsetz"],
  ["mache weiter, limit zuruckgesetzt. bitte alles wiederuafnhemen"],
  ["ja"],
  [TASK_NOTIFICATION],
  [`[SYSTEM NOTIFICATION - NOT USER INPUT]\n${TASK_NOTIFICATION}`],
  ['<agent-message from="a781e1e961b68f4c2">Report: CI checks pass</agent-message>'],
  ['<cross-session-message from="ken">PR #74 checks pass</cross-session-message>'],
] as const;

describe("capture after a content-free prompt is capture as usual", () => {
  test("a harness turn gets no hint even with a teammate candidate waiting — and capture is untouched", async () => {
    // Arrange — this hub would answer with an injectable candidate
    const prompted = await fixture("cf-harness");
    const control = await fixture("cf-harness-control");
    prompted.hub.setCandidates([injectableCandidate()]);

    // Act
    const hint = await runHook("user-prompt-submit", promptPayload(prompted, TASK_NOTIFICATION), prompted.env);
    await runHook("post-tool-use", editPayload(prompted), prompted.env);
    await runHook("post-tool-use", editPayload(control), control.env);

    // Assert — the pointer is what was suppressed, and nothing else
    expect(hint).toBe("");
    expect(prompted.hub.calls.candidates).toBe(0);
    expect(await capturedShape(prompted)).toEqual(await capturedShape(control));
    expect(await captureCounters(prompted)).toEqual(await captureCounters(control));
  });

  test.each(FLOORED_TURNS)(
    "an edit after %p is captured exactly as an edit with no prompt before it",
    async (prompt) => {
      // Arrange — two sessions, identical but for the prompt
      const prompted = await fixture("cf-prompted");
      const control = await fixture("cf-control");

      // Act
      const hint = await runHook("user-prompt-submit", promptPayload(prompted, prompt), prompted.env);
      await runHook("post-tool-use", editPayload(prompted), prompted.env);
      await runHook("post-tool-use", editPayload(control), control.env);

      // Assert — no hint, and the same capture, target for target…
      expect(hint).toBe("");
      const shape = await capturedShape(prompted);
      expect(shape).toEqual(await capturedShape(control));
      expect(shape).toContain(`target file ${EDITED_FILE}`);
      // …and the same tool-event bookkeeping, counter for counter
      expect(await captureCounters(prompted)).toEqual(await captureCounters(control));
      expect((await captureCounters(prompted)).editToolFires).toBe(1);
    },
  );
});

describe("a turn that carries no task never spends the session's one intent fire (H2)", () => {
  const TASK_PROMPT = "why does the refresh call 500 after the key rotation on staging";

  test.each(FLOORED_TURNS)("%p leaves the fire for the next real prompt", async (turn) => {
    // Arrange
    const f = await fixture("cf-intent-fire");

    // Act — the floored turn, then a real task
    await runHook("user-prompt-submit", promptPayload(f, turn), f.env);
    const afterTurn = (await readSessionState(f.home, f.sessionId))?.intentFireCount;
    await runHook("user-prompt-submit", promptPayload(f, TASK_PROMPT), f.env);
    const afterTask = (await readSessionState(f.home, f.sessionId))?.intentFireCount;

    // Assert
    expect(afterTurn).toBe(0);
    expect(afterTask).toBe(1);
  });

  test.each([
    ["okay so the usage limit was reset a few minutes ago, please just continue with whatever you were doing"],
    ["mach weiter, das usage limit ist wieder da, bitte alles wiederaufnehmen"],
    ["the weekly usage limit expired a moment ago, please keep going with everything"],
    ["ok, commit and push, then open the PR and run the tests again please"],
  ])("the hold-out review's long session commands spend no fire either: %p (H3)", async (turn) => {
    // Arrange — each is long enough to state a task, and states none
    const f = await fixture("cf-intent-holdout");

    // Act
    await runHook("user-prompt-submit", promptPayload(f, turn), f.env);

    // Assert — floored, counted, and the fire still unspent
    const state = await readSessionState(f.home, f.sessionId);
    expect(state?.intentFireCount).toBe(0);
    expect(state?.flooredPromptCount).toBe(1);
  });
});

describe("the prompt stays on this machine, and nothing travels in its place", () => {
  test("a prompt with no searchable word makes no call — the session's intent does not stand in (M6)", async () => {
    // Arrange — the session HAS an intent
    const f = await fixture("cf-wire");

    // Act
    await runHook("user-prompt-submit", promptPayload(f, "ja ok"), f.env);

    // Assert
    expect(f.hub.calls.candidates).toBe(0);
  });

  test("the prompt lands in no file the hooks write", async () => {
    // Arrange
    const f = await fixture("cf-files");
    const marker = "QZXPROMPTMARKER";

    // Act
    await runHook("user-prompt-submit", promptPayload(f, `${marker} weiter`), f.env);
    await runHook("post-tool-use", editPayload(f), f.env);

    // Assert — records were written (and shipped), and none carries it
    const records = await capturedRecords(f);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(marker);
    const state = await readSessionState(f.home, f.sessionId);
    expect(JSON.stringify(state)).not.toContain(marker);
  });
});
