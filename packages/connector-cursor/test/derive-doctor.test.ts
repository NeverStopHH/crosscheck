/**
 * EVERY REFUSAL IS A SENTENCE — the half of rule 4 that is easy to skip.
 *
 * A capability this product decided not to build on Cursor looks, from
 * inside Cursor, exactly like one that is broken: nothing happens. So the
 * doctor section must SAY each decision, in words, always — not omit the
 * capability, not print a code, and not wait for a failure to have happened
 * first. These cases hold the section to that, and to the one sentence the
 * design fixed verbatim for the transcript-off state.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readSessionState, writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { CURSOR_CAPABILITY_MANIFEST } from "../src/capabilities.ts";
import { cursorDoctorChecks } from "../src/doctor.ts";
import { NO_SLICE_NO_TRANSCRIPT } from "../src/derive/transcript.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const HOST_KEY = "cur-conv-doctor";
const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:7613";

const paths: string[] = [];

const installed = async (label: string): Promise<{ repo: string; home: string }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
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
  return { repo, home };
};

const seed = async (
  home: string,
  overrides: Partial<SessionState> = {},
): Promise<SessionState> => {
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: `cc_${HOST_KEY}`,
    workContextId: `wc_cc_${HOST_KEY}`,
    repoId: REPO_ID,
    repoRoot: "/tmp/repo",
    hubUrl: HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    ...overrides,
  });
  const state = await readSessionState(home, HOST_KEY);
  if (state === null) {
    throw new Error("seed failed");
  }
  return state;
};

/** `seed` for a state whose HOST KEY is the case's subject, not this file's. */
const seedKeyed = async (
  home: string,
  hostSessionKey: string,
  overrides: Partial<SessionState> = {},
): Promise<SessionState> => {
  await writeSessionState(home, {
    hostSessionKey,
    crosscheckSessionId: `cc_${hostSessionKey}`,
    workContextId: `wc_cc_${hostSessionKey}`,
    repoId: REPO_ID,
    repoRoot: "/tmp/repo",
    hubUrl: HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    ...overrides,
  });
  const state = await readSessionState(home, hostSessionKey);
  if (state === null) {
    throw new Error("seed failed");
  }
  return state;
};

const cleanup = async (): Promise<void> => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
};

/**
 * THE FACT EVERY RUNG DEPENDS ON, and the one this section used to leave out.
 *
 * All four Cursor rungs end in a spawned model. On a machine with no `claude`
 * and no `CROSSCHECK_SUMMARIZER_CMD` that spawn cannot start, so nothing is
 * ever derived — and yet every rung line printed PASS, because a rung only
 * WARNs once this machine has BOOKED something, and a machine that never
 * fires books nothing. Four green lines, nothing inferred, and the one
 * blocking fact reported only by the Claude connector's probe, which called
 * it skippable.
 *
 * That machine is not hypothetical: it is Cursor-without-Claude-Code, the
 * exact install this parity work exists for.
 */
describe("the derive backend line", () => {
  test("no claude and no override WARNs that nothing derives here", async () => {
    // Arrange — an install that is perfect in every other respect
    const { repo, home } = await installed("cursor-doctor-backend-absent");

    // Act — a PATH with no model binary anywhere on it
    const checks = await cursorDoctorChecks({
      repoRoot: repo,
      env: { PATH: "/nonexistent" },
      home,
      repoKey: "k",
    });
    const line = checks.find((entry) => entry.name === "derive backend (cursor)");

    // Assert — named, visible, and it says the consequence in words
    expect(line).toBeDefined();
    expect(line?.level).toBe("WARN");
    expect(line?.detail).toContain("nothing on this machine can derive");
    // ...and it must not read as "crosscheck is broken": the deterministic
    // half of the product is untouched by a missing model.
    expect(line?.detail).toContain("deterministic capture is unaffected");
  });

  test("an override is a backend, and the line names the command", async () => {
    const { repo, home } = await installed("cursor-doctor-backend-override");

    const checks = await cursorDoctorChecks({
      repoRoot: repo,
      env: { PATH: "/nonexistent", CROSSCHECK_SUMMARIZER_CMD: "/opt/ox/alpha.sh" },
      home,
      repoKey: "k",
    });
    const line = checks.find((entry) => entry.name === "derive backend (cursor)");

    expect(line?.level).toBe("PASS");
    expect(line?.detail).toContain("/opt/ox/alpha.sh");
  });
});

