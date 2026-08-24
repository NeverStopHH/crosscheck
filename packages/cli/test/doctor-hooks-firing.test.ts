/**
 * doctor's two EXECUTION lines and the second number on `unclosed sessions`
 * (trial finding M2).
 *
 * `hooks registered` and `statusline registered` parse the settings file and
 * report what it says, so eleven of doctor's twenty-six lines could PASS with
 * the thing they name completely dead. These read the markers the hook runner
 * and the statusline write for themselves (state/fired-markers.ts) — and
 * `unclosed sessions`, which counted only aged-out `.pending-end` markers and
 * read "none" on a machine with 75 zombie state files, now counts those too.
 *
 * The pure halves are exercised directly; `runDoctor` is exercised once per
 * line so the wiring is pinned as well as the wording.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  hooksFiringCheck,
  runDoctor,
  statuslineRenderedCheck,
} from "../src/cli/doctor.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import {
  deriveSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** Unreachable on purpose: none of these lines needs a hub. */
const HUB_URL = "http://127.0.0.1:9";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const fixture = async (): Promise<{
  readonly repo: string;
  readonly home: string;
  readonly key: string;
}> => {
  const repo = await makeRepo("doctor-hooks-firing", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("doctor-hooks-firing");
  paths.push(repo, home);
  return { repo, home, key: repoKey(HUB_URL, REPO_ID) };
};

const writeStateFile = async (
  home: string,
  name: string,
  body: unknown,
): Promise<void> => {
  await mkdir(join(home, "state"), { recursive: true });
  await writeFile(
    join(home, "state", name),
    `${JSON.stringify(body)}\n`,
    "utf8",
  );
};

/** A session whose heartbeat stopped `ageMs` ago — a zombie, not a session. */
const writeStaleSession = async (
  home: string,
  hostSessionKey: string,
  repo: string,
  ageMs: number,
): Promise<void> => {
  const stamp = new Date(Date.now() - ageMs).toISOString();
  await writeSessionState(home, {
    ...deriveSessionState({
      hostSessionKey,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: HUB_URL,
      developerId: "dev_1",
      startedAt: stamp,
    }),
    lastHeartbeatAt: stamp,
  });
};

const doctorEnv = (home: string) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
});

describe("hooksFiringCheck", () => {
  test("a 3h-old SessionStart beside a live session WARNs and names the event", () => {
    // Arrange
    const nowMs = Date.now();
    const facts = {
      firedAt: { "session-start": new Date(nowMs - 3 * HOUR_MS).toISOString() },
      hasLiveSession: true,
      nowMs,
    };

    // Act
    const result = hooksFiringCheck(facts);

    // Assert
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain("SessionStart 3h");
    expect(result.detail).toContain("SessionStart");
    expect(result.detail).toContain("PostToolUse never");
  });

  test("fresh fires of the four watched events pass", () => {
    // Arrange
    const nowMs = Date.now();
    const fresh = new Date(nowMs - MINUTE_MS).toISOString();

    // Act
    const result = hooksFiringCheck({
      firedAt: {
        "session-start": fresh,
        "post-tool-use": fresh,
        "user-prompt-submit": fresh,
        stop: fresh,
      },
      hasLiveSession: true,
      nowMs,
    });

    // Assert: PreToolUse and SessionEnd are never-fired and never WARN
    expect(result.level).toBe("PASS");
    expect(result.detail).toContain("PreToolUse never");
    expect(result.detail).toContain("SessionEnd never");
  });

  test("no fires and no live session is 'not measured', not an alarm", () => {
    // Arrange + Act
    const result = hooksFiringCheck({
      firedAt: {},
      hasLiveSession: false,
      nowMs: Date.now(),
    });

    // Assert
    expect(result.level).toBe("PASS");
    expect(result.detail).toContain("not measured");
  });
});

describe("statuslineRenderedCheck", () => {
  test("never rendered beside a live session WARNs, leading with the reason", () => {
    // Arrange + Act
    const result = statuslineRenderedCheck(null, true, Date.now());

    // Assert
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain("never");
    expect(result.detail).toContain("headless");
    expect(result.detail).toContain("SessionStart briefing");
  });

  test("a fresh render passes with its age", () => {
    // Arrange
    const nowMs = Date.now();

    // Act
    const result = statuslineRenderedCheck(
      new Date(nowMs - MINUTE_MS).toISOString(),
      true,
      nowMs,
    );

    // Assert
    expect(result.level).toBe("PASS");
    expect(result.detail).toContain("ago");
  });

  test("never rendered with no live session is not a defect", () => {
    // Arrange + Act
    const result = statuslineRenderedCheck(null, false, Date.now());

    // Assert
    expect(result.level).toBe("PASS");
  });
});

describe("runDoctor carries the execution lines", () => {
  test("a stale hooks marker beside a live session WARNs", async () => {
    // Arrange
    const { repo, home, key } = await fixture();
    await writeStaleSession(home, "zombie-a", repo, 3 * HOUR_MS);
    await writeStateFile(home, `${key}-hooks.json`, {
      "session-start": new Date(Date.now() - 3 * HOUR_MS).toISOString(),
    });

    // Act
    const result = await runDoctor(doctorEnv(home), repo, async () => null);

    // Assert
    expect(result.stdout).toContain("WARN  hooks firing");
    expect(result.stdout).toContain("SessionStart 3h");
  });

  test("no statusline marker beside a live session WARNs", async () => {
    // Arrange
    const { repo, home } = await fixture();
    await writeStaleSession(home, "zombie-b", repo, 3 * HOUR_MS);

    // Act
    const result = await runDoctor(doctorEnv(home), repo, async () => null);

    // Assert
    expect(result.stdout).toContain("WARN  statusline last rendered  never");
  });

  test("a fresh statusline marker passes", async () => {
    // Arrange
    const { repo, home, key } = await fixture();
    await writeStateFile(home, `${key}-statusline.json`, {
      lastRenderedAt: new Date(Date.now() - MINUTE_MS).toISOString(),
    });

    // Act
    const result = await runDoctor(doctorEnv(home), repo, async () => null);

    // Assert
    expect(result.stdout).toContain("PASS  statusline last rendered");
  });

  test("three zombie state files turn 'unclosed sessions none' into a number", async () => {
    // Arrange: heartbeats two hours old, past DOCTOR_ZOMBIE_STATE_WARN_HOURS
    const { repo, home } = await fixture();
    await writeStaleSession(home, "zombie-1", repo, 2 * HOUR_MS);
    await writeStaleSession(home, "zombie-2", repo, 2 * HOUR_MS);
    await writeStaleSession(home, "zombie-3", repo, 2 * HOUR_MS);

    // Act
    const result = await runDoctor(doctorEnv(home), repo, async () => null);

    // Assert
    expect(result.stdout).toContain("WARN  unclosed sessions");
    expect(result.stdout).toContain("3 of 3 session state files stale");
    expect(result.stdout).toContain("pins its spool file against reap");
    expect(result.stdout).not.toContain("PASS  unclosed sessions  none");
  });

  test("a live session that heartbeated a minute ago is not a zombie", async () => {
    // Arrange
    const { repo, home } = await fixture();
    await writeStaleSession(home, "alive-1", repo, MINUTE_MS);

    // Act
    const result = await runDoctor(doctorEnv(home), repo, async () => null);

    // Assert
    expect(result.stdout).toContain("PASS  unclosed sessions  none");
  });
});
