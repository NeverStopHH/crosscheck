/**
 * The fingerprint-parity pin (Block 6 item 6): the SAME failure text through
 * the cursor-hook path and the Claude hook path yields the identical
 * `sha256:` value — both driven as the REAL production paths (runCursorHook
 * / runHook against a dead hub, values read from the spool each one wrote),
 * then both pinned to the one shared derivation
 * `fingerprint(extractFailureText(...))`. The ACP path is pinned to that
 * SAME derivation in connector-acp/test/capture-engine.test.ts
 * ("Fingerprint parity"), so equality here closes the triangle:
 * cursor == claude == acp.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { fingerprint } from "@crosscheck/connector-core/capture/fingerprint.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { readSpoolLines } from "@crosscheck/connector-core/spool/files.ts";
import { runHook } from "../../connector-claude/src/index.ts";
import * as claudeToolEvents from "../../connector-claude/src/capture/tool-events.ts";

import { runCursorHook } from "../src/index.ts";
import {
  AFTER_SHELL_EXECUTION_WITH_EXIT,
  POST_TOOL_USE_FAILURE_INPUT,
} from "./fixtures/cursor-contract/payloads.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const REMOTE = "git@github.com:acme/api.git";
const DEAD_HUB_URL = "http://127.0.0.1:1";
const KEY = repoKey(DEAD_HUB_URL, REPO_ID);

/** One failure text, byte-identical through every connector. */
const FAILURE_TEXT =
  "error TS2304: cannot find name 'limiter' at build step 7 of the pipeline";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
  cleanups.length = 0;
});

const spooledFingerprints = async (home: string): Promise<readonly string[]> =>
  (await readSpoolLines(home, KEY))
    .map(
      (line) =>
        JSON.parse(line) as {
          kind: string;
          body: { kind?: string; value?: string };
        },
    )
    .filter(
      (record) =>
        record.kind === "target" && record.body.kind === "error_fingerprint",
    )
    .map((record) => record.body.value ?? "");

describe("one failure text, one hash, every connector", () => {
  test("cursor afterShellExecution == claude Bash failure == the shared derivation", async () => {
    // Arrange: two real connectors, same dead hub, same repo identity.
    const repo = await makeRepo("parity", { remote: REMOTE });
    const cursorHome = await makeHome("parity-cursor");
    const claudeHome = await makeHome("parity-claude");
    cleanups.push(repo, cursorHome, claudeHome);

    // Act: the REAL cursor path — shell output with a tolerated exit code.
    await runCursorHook(
      "afterShellExecution",
      JSON.stringify({
        ...AFTER_SHELL_EXECUTION_WITH_EXIT,
        workspace_roots: [repo],
        output: FAILURE_TEXT,
      }),
      {
        CROSSCHECK_HOME: cursorHome,
        CROSSCHECK_HUB_URL: DEAD_HUB_URL,
        CROSSCHECK_API_KEY: "test-key",
      },
    );
    // The REAL claude path — a failed Bash tool_response carrying the same
    // bytes in stderr.
    await runHook(
      "post-tool-use",
      JSON.stringify({
        session_id: "parity-claude-session",
        cwd: repo,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "bun test" },
        tool_response: { exit_code: 1, stderr: FAILURE_TEXT },
      }),
      {
        CROSSCHECK_HOME: claudeHome,
        CROSSCHECK_HUB_URL: DEAD_HUB_URL,
        CROSSCHECK_API_KEY: "test-key",
      },
    );

    // Assert: identical sha256: values on both spools, equal to the shared
    // derivation (the same expression the ACP parity test pins).
    const viaSharedDerivation = fingerprint(
      extractFailureText({ stderr: FAILURE_TEXT }),
    );
    expect(viaSharedDerivation).not.toBeNull();
    expect(await spooledFingerprints(cursorHome)).toEqual([
      viaSharedDerivation ?? "",
    ]);
    expect(await spooledFingerprints(claudeHome)).toEqual([
      viaSharedDerivation ?? "",
    ]);
  });

  test("cursor postToolUseFailure error_message rides the same derivation", async () => {
    // Arrange
    const repo = await makeRepo("parity-ptuf", { remote: REMOTE });
    const home = await makeHome("parity-ptuf");
    cleanups.push(repo, home);

    // Act
    await runCursorHook(
      "postToolUseFailure",
      JSON.stringify({
        ...POST_TOOL_USE_FAILURE_INPUT,
        workspace_roots: [repo],
        error_message: FAILURE_TEXT,
      }),
      {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: DEAD_HUB_URL,
        CROSSCHECK_API_KEY: "test-key",
      },
    );

    // Assert
    expect(await spooledFingerprints(home)).toEqual([
      fingerprint(extractFailureText({ error: FAILURE_TEXT })) ?? "",
    ]);
  });

  test("the extractor this package rides IS core's, by reference — the claude re-export too", () => {
    // Normalizer drift between connectors is structurally impossible while
    // both bind the same function object.
    expect(claudeToolEvents.extractFailureText).toBe(extractFailureText);
  });
});
