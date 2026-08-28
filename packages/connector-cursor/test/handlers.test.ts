/**
 * The §3.2 mapping, row by row, through the REAL handlers against a REAL
 * in-process hub — the contract fixtures (test/fixtures/cursor-contract)
 * are the inputs, so every assertion here is also a pin on the documented
 * payload shapes. Presence, targets and fingerprints must LAND; every
 * output must be directive-free JSON.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { fingerprint } from "@crosscheck/connector-core/capture/fingerprint.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { renderRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import { getDiagnosis, getPresence } from "@crosscheck/connector-core/http/hub.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { readSpoolLines } from "@crosscheck/connector-core/spool/files.ts";
import { safeHostSessionId } from "@crosscheck/connector-core/state/host-session-key.ts";
import {
  deriveSessionState,
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
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
  git,
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
  await hub.close();
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

describe("a Cursor workspace rooted at the PARENT of the repo (trial finding #9)", () => {
  test("afterFileEdit derives the repo from the edited file and registers on first touch", async () => {
    // Arrange: workspace/monorepo is a connected repo; the workspace root
    // itself is a plain folder — the exact panel-session shape that was
    // silently invisible while terminal sessions reported fine.
    const workspace = await mkdtemp(join(tmpdir(), "cx-cursor-workspace-"));
    cleanups.push(workspace);
    const repo = join(workspace, "monorepo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "--initial-branch=main"]);
    await git(repo, ["config", "user.email", "dev@example.com"]);
    await git(repo, ["config", "user.name", "Dev"]);
    await writeFile(
      join(repo, ".crosscheck.json"),
      renderRepoConfig(hub.hubUrl),
      "utf8",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    await git(repo, ["remote", "add", "origin", REMOTE]);
    await writeRepoFile(repo, "src/panel.ts", "export const p = 1;\n");
    const home = await makeHome("cursor-parent");
    cleanups.push(home);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    };
    const conv = "conv-parent-1";

    // Act: workspace_roots is the PARENT; only file_path names the repo
    const out = await run(
      "afterFileEdit",
      {
        ...AFTER_FILE_EDIT_INPUT,
        conversation_id: conv,
        workspace_roots: [workspace],
        file_path: join(repo, "src", "panel.ts"),
      },
      env,
    );

    // Assert: visible with the repo's identity, target captured
    expect(out).toBe("{}");
    const state = await readSessionState(home, `cur-${conv}`);
    expect(state?.crosscheckSessionId).toBe(`cc_cur-${conv}`);
    expect(state?.repoId).toBe(REPO_ID);
    const hubCtx: HubContext = {
      hubUrl: hub.hubUrl,
      apiKey: hub.apiKey,
      timeoutMs: 4000,
      home,
      repoKey: repoKey(hub.hubUrl, REPO_ID),
      now: () => new Date(),
    };
    const diagnosis = await getDiagnosis(hubCtx, `wc_cc_cur-${conv}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    expect(
      diagnosis.data.targets
        .filter((target) => target.kind === "file")
        .map((target) => target.value),
    ).toEqual(["src/panel.ts"]);
  });

  test("a sibling recovery bound to ANOTHER repo wins the race: dropped, not captured", async () => {
    // Arrange: the Claude recovery-race parity pin. A hub whose register
    // endpoint publishes a SIBLING's state (bound to other/web) mid-call —
    // the exact window between requireSessionState's read and the flow's
    // state publish. The loser must adopt, count the drop, capture nothing.
    const workspace = await mkdtemp(join(tmpdir(), "cx-cursor-race-"));
    cleanups.push(workspace);
    const home = await makeHome("cursor-race");
    cleanups.push(home);
    const conv = "conv-race-1";
    const hostKey = `cur-${conv}`;
    let raceHubUrl = "";
    const raceServer = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/api/sessions" && request.method === "POST") {
          await writeSessionState(
            home,
            deriveSessionState({
              hostSessionKey: hostKey,
              repoId: "github.com/other/web",
              repoRoot: "/tmp/web",
              hubUrl: raceHubUrl,
              developerId: "dev_sibling",
              startedAt: new Date("2026-08-19T08:00:00.000Z").toISOString(),
            }),
          );
          return Response.json({
            ok: true,
            data: { session: { id: `cc_${hostKey}`, developerId: "dev_race" } },
          });
        }
        return Response.json({ ok: true, data: {} });
      },
    });
    raceHubUrl = `http://127.0.0.1:${raceServer.port}`;
    const repo = join(workspace, "monorepo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "--initial-branch=main"]);
    await git(repo, ["config", "user.email", "dev@example.com"]);
    await git(repo, ["config", "user.name", "Dev"]);
    await writeFile(
      join(repo, ".crosscheck.json"),
      renderRepoConfig(raceHubUrl),
      "utf8",
    );
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    await git(repo, ["remote", "add", "origin", REMOTE]);
    await writeRepoFile(repo, "src/panel.ts", "export const p = 1;\n");

    // Act
    const out = await run(
      "afterFileEdit",
      {
        ...AFTER_FILE_EDIT_INPUT,
        conversation_id: conv,
        workspace_roots: [repo],
        file_path: join(repo, "src", "panel.ts"),
      },
      {
        CROSSCHECK_HOME: home,
        CROSSCHECK_API_KEY: hub.apiKey,
        CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
      },
    );
    raceServer.stop(true);

    // Assert: the sibling's binding survives, the drop is counted, and this
    // repo's spool holds nothing.
    expect(out).toBe("{}");
    const state = await readSessionState(home, hostKey);
    expect(state?.repoId).toBe("github.com/other/web");
    expect(state?.foreignRepoDrops).toBe(1);
    expect(
      await readSpoolLines(home, repoKey(raceHubUrl, REPO_ID)),
    ).toEqual([]);
  });

  test("the inverse pin: a file in an UNCONNECTED repo under the workspace stays silent", async () => {
    // Arrange: a git repo WITHOUT committed config, credentials stored
    const workspace = await mkdtemp(join(tmpdir(), "cx-cursor-scratch-"));
    cleanups.push(workspace);
    const scratch = join(workspace, "scratch");
    await mkdir(scratch, { recursive: true });
    await git(scratch, ["init", "--initial-branch=main"]);
    await git(scratch, ["config", "user.email", "dev@example.com"]);
    await git(scratch, ["config", "user.name", "Dev"]);
    await writeRepoFile(scratch, "src/notes.ts", "// private\n");
    await git(scratch, ["add", "."]);
    await git(scratch, ["commit", "-m", "initial"]);
    const home = await makeHome("cursor-scratch");
    cleanups.push(home);
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.hubUrl,
      CROSSCHECK_API_KEY: hub.apiKey,
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    };
    const conv = "conv-scratch-1";

    // Act
    const out = await run(
      "afterFileEdit",
      {
        ...AFTER_FILE_EDIT_INPUT,
        conversation_id: conv,
        workspace_roots: [workspace],
        file_path: join(scratch, "src", "notes.ts"),
      },
      env,
    );

    // Assert: silence is the contract — no state, nothing registered
    expect(out).toBe("{}");
    expect(await readSessionState(home, `cur-${conv}`)).toBeNull();
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
    // The dedup must be OURS, persisted — not the hub's. Without the
    // seen-set fold in the state write, every afterFileEdit re-appends all
    // seen targets: unbounded spool growth on a dead-hub day (the Claude
    // state-race pin, ported; mutation-check re-proves it load-bearing).
    const state = await readSessionState(f.home, `cur-${conv}`);
    expect(state?.seenTargets).toContain("src/rate-limit.ts");
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

    // Assert: exactly the real failure, nothing from the non-failures. The
    // exclusion fixtures must CARRY signal, or the two guards are decoration
    // — a no-signal text fingerprints to null with or without them (this
    // suite stayed green with the is_interrupt guard deleted until the
    // fixtures were given real stderr; mutation-check re-proves both).
    expect(
      fingerprint(
        extractFailureText({
          error: POST_TOOL_USE_FAILURE_INTERRUPT.error_message,
        }),
      ),
    ).not.toBeNull();
    expect(
      fingerprint(
        extractFailureText({
          error: POST_TOOL_USE_FAILURE_DENIED.error_message,
        }),
      ),
    ).not.toBeNull();
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

describe("hostile conversation ids — the shared shape rule guards the key mint", () => {
  test("an oversized conversation_id folds to its digest key; capture SURVIVES instead of dying on the filename", async () => {
    // Arrange: 8000 chars — unshaped, the state filename threw ENAMETOOLONG
    // out of every write and the session's whole capture died silently.
    const f = await fixture("giant-id");
    const giant = "x".repeat(8000);
    const shaped = safeHostSessionId(giant);
    if (shaped === null) throw new Error("shaped id unavailable");

    // Act
    const out = await run(
      "sessionStart",
      inRepo(SESSION_START_INPUT, f.repo, giant),
      f.env,
    );

    // Assert: deterministic digest key, state written, presence landed.
    expect(out).toBe("{}");
    expect(shaped).toMatch(/^sha256-[0-9a-f]{64}$/);
    const state = await readSessionState(f.home, `cur-${shaped}`);
    expect(state?.crosscheckSessionId).toBe(`cc_cur-${shaped}`);
    const presence = await getPresence(f.hubCtx, REPO_ID);
    if (!presence.ok) throw new Error("presence unavailable");
    expect(
      presence.data.some((entry) => entry.sessionId === `cc_cur-${shaped}`),
    ).toBe(true);
  });

  test("control characters are stripped before the id enters cc_/wc_ ids, state files and logs", async () => {
    // Arrange: newline (log forgery), ESC (terminal driving), NUL — the
    // ACP hostile-id vectors, now on the cursor path.
    const f = await fixture("evil-id");
    const evil = "a\n../../../etc/pwn\u001b[31m\u0000b";

    // Act
    const out = await run(
      "sessionStart",
      inRepo(SESSION_START_INPUT, f.repo, evil),
      f.env,
    );

    // Assert: the minted ids carry the SHAPED form — no unprintables ride
    // to the hub or into filenames (the ../ stays: printable text is content
    // for a key, and the encoded filename never treats it as a path).
    expect(out).toBe("{}");
    const shaped = safeHostSessionId(evil);
    expect(shaped).toBe("a../../../etc/pwn[31mb");
    const state = await readSessionState(f.home, `cur-${shaped ?? ""}`);
    expect(state?.crosscheckSessionId).toBe("cc_cur-a../../../etc/pwn[31mb");
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
      // Arrange: the sessionStart-shaped payload reused across all eight
      // events — NOT each event's own healthy fixture: for the events whose
      // mapping reads fields it lacks (afterShellExecution's output,
      // postToolUseFailure's error_message) this exercises the degrade rung,
      // which must be exactly as directive-free as the capture rung.
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
