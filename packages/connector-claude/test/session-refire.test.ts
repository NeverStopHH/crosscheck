/**
 * A SessionStart RE-FIRE keeps the capture counters (#17/#18/#20).
 *
 * Claude Code fires SessionStart again inside a LIVE session — `compact`,
 * `resume`, `clear` — and that fire re-creates the state file. Before this,
 * every capture counter went back to zero with it, so a session that fired 40
 * edit tools into nothing and then auto-compacted printed
 * `0 edit-tool fires → 0 targets` and PASSed: the WARN the counters exist to
 * raise was erased by the compaction, on the very line a remote reader is
 * asked to paste. The per-fire lists (briefing pointers, the hint seen-set)
 * still start empty — that is a briefing's own budget, by design.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

/** Port 1 refuses instantly: registration fails open, state is still written. */
const DEAD_HUB_URL = "http://127.0.0.1:1";
const SESSION_ID = "refire-uuid";
const EDITED_FILE = "src/auth/refresh.ts";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const env = (home: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: "4000",
  CROSSCHECK_SSH_CANONICALIZE: "off",
});

const sessionStartPayload = (cwd: string, source: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd,
    hook_event_name: "SessionStart",
    source,
  });

const editPayload = (cwd: string, absoluteFile: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: absoluteFile },
    tool_response: {},
  });

const connectedRepo = async (label: string): Promise<{ repo: string; home: string }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  await writeFile(
    join(repo, ".crosscheck.json"),
    `${JSON.stringify({ hubUrl: DEAD_HUB_URL }, null, 2)}\n`,
    "utf8",
  );
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "config"]);
  const home = await makeHome(label);
  paths.push(repo, home);
  return { repo, home };
};

describe("SessionStart fires again inside a live session", () => {
  test("a compact does not zero the capture counters", async () => {
    // Arrange: a registered session that captured one target
    const { repo, home } = await connectedRepo("refire");
    await writeRepoFile(repo, EDITED_FILE, "export const a = 1;\n");
    await runHook("session-start", sessionStartPayload(repo, "startup"), env(home));
    await runHook("post-tool-use", editPayload(repo, join(repo, EDITED_FILE)), env(home));
    const before = await readSessionState(home, SESSION_ID);
    expect(before?.editToolFires).toBe(1);
    expect(before?.targetsCapturedCount).toBe(1);

    // Act: the host compacts the transcript and re-fires SessionStart
    await runHook("session-start", sessionStartPayload(repo, "compact"), env(home));

    // Assert: the session's own work survived the fire
    const after = await readSessionState(home, SESSION_ID);
    expect(after?.editToolFires).toBe(1);
    expect(after?.targetsCapturedCount).toBe(1);
    expect(after?.lastPostToolUseTool).toBe("Edit");
    expect(after?.lastEditedPath).toBe(join(repo, EDITED_FILE));
    expect(after?.lastEditedPathResolvedAgainst).not.toBeNull();
  });

  test("the diagnosis a compact used to erase still WARNs afterwards", async () => {
    // Arrange: the #17 shape — an edit outside every root of this repo, so
    // fires climb and nothing is captured
    const { repo, home } = await connectedRepo("refire-warn");
    const loose = await makeRepo("refire-warn-loose", {
      remote: "git@github.com:acme/web.git",
    });
    paths.push(loose);
    await writeRepoFile(loose, "src/app.ts", "export const b = 2;\n");
    await runHook("session-start", sessionStartPayload(repo, "startup"), env(home));
    await runHook("post-tool-use", editPayload(repo, join(loose, "src/app.ts")), env(home));

    // Act
    await runHook("session-start", sessionStartPayload(repo, "resume"), env(home));

    // Assert: the drop counters — the cause a remote reader reads — survived
    const after = await readSessionState(home, SESSION_ID);
    expect(after?.editToolFires).toBe(1);
    expect(after?.targetsCapturedCount).toBe(0);
    expect((after?.foreignRepoDrops ?? 0) + (after?.outsideRootDrops ?? 0)).toBe(1);
  });

  test("a re-fire still starts the briefing's own per-fire budget empty", async () => {
    // Arrange: the seen-set and the briefing pointer list are a FIRE's budget,
    // not the session's — the carry must not quietly widen to them
    const { repo, home } = await connectedRepo("refire-perfire");
    await runHook("session-start", sessionStartPayload(repo, "startup"), env(home));

    // Act
    await runHook("session-start", sessionStartPayload(repo, "clear"), env(home));

    // Assert
    const after = await readSessionState(home, SESSION_ID);
    expect(after?.briefingSolvedRefs).toEqual([]);
    expect(after?.deliveredHintRefs).toEqual([]);
  });
});
