/**
 * THE TRIPWIRE THE SHAPE-TOLERANT READER WAS SOLD ON, held to its own words.
 *
 * transcript.ts's header makes two promises a reviewer took it at:
 *
 *   1. the `text` decoder is for "anything else that decoded to PRINTABLE
 *      CHARACTERS" — and
 *   2. the reader "says which shape it found rather than assuming one", with
 *      neither decoder guessing right being "a NAMED outcome, never a
 *      silence".
 *
 * Neither was true. The fallback returned any non-blank tail — a SQLite page,
 * a stream of decode failures — as `shape: "text"`, so the ONE value that
 * books NO_SLICE_UNRECOGNISED was reachable only for a tail that is entirely
 * whitespace; and `shape` had no consumer anywhere in the package, the CLI or
 * core, so a decoder flip was invisible on every surface.
 *
 * That matters because the jsonl decoder is a HYPOTHESIS about an undocumented
 * format. The day Cursor's transcript stops being line-delimited JSON, the
 * fallback takes over silently, the gate's conjunction stops matching, nothing
 * is booked (a slice WAS produced), and doctor prints PASS forever. These
 * cases make the fallback refuse what it cannot read and make the decoder it
 * used reach session state and the doctor line.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";

import { cursorDoctorChecks } from "../src/doctor.ts";
import {
  extractCursorSliceText,
  NO_SLICE_UNRECOGNISED,
} from "../src/derive/transcript.ts";
import { runCursorHook } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** A throwaway hub on this task's own port range, never 7100. */
const HUB_PORT = 7621;
const server = Bun.serve({
  port: HUB_PORT,
  fetch: () => new Response("not found", { status: 404 }),
});
const HUB_URL = `http://127.0.0.1:${String(server.port)}`;

const CONV = "conv-shape";
const HOST_KEY = `cur-${CONV}`;
const REPO_ID = "github.com/acme/api";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

afterAll(() => {
  server.stop(true);
});

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly env: Env;
}

/** The eight owned entries, so the doctor section renders its rung lines. */
const installHooks = async (repo: string): Promise<void> => {
  await mkdir(join(repo, ".cursor"), { recursive: true });
  await writeFile(
    join(repo, ".cursor", "hooks.json"),
    JSON.stringify({
      version: 1,
      hooks: Object.fromEntries(
        [
          "sessionStart",
          "beforeSubmitPrompt",
          "afterFileEdit",
          "afterShellExecution",
          "postToolUse",
          "postToolUseFailure",
          "stop",
          "sessionEnd",
        ].map((event) => [event, [{ command: `crosscheck cursor-hook ${event}` }]]),
      ),
    }),
  );
};

