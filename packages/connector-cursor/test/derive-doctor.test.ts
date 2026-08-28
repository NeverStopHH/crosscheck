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

const cleanup = async (): Promise<void> => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
};

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
});
