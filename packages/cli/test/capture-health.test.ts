/**
 * Capture and hint health made visible (trial findings #17/#18/#20): the
 * PostToolUse counters are summed per repo for `crosscheck status`, and
 * `doctor` carries a `capture` check per live session that WARNs on the
 * "N edit-tool fires → 0 targets" signature, a `hints` check that says what
 * would make a hint possible, and a `tripwire mode` line for the Q2 knob.
 * Red on main: none of these lines existed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import {
  DOCTOR_CAPTURE_SILENT_FIRES_WARN,
  STATUS_MAX_SESSION_STATES,
  STATUS_SESSION_IDLE_HOURS,
} from "@crosscheck/connector-core/constants.ts";
import { readCaptureHealth } from "@crosscheck/connector-core/state/capture-health.ts";
import {
  deriveSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** Unreachable on purpose: the capture lines are local facts. */
const DEAD_HUB_URL = "http://127.0.0.1:9";
const REPO_ID = "github.com/acme/api";
const ISO = "2026-08-21T08:00:00.000Z";
/**
 * A session that spoke a minute ago. Seeded RELATIVE to now on purpose: the
 * surfaces name a session idle once it has been silent for
 * STATUS_SESSION_IDLE_HOURS, so a fixed stamp would make every one of these
 * fixtures read as idle the day after it was written.
 */
const justNow = (msAgo = 60_000): string =>
  new Date(Date.now() - msAgo).toISOString();
const A_DAY_MS = 25 * 60 * 60 * 1000;

const paths: string[] = [];
const servers: { stop: () => void }[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop();
  }
  servers.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const env = (home: string, hubUrl: string = DEAD_HUB_URL) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: hubUrl,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_DOCTOR_NO_PROBE: "1",
});

const seedSession = async (
  home: string,
  repoRoot: string,
  hostSessionKey: string,
  overrides: Record<string, unknown> = {},
  hubUrl: string = DEAD_HUB_URL,
): Promise<void> => {
  await writeSessionState(home, {
    ...deriveSessionState({
      hostSessionKey,
      repoId: REPO_ID,
      repoRoot,
      hubUrl,
      developerId: "dev_self",
      startedAt: justNow(),
    }),
    lastHeartbeatAt: justNow(),
    ...overrides,
  });
};

const fixture = async (label: string): Promise<{ repo: string; home: string }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return { repo, home };
};

const lineWith = (stdout: string, needle: string): string =>
  stdout.split("\n").find((entry) => entry.includes(needle)) ?? "";

/**
 * A hub that answers only what the doctor `hints` check reads: the list rows
 * with their aggregates and the stats endpoint; everything else 404s.
 */
const startAggregateHub = (
  rows: readonly Record<string, unknown>[],
  stats: Record<string, unknown> | null,
): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/work-contexts") {
        return Response.json({ ok: true, data: { workContexts: rows } });
      }
      if (pathname === "/api/hints/stats") {
        return stats === null
          ? Response.json(
              { ok: false, error: { code: "not_found", message: "no route" } },
              { status: 404 },
            )
          : Response.json({ ok: true, data: stats });
      }
      return Response.json(
        { ok: false, error: { code: "not_found", message: "no route" } },
        { status: 404 },
      );
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const listRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "wc_ken",
  developerId: "dev_ken",
  developerName: "Ken",
  title: "Refresh 500s",
  status: "analyzing",
  createdAt: ISO,
  claimCount: 0,
  targetCount: 0,
  ...overrides,
});

describe("readCaptureHealth (the #17/#18/#20 counters' reader)", () => {
  test("sums this repo's live sessions and nothing else, newest first", async () => {
    // Arrange: two live sessions on this repo, one on a foreign repo
    const { repo, home } = await fixture("ch-read");
    await seedSession(home, repo, "ch-a", {
      editToolFires: 3,
      targetsCapturedCount: 2,
      lastTargetAt: "2026-08-21T08:10:00.000Z",
      deliveredHintRefs: ["clm_1"],
      hintCandidatesSeen: 4,
      startedAt: "2026-08-21T07:00:00.000Z",
    });
    await seedSession(home, repo, "ch-b", {
      editToolFires: 1,
      targetsCapturedCount: 0,
      lastTargetAt: null,
      startedAt: "2026-08-21T09:00:00.000Z",
    });
    await seedSession(home, repo, "ch-foreign", {
      repoId: "github.com/acme/other",
      editToolFires: 9,
      targetsCapturedCount: 9,
    });

    // Act
    const health = await readCaptureHealth(home, DEAD_HUB_URL, REPO_ID);

    // Assert
    expect(health.sessions.map((s) => s.hostSessionKey)).toEqual(["ch-b", "ch-a"]);
    expect(health.fires).toBe(4);
    expect(health.targets).toBe(2);
    expect(health.lastTargetAt).toBe("2026-08-21T08:10:00.000Z");
    expect(health.hintsDelivered).toBe(1);
    expect(health.hintCandidatesSeen).toBe(4);
  });
});