const fixture = async (label: string): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  await installHooks(repo);
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: `cc_${HOST_KEY}`,
    workContextId: `wc_cc_${HOST_KEY}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    workContextTitle: "main @ api",
    workContextStatus: "analyzing",
  });
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      CURSOR_PROJECT_DIR: repo,
      PATH: process.env["PATH"],
    },
  };
};

const stopPayload = (repo: string, transcriptPath: string): string =>
  JSON.stringify({
    conversation_id: CONV,
    hook_event_name: "stop",
    workspace_roots: [repo],
    cursor_version: "1.7.2",
    status: "completed",
    transcript_path: transcriptPath,
  });

/** A turn the gate WOULD fire on, written as the hypothesised JSONL. */
const CONCLUSION_JSONL = [
  JSON.stringify({
    role: "user",
    text: "the refresh endpoint 500s after we rotate the key",
  }),
  JSON.stringify({
    role: "assistant",
    text: "ran bun test src/auth — 3 tests failed with TypeError: cannot read token",
  }),
  JSON.stringify({
    role: "assistant",
    text: "Root cause: the refresh path reads the retired key. The fix is to re-read the key on rotation; all tests passing now.",
  }),
  "",
].join("\n");

/** The same turn as PROSE — no role labels, the gate's anchors intact. */
const CONCLUSION_PROSE =
  "user: the refresh endpoint 500s after we rotate the key\n" +
  "assistant: ran bun test src/auth — 3 tests failed with TypeError\n" +
  "assistant: Root cause: the refresh path reads the retired key.\n";

describe("the tail decoder refuses what it cannot read", () => {
  test("a SQLite store is not prose, and is not offered as a slice", () => {
    // Arrange — the real file header, then page bytes. Cursor documents no
    // transcript format at all, so a binary store is not a hypothetical.
    const raw = Buffer.concat([
      Buffer.from("SQLite format 3", "utf8"),
      Buffer.from([0x00, 0x10, 0x00, 0x01, 0x01, 0x00, 0x40, 0x20, 0x20, 0x0a]),
    ]).toString();

    // Act + Assert
    expect(extractCursorSliceText(raw)).toBeNull();
  });

  test("a tail that decoded to replacement characters is not prose either", () => {
    // Arrange — what Buffer.toString() makes of non-UTF-8 bytes.
    const raw = Buffer.from([
      0x8f, 0x9a, 0xc3, 0x28, 0xa0, 0xa1, 0xf8, 0xa1, 0x0a, 0xfe, 0xfe, 0xff,
      0xff, 0x0a,
    ]).toString();

    expect(extractCursorSliceText(raw)).toBeNull();
  });

  test("a tail with no word-shaped content is refused rather than spent on", () => {
    expect(extractCursorSliceText("### --- >>> ||| ***\n:::\n")).toBeNull();
  });

  test("real prose still decodes, and says it decoded as prose", () => {
    // Arrange — the fallback's whole reason to exist: no role labels, but the
    // command shapes and error output the gate anchors on survive.
    const extracted = extractCursorSliceText(CONCLUSION_PROSE);

    // Act + Assert
    expect(extracted?.shape).toBe("text");
    expect(extracted?.text).toContain("Root cause");
  });

  test("the hypothesised JSONL still decodes, and says jsonl", () => {
    const extracted = extractCursorSliceText(CONCLUSION_JSONL);

    expect(extracted?.shape).toBe("jsonl");
    expect(extracted?.text).toContain("assistant: Root cause");
  });
});

describe("which decoder matched reaches session state and doctor", () => {
  test("a binary transcript books the named no-slice outcome, not silence", async () => {
    // Arrange
    const fix = await fixture("cursor-binary-transcript");
    const transcript = join(fix.home, "transcript.bin");
    await writeFile(
      transcript,
      Buffer.concat([
        Buffer.from("SQLite format 3", "utf8"),
        Buffer.from([0x00, 0x10, 0x01, 0x01, 0x00, 0x40, 0x20, 0x20, 0x0a]),
        Buffer.from([0xf8, 0xa1, 0xa1, 0xa1, 0xa1, 0x0a]),
      ]),
    );

    // Act — four turns, exactly the reviewer's repro
    for (let turn = 0; turn < 4; turn += 1) {
      await runCursorHook("stop", stopPayload(fix.repo, transcript), fix.env);
    }

    // Assert — the turns counted AND the reason named, so the generic
    // summarizer cost line can print it instead of a silent PASS
    const state = await readSessionState(fix.home, HOST_KEY);
    expect(state?.stopTurnCount).toBe(4);
    expect(state?.summarizerNoSliceCount).toBe(4);
    expect(state?.summarizerLastNoSlice).toBe(NO_SLICE_UNRECOGNISED);
    expect(state?.summarizerFireCount).toBe(0);
  }, 20_000);

  test("a decoded turn records WHICH decoder read it", async () => {
    const fix = await fixture("cursor-shape-booked");
    const transcript = join(fix.home, "transcript.jsonl");
    await writeFile(transcript, CONCLUSION_JSONL, "utf8");

    await runCursorHook("stop", stopPayload(fix.repo, transcript), fix.env);

    const state = await readSessionState(fix.home, HOST_KEY);
    expect(state?.summarizerLastSliceShape).toBe("jsonl");
  }, 20_000);

  test("a prose tail records the fallback, and doctor says so on the rung", async () => {
    // Arrange — the drift this whole mechanism exists to make visible: the
    // jsonl decoder stopped matching and the fallback took over.
    const fix = await fixture("cursor-shape-drift");
    const transcript = join(fix.home, "transcript.txt");
    await writeFile(transcript, CONCLUSION_PROSE, "utf8");

    // Act
    await runCursorHook("stop", stopPayload(fix.repo, transcript), fix.env);
    const state = await readSessionState(fix.home, HOST_KEY);
    if (state === null) {
      throw new Error("no session state");
    }

    // Assert — booked, then printed
    expect(state.summarizerLastSliceShape).toBe("text");
    const checks = await cursorDoctorChecks({
      repoRoot: fix.repo,
      env: {},
      home: fix.home,
      repoKey: "k",
      liveStates: [state],
    });
    const line = checks.find((entry) => entry.name === "summarizer (cursor)");
    expect(line?.detail).toContain("last tail decoded as prose");
  }, 20_000);
});