describe("the cursor doctor section says what is inferred and what is refused", () => {
  test("every declared rung and every refusal is printed, with its platform sentence", async () => {
    // Arrange
    const { repo, home } = await installed("doctor-rungs");
    try {
      // Act
      const checks = await cursorDoctorChecks({
        repoRoot: repo,
        env: {},
        home,
        repoKey: "k",
      });
      const byName = new Map(checks.map((entry) => [entry.name, entry]));

      // Assert — one line per capability, carrying rung AND sentence
      for (const capability of CURSOR_CAPABILITY_MANIFEST.capabilities) {
        const line = byName.get(`${capability.name} (cursor)`);
        expect(line, capability.name).toBeDefined();
        expect(line?.detail).toContain(capability.rung);
        expect(line?.detail).toContain(capability.sentence);
        // Nothing has failed on this machine, so nothing WARNs: a platform
        // limit is not a fault and warning on one teaches people to ignore
        // doctor.
        expect(line?.level, capability.name).toBe("PASS");
      }
      // — one line per refusal, ALWAYS, and always a PASS
      for (const refusal of CURSOR_CAPABILITY_MANIFEST.refusals) {
        const line = byName.get(`${refusal.name} (cursor)`);
        expect(line, refusal.name).toBeDefined();
        expect(line?.level).toBe("PASS");
        expect(line?.detail).toBe(refusal.sentence);
      }
      // — the pre-edit ask refusal names the mechanism, not a roadmap
      expect(byName.get("pre-edit ask (cursor)")?.detail).toContain(
        "never hard-blocks",
      );
    } finally {
      await cleanup();
    }
  });

  test("a build with no transcript gets the sentence, and no runner blame", async () => {
    // Arrange
    const { repo, home } = await installed("doctor-no-transcript");
    try {
      const state = await seed(home, {
        summarizerNoSliceCount: 4,
        summarizerLastNoSlice: NO_SLICE_NO_TRANSCRIPT,
      });

      // Act
      const checks = await cursorDoctorChecks({
        repoRoot: repo,
        env: {},
        home,
        repoKey: "k",
        liveStates: [state],
      });
      const line = checks.find(
        (entry) => entry.name === "summarizer transcript (cursor)",
      );

      // Assert — the design's own words, and a PASS: nothing is broken here
      expect(line?.level).toBe("PASS");
      expect(line?.detail).toContain(
        "this Cursor build provides no transcript — Tier-1 capture off; deterministic capture unaffected",
      );
      expect(line?.detail).toContain("4 turns");
      // The summarizer rung itself must NOT warn: no model ran, nothing lost.
      expect(
        checks.find((entry) => entry.name === "summarizer (cursor)")?.level,
      ).toBe("PASS");
    } finally {
      await cleanup();
    }
  });

  test("a booked runner failure WARNs on its own capability and names it", async () => {
    const { repo, home } = await installed("doctor-warn");
    try {
      const state = await seed(home, {
        intentFireCount: 1,
        intentFailCount: 1,
        intentLastFailure: "exit 1: Not logged in Please run /login",
      });

      const checks = await cursorDoctorChecks({
        repoRoot: repo,
        env: {},
        home,
        repoKey: "k",
        liveStates: [state],
      });
      const line = checks.find((entry) => entry.name === "intent (cursor)");

      expect(line?.level).toBe("WARN");
      expect(line?.detail).toContain("1 fire booked a failure");
      expect(line?.detail).toContain("Not logged in");
      // Its siblings stay PASS — one broken capability is not four.
      expect(
        checks.find((entry) => entry.name === "ghost (cursor)")?.level,
      ).toBe("PASS");
    } finally {
      await cleanup();
    }
  });

  test("nothing about the transcript is printed before this machine has seen it", async () => {
    const { repo, home } = await installed("doctor-quiet");
    try {
      const checks = await cursorDoctorChecks({
        repoRoot: repo,
        env: {},
        home,
        repoKey: "k",
        liveStates: [await seed(home)],
      });

      expect(
        checks.some((entry) => entry.name === "summarizer transcript (cursor)"),
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });
  /**
   * THE CROSS-HOST CASE, and the reason it needs a state this file never had:
   * every other case here seeds `cur-conv-doctor`, so the section has only
   * ever been shown sessions it owns. The ACP twin filters its scan on
   * ACP_HOST_KEY_PREFIX and its header says why — "a Claude session's failed
   * summarizer fire must never light up the ACP rung, or the line stops
   * meaning anything" — and the CLI hands both sections the SAME unfiltered
   * scan (readLiveSessionStates filters on hub + repo only, never on host).
   */
  test("another host's booked failures never light up a cursor rung", async () => {
    // Arrange — a Claude Code session: a raw uuid, no `cur-` prefix
    const { repo, home } = await installed("doctor-cross-host");
    try {
      const claudeState = await seedKeyed(home, "11111111-2222-4333-8444-555555555555", {
        intentFireCount: 1,
        intentFailCount: 3,
        intentLastFailure: "exit 1: claude: command not found",
        ghostFailCount: 2,
        ghostLastFailure: "the model timed out after 60 s",
        summarizerFireCount: 4,
        summarizerFailCount: 4,
        summarizerLastFailure: "exit 1 from the claude binary",
      });

      // Act
      const checks = await cursorDoctorChecks({
        repoRoot: repo,
        env: {},
        home,
        repoKey: "k",
        liveStates: [claudeState],
      });

      // Assert — Cursor derived nothing and lost nothing, so nothing WARNs
      for (const capability of CURSOR_CAPABILITY_MANIFEST.capabilities) {
        const line = checks.find(
          (entry) => entry.name === `${capability.name} (cursor)`,
        );
        expect(line?.level, capability.name).toBe("PASS");
      }
      // — and no other host's model stdout is quoted on a cursor line
      for (const line of checks) {
        expect(line.detail).not.toContain("command not found");
        expect(line.detail).not.toContain("timed out after 60 s");
      }
    } finally {
      await cleanup();
    }
  });

  /** The other half: the filter must not swallow Cursor's OWN failures. */
  test("a cursor session's own booked failure still WARNs through the filter", async () => {
    const { repo, home } = await installed("doctor-own-failure");
    try {
      const own = await seedKeyed(home, "cur-conv-own", {
        ghostFailCount: 2,
        ghostLastFailure: "the model timed out after 60 s",
      });
      const other = await seedKeyed(home, "22222222-3333-4444-8555-666666666666", {
        intentFailCount: 9,
        intentLastFailure: "exit 1: claude: command not found",
      });

      const checks = await cursorDoctorChecks({
        repoRoot: repo,
        env: {},
        home,
        repoKey: "k",
        liveStates: [own, other],
      });

      expect(
        checks.find((entry) => entry.name === "ghost (cursor)")?.level,
      ).toBe("WARN");
      expect(
        checks.find((entry) => entry.name === "ghost (cursor)")?.detail,
      ).toContain("2 fires booked a failure");
      expect(
        checks.find((entry) => entry.name === "intent (cursor)")?.level,
      ).toBe("PASS");
    } finally {
      await cleanup();
    }
  });

  /**
   * The transcript-off sentence rides the same scan, so it needs the same
   * filter: a Claude session cannot book NO_SLICE_NO_TRANSCRIPT (its Stop
   * hook has a transcript or it has no session), but a HAND-EDITED or future
   * state that did would otherwise print "this Cursor build provides no
   * transcript" to a reader whose Cursor is fine.
   */
  test("the transcript refusal line is a cursor session's alone", async () => {
    const { repo, home } = await installed("doctor-transcript-filter");
    try {
      const foreign = await seedKeyed(home, "33333333-4444-4555-8666-777777777777", {
        summarizerNoSliceCount: 4,
        summarizerLastNoSlice: NO_SLICE_NO_TRANSCRIPT,
      });

      const checks = await cursorDoctorChecks({
        repoRoot: repo,
        env: {},
        home,
        repoKey: "k",
        liveStates: [foreign],
      });

      expect(
        checks.some((entry) => entry.name === "summarizer transcript (cursor)"),
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