describe("the state-file cap is spent newest first (#17/#20)", () => {
  /** Explicit mtimes: `readdir` order is the OS's, this is the file's own age. */
  const ageStateFile = async (
    home: string,
    hostSessionKey: string,
    secondsOld: number,
  ): Promise<void> => {
    const when = new Date(Date.now() - secondsOld * 1000);
    await utimes(join(home, "sessions", `${hostSessionKey}.json`), when, when);
  };

  test("reads the most recently written states, not an arbitrary slice", async () => {
    // Arrange: ten more sessions of this repo than the cap admits, aged so
    // that s00 is the newest and s59 the oldest. In readdir order the ten
    // that fall out are decided by the OS's hash of UUID file names.
    const { repo, home } = await fixture("ch-cap");
    const total = STATUS_MAX_SESSION_STATES + 10;
    const keys = Array.from({ length: total }, (_, i) => `s${String(i).padStart(2, "0")}`);
    for (const [index, key] of keys.entries()) {
      await seedSession(home, repo, key, {
        editToolFires: 1,
        targetsCapturedCount: 1,
        startedAt: new Date(Date.now() - index * 1000).toISOString(),
        lastHeartbeatAt: new Date(Date.now() - index * 1000).toISOString(),
      });
      await ageStateFile(home, key, index);
    }

    // Act
    const health = await readCaptureHealth(home, DEAD_HUB_URL, REPO_ID);

    // Assert: exactly the newest STATUS_MAX_SESSION_STATES, and the cut said
    const read = new Set(health.sessions.map((entry) => entry.hostSessionKey));
    expect(read.size).toBe(STATUS_MAX_SESSION_STATES);
    expect([...read].sort()).toEqual(keys.slice(0, STATUS_MAX_SESSION_STATES));
    expect(health.statesRead).toBe(STATUS_MAX_SESSION_STATES);
    expect(health.statesTotal).toBe(total);
  });

  test("status says the cut happened instead of implying a total", async () => {
    // Arrange: the same over-full home
    const { repo, home } = await fixture("ch-cap-line");
    const total = STATUS_MAX_SESSION_STATES + 3;
    for (let index = 0; index < total; index += 1) {
      const key = `c${String(index).padStart(2, "0")}`;
      await seedSession(home, repo, key, { editToolFires: 1, targetsCapturedCount: 1 });
      await ageStateFile(home, key, index);
    }

    // Act
    const result = await runCli(["status"], env(home), repo);

    // Assert
    expect(lineWith(result.stdout, "targets:")).toContain(
      `read ${String(STATUS_MAX_SESSION_STATES)} of ${String(total)} state files`,
    );
  });

  test("a state file that will not parse is counted, not silently skipped", async () => {
    // Arrange: one good session and one corrupt state file beside it
    const { repo, home } = await fixture("ch-cap-corrupt");
    await seedSession(home, repo, "ch-cap-good", {
      editToolFires: 1,
      targetsCapturedCount: 1,
    });
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "half-written.json"), "{\"repoId\":", "utf8");

    // Act
    const health = await readCaptureHealth(home, DEAD_HUB_URL, REPO_ID);
    const result = await runCli(["status"], env(home), repo);

    // Assert
    expect(health.statesUnparsed).toBe(1);
    expect(lineWith(result.stdout, "targets:")).toContain("1 unreadable state file");
  });
});

