/**
 * The privacy pins (Block 6 item 5): content-bearing Cursor payload fields
 * — edit old/new strings, terminal output, tool output, the user's email —
 * are NEVER stored, spooled, or logged. Two enforcement halves:
 *
 *   1. BEHAVIORAL: run the real handlers with sentinel content against a
 *      DEAD hub (so everything that would ever touch disk is still on
 *      disk), then read every file under the home — no sentinel anywhere.
 *      Failure text is allowed to leave only as its sha256: fingerprint.
 *      Since Block 7 the failing events ALSO run the failure-matched hint
 *      attempt with that same text as the EPHEMERAL query (design §3.3
 *      privacy pin), and the injection ledger is one of the files swept —
 *      so this suite now also proves the query and the delivered/suppressed
 *      telemetry carry no content.
 *   2. STRUCTURAL (the Block-4 grep-pin shape): the package source never
 *      names the content field accessors at all — what is never read
 *      cannot leak, and a future handler that starts reading
 *      `payload.edits` turns this test red.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { runCursorHook } from "../src/index.ts";
import {
  AFTER_FILE_EDIT_INPUT,
  AFTER_SHELL_EXECUTION_WITH_EXIT,
  POST_TOOL_USE_FAILURE_INPUT,
  SESSION_START_INPUT,
} from "./fixtures/cursor-contract/payloads.ts";
import {
  makeHome,
  makeRepo,
  writeRepoFile,
} from "../../connector-core/test/helpers.ts";

const DEAD_HUB_URL = "http://127.0.0.1:1";
const REMOTE = "git@github.com:acme/api.git";

/** Distinct sentinels so a hit names WHICH field leaked. */
const SENTINEL_OLD = "SENTINEL-OLD-CONTENT-77aa11";
const SENTINEL_NEW = "SENTINEL-NEW-CONTENT-88bb22";
const SENTINEL_OUTPUT = "SENTINEL-TERMINAL-OUTPUT-99cc33";
const SENTINEL_ERROR = "SENTINEL-ERROR-DETAIL-00dd44";
const SENTINEL_EMAIL = "sentinel-email-11ee55@example.com";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
  cleanups.length = 0;
});

const listFilesRecursively = async (root: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
};

describe("behavioral pin: sentinels never reach disk", () => {
  test("edit content, terminal output, error detail and user_email leave no trace under the home", async () => {
    // Arrange: dead hub — spool, state, sync-state, drift ledger all persist.
    const repo = await makeRepo("privacy", { remote: REMOTE });
    const home = await makeHome("privacy");
    cleanups.push(repo, home);
    await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");
    const env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: DEAD_HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
    };
    const conv = "conv-privacy-1";
    const withSentinels = <T extends object>(payload: T): string =>
      JSON.stringify({
        ...payload,
        conversation_id: conv,
        session_id: conv,
        workspace_roots: [repo],
        user_email: SENTINEL_EMAIL,
      });

    // Act: every content-bearing event, sentinel-loaded.
    await runCursorHook("sessionStart", withSentinels(SESSION_START_INPUT), env);
    await runCursorHook(
      "afterFileEdit",
      withSentinels({
        ...AFTER_FILE_EDIT_INPUT,
        file_path: `${repo}/src/limiter.ts`,
        edits: [{ old_string: SENTINEL_OLD, new_string: SENTINEL_NEW }],
      }),
      env,
    );
    await runCursorHook(
      "afterShellExecution",
      withSentinels({
        ...AFTER_SHELL_EXECUTION_WITH_EXIT,
        output: `${SENTINEL_OUTPUT} error: build failed at step 7 of the pipeline`,
      }),
      env,
    );
    await runCursorHook(
      "postToolUseFailure",
      withSentinels({
        ...POST_TOOL_USE_FAILURE_INPUT,
        error_message: `${SENTINEL_ERROR} error: cannot resolve module at step 9`,
      }),
      env,
    );

    // Assert: something was written (the pin is not vacuous)…
    const files = await listFilesRecursively(home);
    expect(files.length).toBeGreaterThan(0);
    // …and no file under the home carries any sentinel: paths travel,
    // content and identity never do; failure text left only as its hash.
    for (const file of files) {
      const content = await readFile(file, "utf8").catch(() => "");
      for (const sentinel of [
        SENTINEL_OLD,
        SENTINEL_NEW,
        SENTINEL_OUTPUT,
        SENTINEL_ERROR,
        SENTINEL_EMAIL,
      ]) {
        expect(content.includes(sentinel), `${sentinel} leaked into ${file}`).toBe(
          false,
        );
      }
    }
    // The failure DID capture — as a fingerprint, the only allowed form.
    const spoolText = (
      await Promise.all(
        files
          .filter((file) => file.endsWith(".jsonl"))
          .map((file) => readFile(file, "utf8").catch(() => "")),
      )
    ).join("\n");
    expect(spoolText).toContain("error_fingerprint");
    expect(spoolText).toContain("sha256:");
  });
});

describe("structural pin: the source never names the content fields", () => {
  /**
   * Field accessors this package must never contain. `edits`, `old_string`,
   * `new_string` are file content; `user_email` is host-asserted identity
   * (the api key is identity — design §3.2); `transcript_path` is the
   * Tier-1 surface this connector defers; `prompt`/`attachments` belong to
   * beforeSubmitPrompt, which is not even registered.
   */
  const BANNED_TOKENS = [
    "old_string",
    "new_string",
    '"edits"',
    ".edits",
    "user_email",
    "transcript_path",
    "attachments",
  ] as const;

  test("no src module references a banned content-field accessor", async () => {
    // Arrange
    const srcRoot = join(import.meta.dir, "..", "src");
    const files = await listFilesRecursively(srcRoot);
    expect(files.length).toBeGreaterThan(0);

    // Assert
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const token of BANNED_TOKENS) {
        expect(
          source.includes(token),
          `${file} references ${token} — content fields must stay unparsed`,
        ).toBe(false);
      }
    }
  });
});
