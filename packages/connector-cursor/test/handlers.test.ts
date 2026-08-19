/**
 * The §3.2 mapping, row by row, through the REAL handlers against a REAL
 * in-process hub — the contract fixtures (test/fixtures/cursor-contract)
 * are the inputs, so every assertion here is also a pin on the documented
 * payload shapes. Presence, targets and fingerprints must LAND; every
 * output must be directive-free JSON.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { fingerprint } from "@crosscheck/connector-core/capture/fingerprint.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { getDiagnosis, getPresence } from "@crosscheck/connector-core/http/hub.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { readSpoolLines } from "@crosscheck/connector-core/spool/files.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { readSyncState } from "@crosscheck/connector-core/state/sync-state.ts";

import { runCursorHook } from "../src/index.ts";
import type { CursorHookEvent } from "../src/index.ts";
import { bootCursorHub } from "./fixtures/hub.ts";
import type { CursorTestHub } from "./fixtures/hub.ts";
import {
  AFTER_FILE_EDIT_INPUT,
  AFTER_SHELL_EXECUTION_INPUT,
  AFTER_SHELL_EXECUTION_WITH_EXIT,
  POST_TOOL_USE_FAILING_COMMAND,
  POST_TOOL_USE_FAILURE_DENIED,
  POST_TOOL_USE_FAILURE_INPUT,
  POST_TOOL_USE_FAILURE_INTERRUPT,
  POST_TOOL_USE_INPUT,
  SESSION_END_INPUT,
  SESSION_START_INPUT,
  SESSION_START_INPUT_BACKGROUND,
  STOP_INPUT,
} from "./fixtures/cursor-contract/payloads.ts";
import {
  makeHome,
  makeRepo,
  writeRepoFile,
} from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const REMOTE = "git@github.com:acme/api.git";
/** Port 1 refuses instantly: an unreachable hub without the wait. */
const DEAD_HUB_URL = "http://127.0.0.1:1";
const TIMEOUT_MS = "4000";

let hub: CursorTestHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCursorHub("cursor-handlers");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly env: Env;
  readonly hubCtx: HubContext;
  readonly key: string;
}

const fixture = async (
  label: string,
  hubUrl: string = hub.hubUrl,
): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: REMOTE });
  const home = await makeHome(label);
  cleanups.push(repo, home);
  const key = repoKey(hubUrl, REPO_ID);
  return {
    repo,
    home,
    key,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    },
    hubCtx: {
      hubUrl,
      apiKey: hub.apiKey,
      timeoutMs: 4000,
      home,
      repoKey: key,
      now: () => new Date(),
    },
  };
};

/** A fixture payload rooted in the test's real repo, distinct conversation. */
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
  event: CursorHookEvent,
  payload: Record<string, unknown>,
  env: Env,
): Promise<string> => runCursorHook(event, JSON.stringify(payload), env);

describe("sessionStart (§3.2 row 1)", () => {
  test("registers cc_cur-<conversation_id> on the hub, records cursor_version, answers {}", async () => {
    // Arrange
    const f = await fixture("start");
    const conv = "conv-start-1";

    // Act
    const out = await run("sessionStart", inRepo(SESSION_START_INPUT, f.repo, conv), f.env);

    // Assert: directive-free output, state before append, presence landed.
    expect(out).toBe("{}");
    const state = await readSessionState(f.home, `cur-${conv}`);
    expect(state?.crosscheckSessionId).toBe(`cc_cur-${conv}`);
    expect(state?.workContextId).toBe(`wc_cc_cur-${conv}`);
    const presence = await getPresence(f.hubCtx, REPO_ID);
    if (!presence.ok) throw new Error("presence unavailable");
    expect(
      presence.data.some((entry) => entry.sessionId === `cc_cur-${conv}`),
    ).toBe(true);
    // cursor_version → sync-state, doctor's ≥1.7 evidence.
    const sync = await readSyncState(f.home, f.key);
    expect(sync.cursorVersion).toBe(SESSION_START_INPUT.cursor_version);
  });

  test("dead hub: work context spools with agent_kind cursor-ide; background variant cursor-background", async () => {
    // Arrange: unreachable hub — the spool keeps the evidence.
    const f = await fixture("start-kind", DEAD_HUB_URL);
    const key = repoKey(DEAD_HUB_URL, REPO_ID);

    // Act
    await run("sessionStart", inRepo(SESSION_START_INPUT, f.repo, "conv-kind-a"), f.env);
    await run(
      "sessionStart",
      inRepo(SESSION_START_INPUT_BACKGROUND, f.repo, "conv-kind-b"),
      f.env,
    );

    // Assert
    const producers = (await readSpoolLines(f.home, key))
      .map((line) => JSON.parse(line) as { kind: string; producer: { agentKind: string } })
      .filter((record) => record.kind === "work_context")
      .map((record) => record.producer.agentKind)
      .sort();
    expect(producers).toEqual(["cursor-background", "cursor-ide"]);
  });
});