describe("an open session is not the same as a live one (#20)", () => {
  test("a session silent past the idle window is named, not counted as live", async () => {
    // Arrange: one session that spoke a minute ago, one silent for over a day.
    // The corpse's state file is BACK-DATED as well as its heartbeat, because
    // silence is measured off the newest of the heartbeat, the start and the
    // file's own mtime: every writer of that file is one of the session's own
    // hooks, so a file written a moment ago belongs to a session that is
    // running whatever its heartbeat says (state/session-scan.ts). A fixture
    // that back-dates only the stamp is not a corpse, it is a session whose
    // hooks stopped reaching the hub — the shape the WARN exists to catch.
    const { repo, home } = await fixture("ch-idle");
    await seedSession(home, repo, "ch-idle-fresh", {
      editToolFires: 1,
      targetsCapturedCount: 1,
    });
    await seedSession(home, repo, "ch-idle-old", {
      editToolFires: 2,
      targetsCapturedCount: 2,
      startedAt: new Date(Date.now() - A_DAY_MS).toISOString(),
      lastHeartbeatAt: new Date(Date.now() - A_DAY_MS).toISOString(),
    });
    const dead = new Date(Date.now() - A_DAY_MS);
    await utimes(join(home, "sessions", "ch-idle-old.json"), dead, dead);

    // Act
    const health = await readCaptureHealth(home, DEAD_HUB_URL, REPO_ID);
    const result = await runCli(["status"], env(home), repo);
    const doctor = await runCli(["doctor"], env(home), repo);

    // Assert: both counted (they really captured), one of them named idle
    expect(health.sessions).toHaveLength(2);
    expect(health.idleSessions).toBe(1);
    expect(health.targets).toBe(3);
    expect(lineWith(result.stdout, "targets:")).toContain(
      `1 idle >${String(STATUS_SESSION_IDLE_HOURS)}h`,
    );
    expect(lineWith(result.stdout, "targets:")).not.toContain("live session");
    expect(doctor.stdout).toContain("heartbeat 25h ago, idle");
  });
});

describe("crosscheck status capture and hint lines (#20)", () => {
  test("prints targets captured, hints delivered and candidates seen", async () => {
    // Arrange
    const { repo, home } = await fixture("ch-status");
    await seedSession(home, repo, "ch-status-a", {
      editToolFires: 3,
      targetsCapturedCount: 2,
      lastTargetAt: new Date(Date.now() - 60_000).toISOString(),
      deliveredHintRefs: ["clm_1"],
      hintCandidatesSeen: 4,
    });

    // Act
    const result = await runCli(["status"], env(home), repo);

    // Assert: the two lines, with the hub part honestly "not measured"
    expect(lineWith(result.stdout, "targets:")).toContain("targets: 2 captured by 1 open session");
    expect(lineWith(result.stdout, "targets:")).toContain("(last 1m ago)");
    expect(lineWith(result.stdout, "hints:")).toContain("hints: delivered 1");
    expect(lineWith(result.stdout, "hints:")).toContain("candidates 4");
    expect(lineWith(result.stdout, "hints:")).toContain("not measured");
  });

  test("says when edits fire but nothing lands", async () => {
    // Arrange: the Ken shape — three edits, zero targets
    const { repo, home } = await fixture("ch-status-dead");
    await seedSession(home, repo, "ch-status-dead-a", {
      editToolFires: 3,
      targetsCapturedCount: 0,
    });

    // Act
    const result = await runCli(["status"], env(home), repo);

    // Assert
    const line = lineWith(result.stdout, "targets:");
    expect(line).toContain("targets: 0 captured");
    expect(line).toContain("3 edit-tool fires, none captured");
    expect(line).toContain("doctor");
  });

  test("names the outside-root drops that ate the difference (#17)", async () => {
    // Arrange: four edit-tool fires, one target — the other three resolved
    // against no root of this repo. A target DID land, so the doctor WARN
    // never fires and this line is the only surface the new counter reaches.
    const { repo, home } = await fixture("ch-status-outside");
    await seedSession(home, repo, "ch-status-outside-a", {
      editToolFires: 4,
      targetsCapturedCount: 1,
      outsideRootDrops: 3,
    });

    // Act
    const result = await runCli(["status"], env(home), repo);

    // Assert
    const line = lineWith(result.stdout, "targets:");
    expect(line).toContain("targets: 1 captured");
    expect(line).toContain("outside-root drops 3");
  });

  test("stays quiet about outside-root drops when there are none", async () => {
    // Arrange: the same shape with the counter at zero — zero prints nothing,
    // exactly as the foreign-repo drop line above it already behaves
    const { repo, home } = await fixture("ch-status-outside-zero");
    await seedSession(home, repo, "ch-status-outside-zero-a", {
      editToolFires: 2,
      targetsCapturedCount: 2,
      outsideRootDrops: 0,
    });

    // Act
    const result = await runCli(["status"], env(home), repo);

    // Assert
    expect(lineWith(result.stdout, "targets:")).not.toContain("outside-root");
  });

  test("prints the tripwire mode, ask by default and notice when opted out", async () => {
    // Arrange
    const { repo, home } = await fixture("ch-status-tw");

    // Act
    const ask = await runCli(["status"], env(home), repo);
    const notice = await runCli(
      ["status"],
      { ...env(home), CROSSCHECK_TRIPWIRE: "notice" },
      repo,
    );

    // Assert
    expect(lineWith(ask.stdout, "tripwire:")).toBe("tripwire: ask");
    expect(lineWith(notice.stdout, "tripwire:")).toContain("tripwire: notice");
    expect(lineWith(notice.stdout, "tripwire:")).toContain("CROSSCHECK_TRIPWIRE");
  });
});

describe("crosscheck doctor capture check (#17/#18 made visible)", () => {
  test("WARNs when edit-tool fires reach the threshold and no target landed, and prints the diagnosis", async () => {
    // Arrange: three Edit fires, zero targets, the last path never resolved
    const { repo, home } = await fixture("ch-doctor-dead");
    await seedSession(home, repo, "ch-doctor-dead-uuid", {
      editToolFires: DOCTOR_CAPTURE_SILENT_FIRES_WARN,
      targetsCapturedCount: 0,
      lastPostToolUseTool: "Edit",
      lastEditedPath: "/wt/feature/src/auth/refresh.ts",
      lastEditedPathResolvedAgainst: null,
      outsideRootDrops: 3,
    });

    // Act
    const result = await runCli(["doctor"], env(home), repo);

    // Assert: WARN, the counts, the session's root, the last tool, and that
    // the last edited path did NOT resolve — Ken's next paste closes the cause
    const line = lineWith(result.stdout, "  capture  ");
    expect(line).toContain("WARN  capture");
    expect(line).toContain("ch-docto:");
    expect(line).toContain("3 edit-tool fires → 0 targets");
    expect(line).toContain(`repoRoot ${repo}`);
    expect(line).toContain("last tool Edit");
    expect(line).toContain("last edited path resolved: no");
    expect(line).toContain("3 outside-root");
    expect(line).toContain("never resolved against a root of this repo");
  });

  test("names the path that did not resolve, not just that one did not (#18)", async () => {
    // Arrange: the shape Ken pastes — the edited file sits in a worktree the
    // session was never bound to. "no" alone sends the reader back to his
    // machine; the path is what tells a worktree from a second repo.
    const { repo, home } = await fixture("ch-doctor-path");
    await seedSession(home, repo, "ch-doctor-path-uuid", {
      editToolFires: 1,
      targetsCapturedCount: 0,
      lastPostToolUseTool: "Edit",
      lastEditedPath: "/repos/lab-featB/src/auth/refresh.ts",
      lastEditedPathResolvedAgainst: null,
      outsideRootDrops: 1,
    });

    // Act
    const result = await runCli(["doctor"], env(home), repo);

    // Assert
    const line = lineWith(result.stdout, "  capture  ");
    expect(line).toContain("last edited path resolved: no");
    expect(line).toContain("/repos/lab-featB/src/auth/refresh.ts");
  });

  test("PASSes with the diagnosis line when targets landed", async () => {
    // Arrange
    const { repo, home } = await fixture("ch-doctor-ok");
    await seedSession(home, repo, "ch-doctor-ok-uuid", {
      editToolFires: 2,
      targetsCapturedCount: 2,
      lastTargetAt: new Date(Date.now() - 120_000).toISOString(),
      lastPostToolUseTool: "Write",
      lastEditedPath: `${repo}/src/a.ts`,
      lastEditedPathResolvedAgainst: repo,
    });

    // Act
    const result = await runCli(["doctor"], env(home), repo);

    // Assert
    const line = lineWith(result.stdout, "  capture  ");
    expect(line).toContain("PASS  capture");
    expect(line).toContain("2 edit-tool fires → 2 targets (last 2m ago)");
    expect(line).toContain("last tool Write");
    expect(line).toContain(`last edited path resolved: yes (against ${repo})`);
  });

  // BOUNDARY PIN: the WARN does not over-reach — below the threshold, and at
  // it when even one target landed, capture stays PASS.
  test("boundary pin: stays PASS below the threshold, and at it when one target landed", async () => {
    const { repo, home } = await fixture("ch-doctor-boundary");
    await seedSession(home, repo, "ch-boundary-uuid", {
      editToolFires: DOCTOR_CAPTURE_SILENT_FIRES_WARN - 1,
      targetsCapturedCount: 0,
    });
    const below = await runCli(["doctor"], env(home), repo);
    expect(lineWith(below.stdout, "  capture  ")).toContain("PASS  capture");

    await seedSession(home, repo, "ch-boundary-uuid", {
      editToolFires: DOCTOR_CAPTURE_SILENT_FIRES_WARN,
      targetsCapturedCount: 1,
    });
    const landed = await runCli(["doctor"], env(home), repo);
    expect(lineWith(landed.stdout, "  capture  ")).toContain("PASS  capture");
  });

  test("says so when no live session of this repo exists", async () => {
    // Arrange
    const { repo, home } = await fixture("ch-doctor-none");

    // Act
    const result = await runCli(["doctor"], env(home), repo);

    // Assert: printed, PASS — zero is stated, not hidden
    const line = lineWith(result.stdout, "  capture  ");
    expect(line).toContain("PASS  capture");
    expect(line).toContain("no open session");
  });
});