describe("afterFileEdit (§3.2 row 2)", () => {
  test("captures the repo-relative path; denylisted and out-of-repo paths never land; seen-set dedups", async () => {
    // Arrange
    const f = await fixture("edit");
    const conv = "conv-edit-1";
    await writeRepoFile(f.repo, "src/rate-limit.ts", "export const a = 1;\n");
    await run("sessionStart", inRepo(SESSION_START_INPUT, f.repo, conv), f.env);

    // Act: a real edit, a denylisted file, an out-of-repo path, a replay.
    const edit = (path: string): Record<string, unknown> => ({
      ...inRepo(AFTER_FILE_EDIT_INPUT, f.repo, conv),
      file_path: path,
    });
    await run("afterFileEdit", edit(`${f.repo}/src/rate-limit.ts`), f.env);
    await run("afterFileEdit", edit(`${f.repo}/.env`), f.env);
    await run("afterFileEdit", edit("/etc/passwd"), f.env);
    await run("afterFileEdit", edit(`${f.repo}/src/rate-limit.ts`), f.env);

    // Assert
    const diagnosis = await getDiagnosis(f.hubCtx, `wc_cc_cur-${conv}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    const files = diagnosis.data.targets
      .filter((target) => target.kind === "file")
      .map((target) => target.value);
    expect(files).toEqual(["src/rate-limit.ts"]);
  });

  test("hooks installed mid-conversation recover: no sessionStart ever fired, the target still lands", async () => {
    // Arrange
    const f = await fixture("edit-recover");
    const conv = "conv-recover-1";
    await writeRepoFile(f.repo, "src/limiter.ts", "export const b = 2;\n");

    // Act: afterFileEdit with no prior state file.
    await run(
      "afterFileEdit",
      {
        ...inRepo(AFTER_FILE_EDIT_INPUT, f.repo, conv),
        file_path: `${f.repo}/src/limiter.ts`,
      },
      f.env,
    );

    // Assert: the shared register flow reconstructed the session
    // (state-before-append), and the target landed under it.
    const state = await readSessionState(f.home, `cur-${conv}`);
    expect(state?.crosscheckSessionId).toBe(`cc_cur-${conv}`);
    const diagnosis = await getDiagnosis(f.hubCtx, `wc_cc_cur-${conv}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    expect(
      diagnosis.data.targets.some((target) => target.value === "src/limiter.ts"),
    ).toBe(true);
  });
});

describe("shell + tool failures (§3.2 rows 3-5)", () => {
  test("afterShellExecution on the DOCUMENTED shape captures nothing — no exit field means no failure", async () => {
    // Arrange
    const f = await fixture("shell-doc");
    const conv = "conv-shell-doc";
    await run("sessionStart", inRepo(SESSION_START_INPUT, f.repo, conv), f.env);

    // Act: the documented payload — failing output text, no exit field.
    await run(
      "afterShellExecution",
      inRepo(AFTER_SHELL_EXECUTION_INPUT, f.repo, conv),
      f.env,
    );

    // Assert: conservative rule holds — nothing fingerprinted.
    const diagnosis = await getDiagnosis(f.hubCtx, `wc_cc_cur-${conv}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    expect(
      diagnosis.data.targets.filter((t) => t.kind === "error_fingerprint"),
    ).toEqual([]);
  });

  test("afterShellExecution with a tolerated exit_code lands the output fingerprint", async () => {
    // Arrange
    const f = await fixture("shell-exit");
    const conv = "conv-shell-exit";
    await run("sessionStart", inRepo(SESSION_START_INPUT, f.repo, conv), f.env);

    // Act
    await run(
      "afterShellExecution",
      inRepo(AFTER_SHELL_EXECUTION_WITH_EXIT, f.repo, conv),
      f.env,
    );

    // Assert: the fingerprint is the shared derivation over the output field
    // ONLY — command text can never influence the hash.
    const expected = fingerprint(
      extractFailureText({ output: AFTER_SHELL_EXECUTION_WITH_EXIT.output }),
    );
    const diagnosis = await getDiagnosis(f.hubCtx, `wc_cc_cur-${conv}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    const prints = diagnosis.data.targets
      .filter((t) => t.kind === "error_fingerprint")
      .map((t) => t.value);
    expect(prints).toEqual([expected ?? ""]);
  });

  test("postToolUse: a failing command inside the documented tool_output encoding fingerprints; a passing one does not", async () => {
    // Arrange
    const f = await fixture("ptu");
    const conv = "conv-ptu-1";
    await run("sessionStart", inRepo(SESSION_START_INPUT, f.repo, conv), f.env);

    // Act
    await run("postToolUse", inRepo(POST_TOOL_USE_INPUT, f.repo, conv), f.env);
    await run(
      "postToolUse",
      inRepo(POST_TOOL_USE_FAILING_COMMAND, f.repo, conv),
      f.env,
    );

    // Assert
    const expected = fingerprint(
      extractFailureText(
        JSON.parse(POST_TOOL_USE_FAILING_COMMAND.tool_output) as object,
      ),
    );
    const diagnosis = await getDiagnosis(f.hubCtx, `wc_cc_cur-${conv}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    const prints = diagnosis.data.targets
      .filter((t) => t.kind === "error_fingerprint")
      .map((t) => t.value);
    expect(prints).toEqual([expected ?? ""]);
  });

  test("postToolUseFailure fingerprints error_message; interrupts and permission denials never do", async () => {
    // Arrange
    const f = await fixture("ptuf");
    const conv = "conv-ptuf-1";
    await run("sessionStart", inRepo(SESSION_START_INPUT, f.repo, conv), f.env);

    // Act
    await run(
      "postToolUseFailure",
      inRepo(POST_TOOL_USE_FAILURE_INPUT, f.repo, conv),
      f.env,
    );
    await run(
      "postToolUseFailure",
      inRepo(POST_TOOL_USE_FAILURE_INTERRUPT, f.repo, conv),
      f.env,
    );
    await run(
      "postToolUseFailure",
      inRepo(POST_TOOL_USE_FAILURE_DENIED, f.repo, conv),
      f.env,
    );

    // Assert: exactly the real failure, nothing from the non-failures.
    const expected = fingerprint(
      extractFailureText({ error: POST_TOOL_USE_FAILURE_INPUT.error_message }),
    );
    const diagnosis = await getDiagnosis(f.hubCtx, `wc_cc_cur-${conv}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    const prints = diagnosis.data.targets
      .filter((t) => t.kind === "error_fingerprint")
      .map((t) => t.value);
    expect(prints).toEqual([expected ?? ""]);
  });
});

describe("stop + sessionEnd (§3.2 rows 6-7)", () => {
  test("stop counts the turn and NEVER emits followup_message", async () => {
    // Arrange
    const f = await fixture("stop");
    const conv = "conv-stop-1";
    await run("sessionStart", inRepo(SESSION_START_INPUT, f.repo, conv), f.env);

    // Act
    const out1 = await run("stop", inRepo(STOP_INPUT, f.repo, conv), f.env);
    const out2 = await run("stop", inRepo(STOP_INPUT, f.repo, conv), f.env);

    // Assert
    expect(out1).toBe("{}");
    expect(out2).toBe("{}");
    const state = await readSessionState(f.home, `cur-${conv}`);
    expect(state?.stopTurnCount).toBe(2);
  });

  test("sessionEnd runs the shared end flow: state deleted, session gone from presence", async () => {
    // Arrange
    const f = await fixture("end");
    const conv = "conv-end-1";
    await run("sessionStart", inRepo(SESSION_START_INPUT, f.repo, conv), f.env);

    // Act
    const out = await run("sessionEnd", inRepo(SESSION_END_INPUT, f.repo, conv), f.env);

    // Assert
    expect(out).toBe("{}");
    expect(await readSessionState(f.home, `cur-${conv}`)).toBeNull();
    const presence = await getPresence(f.hubCtx, REPO_ID);
    if (!presence.ok) throw new Error("presence unavailable");
    expect(
      presence.data.some((entry) => entry.sessionId === `cc_cur-${conv}`),
    ).toBe(false);
  });
});

describe("every answer is directive-free JSON", () => {
  const EVENTS: readonly CursorHookEvent[] = [
    "sessionStart",
    "afterFileEdit",
    "afterShellExecution",
    "postToolUse",
    "postToolUseFailure",
    "stop",
    "sessionEnd",
  ];

  test.each(EVENTS.map((event) => [event] as const))(
    "%s answers {} with no permission/followup_message/continue keys",
    async (event) => {
      // Arrange: a minimal healthy payload in a connected repo.
      const f = await fixture(`out-${event}`);
      const conv = `conv-out-${event}`;

      // Act
      const out = await run(
        event,
        inRepo({ ...SESSION_START_INPUT, hook_event_name: event }, f.repo, conv),
        f.env,
      );

      // Assert: parseable, and free of every directive the schema accepts.
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect(parsed["permission"]).toBeUndefined();
      expect(parsed["followup_message"]).toBeUndefined();
      expect(parsed["continue"]).toBeUndefined();
      expect(out).toBe("{}");
    },
  );
});