describe("crosscheck doctor hints check (#19/#20: what would make a hint possible)", () => {
  test("WARNs when the hub holds 0 claims and no targets-only pointer was possible", async () => {
    // Arrange: the trial's hub — contexts, zero claims, zero targets
    const { repo, home } = await fixture("ch-hints-dead");
    const hubUrl = startAggregateHub([listRow()], { delivered: 0, pulled: 0, windowDays: 7 });
    await seedSession(home, repo, "ch-hints-dead-uuid", {}, hubUrl);

    // Act
    const result = await runCli(["doctor"], env(home, hubUrl), repo);

    // Assert: the cause and the remedy in one line, plus the hub's own numbers
    const line = lineWith(result.stdout, "  hints  ");
    expect(line).toContain("WARN  hints");
    expect(line).toContain("0 claims");
    expect(line).toContain("0 targets");
    expect(line).toContain("would make one possible");
    expect(line).toContain("hub 7d: 0 delivered, 0 pulled");
  });

  test("PASSes with the numbers when claims exist, and says when the hub predates the stats route", async () => {
    // Arrange: a hub with a claim, but too old for /api/hints/stats
    const { repo, home } = await fixture("ch-hints-ok");
    const hubUrl = startAggregateHub([listRow({ claimCount: 2, targetCount: 3 })], null);
    await seedSession(home, repo, "ch-hints-ok-uuid", { hintCandidatesSeen: 1 }, hubUrl);

    // Act
    const result = await runCli(["doctor"], env(home, hubUrl), repo);

    // Assert
    const line = lineWith(result.stdout, "  hints  ");
    expect(line).toContain("PASS  hints");
    expect(line).toContain("2 claims, 3 targets");
    expect(line).toContain("1 candidate");
    expect(line).toContain("hub predates /api/hints/stats");
  });

  test("reports not measured when the hub is unreachable", async () => {
    // Arrange
    const { repo, home } = await fixture("ch-hints-down");

    // Act
    const result = await runCli(["doctor"], env(home), repo);

    // Assert
    const line = lineWith(result.stdout, "  hints  ");
    expect(line).toContain("PASS  hints");
    expect(line).toContain("not measured");
  });
});

describe("crosscheck doctor tripwire mode line (Q2)", () => {
  test("names ask as the default and notice when CROSSCHECK_TRIPWIRE opts out", async () => {
    // Arrange
    const { repo, home } = await fixture("ch-tw");

    // Act
    const ask = await runCli(["doctor"], env(home), repo);
    const notice = await runCli(
      ["doctor"],
      { ...env(home), CROSSCHECK_TRIPWIRE: "notice" },
      repo,
    );

    // Assert
    expect(lineWith(ask.stdout, "tripwire mode")).toContain("PASS  tripwire mode");
    expect(lineWith(ask.stdout, "tripwire mode")).toContain("ask");
    expect(lineWith(notice.stdout, "tripwire mode")).toContain("notice");
    expect(lineWith(notice.stdout, "tripwire mode")).toContain("additionalContext only");
  });
});
