/**
 * Capture and hint health get a number (trial finding M1).
 *
 * `status` printed the spool depth and the cross-repo drop count; nothing
 * anywhere printed how many TARGETS a session had captured. So the
 * cross-worktree drop — a session whose every edit landed outside the repo it
 * registered from, capturing nothing at all — produced `spool: 0 pending, 0
 * dropped`, 24 PASS lines, and not one sentence about the thing that had
 * stopped working. Hints had the same hole from the other side:
 * `hint_deliveries` was write-only, so "are hints reaching anybody" had no
 * answer on any surface.
 *
 * WHICH IMPLEMENTATION THESE GUARD, after the M1 and #17/#18/#20 rounds were
 * merged: ONE `capture` check and ONE `hints` check, both in cli/doctor.ts and
 * both fed by `readCaptureHealth` (connector-core state/capture-health.ts).
 * The pure `captureCheck`/`hintsCheck` helpers this file was written against
 * are gone with the second implementation they belonged to, so every test
 * below goes through `runDoctor` — which is the stronger check anyway: it
 * proves the WIRING, which is where a duplicate surface hides.
 *
 * What survives from this side of the merge, and is pinned here because
 * nothing else pins it:
 *
 *   - a CORPSE's counters never produce the "capture is failing" WARN
 *     (review finding B2-04): a state file lives until SessionEnd and most
 *     never end, so a home is mostly corpses, and a dead session's silence is
 *     not a live capture failure — its remedy ("the next edit updates this
 *     line") is one nobody will ever trigger;
 *   - the repo filter and the liveness test are the SAME pass (B2-02), so a
 *     session is never judged by another session's freshness — in BOTH
 *     directions;
 *   - zero claims with NO session open here is a fresh team, not a defect: a
 *     warning that greets every new install is one nobody reads.
 *
 * And three the merge itself made necessary:
 *
 *   - how long a session has been SILENT is the newest of its heartbeat, its
 *     start and its own state file's mtime, so a session that is dropping
 *     every edit into a foreign checkout — and therefore never heartbeats —
 *     keeps its WARN;
 *   - ONE scan answers "is a session live" for every line of the report, so
 *     `capture` and `last capture sync` cannot be computed over different sets
 *     of state files;
 *   - an absent counter is not a zero, and a rejected key is not an
 *     unreachable hub.
 *
 * CORPSE FIXTURES BACK-DATE THE FILE, not only the stamps. Every writer of a
 * state file is one of that session's own hooks, so a file written a moment
 * ago belongs to a session that is running whatever its stamps claim.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runDoctor } from "../src/cli/doctor.ts";
import {
  DOCTOR_ZOMBIE_STATE_WARN_HOURS,
  STATUS_SESSION_IDLE_HOURS,
} from "@crosscheck/connector-core/constants.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
/** Past STATUS_SESSION_IDLE_HOURS by a clear margin: a corpse, not a pause. */
const DEAD_AGE_MS = (STATUS_SESSION_IDLE_HOURS + 6) * 60 * 60 * 1000;
/**
 * Inside the 24 h idle window, outside the 1 h one every other doctor gate
 * reads — the band where one report used to call the same session stale on one
 * line and running on the next.
 */
const QUIET_AGE_MS = (DOCTOR_ZOMBIE_STATE_WARN_HOURS + 2) * 60 * 60 * 1000;

/**
 * A state file's own mtime, which is half of how long its session has been
 * SILENT: every writer of that file is one of the session's own hooks, so a
 * file written a moment ago belongs to a session that is running whatever its
 * heartbeat says. A corpse fixture therefore has to back-date BOTH.
 */
const setMtime = async (
  home: string,
  hostSessionKey: string,
  whenMs: number,
): Promise<void> => {
  const when = new Date(whenMs);
  await utimes(join(home, "sessions", `${hostSessionKey}.json`), when, when);
};

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

/** The hub's stats body; `claims` is absent on a hub that predates M1. */
interface Stats {
  readonly delivered: number;
  readonly pulled: number;
  readonly claims?: number;
  readonly windowDays: number;
}

interface HubOptions {
  /** null = a hub that predates /api/hints/stats and 404s it. */
  readonly stats: Stats | null;
  /** Rows for /api/work-contexts; the claim/target counts doctor falls back to. */
  readonly contexts?: readonly Record<string, unknown>[];
  /** 401 on every route: a rejected key, which is NOT "the hub lacks it". */
  readonly rejectKey?: boolean;
}

/** A hub that answers presence, the context listing and the hint stats. */
const hubWith = (options: HubOptions): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      if (options.rejectKey === true) {
        return Response.json(
          { ok: false, error: { code: "unauthorized", message: "invalid api key" } },
          { status: 401 },
        );
      }
      const { pathname } = new URL(request.url);
      if (pathname === "/api/hints/stats") {
        return options.stats === null
          ? Response.json(
              { ok: false, error: { code: "not_found", message: "unknown route" } },
              { status: 404 },
            )
          : Response.json({ ok: true, data: options.stats });
      }
      if (pathname === "/api/work-contexts") {
        return Response.json({
          ok: true,
          data: { workContexts: options.contexts ?? [] },
        });
      }
      return Response.json({ ok: true, data: { sessions: [] } });
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
  createdAt: new Date().toISOString(),
  claimCount: 0,
  targetCount: 0,
  ...overrides,
});

const seedSession = async (
  home: string,
  repo: string,
  hubUrl: string,
  hostSessionKey: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  const nowIso = new Date().toISOString();
  await writeSessionState(home, {
    hostSessionKey,
    crosscheckSessionId: `cc_${hostSessionKey}`,
    workContextId: `wc_cc_${hostSessionKey}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl,
    developerId: "dev_self",
    startedAt: nowIso,
    lastHeartbeatAt: nowIso,
    ...overrides,
  });
};

const doctorEnv = (home: string, hubUrl: string) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: hubUrl,
  CROSSCHECK_API_KEY: "test-key",
});

const fixture = async (
  name: string,
): Promise<{ readonly repo: string; readonly home: string }> => {
  const repo = await makeRepo(name, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(name);
  paths.push(repo, home);
  return { repo, home };
};

const lineWith = (stdout: string, needle: string): string =>
  stdout.split("\n").find((line) => line.includes(needle)) ?? "";

const runFixtureDoctor = (home: string, repo: string, hubUrl: string) =>
  runDoctor(doctorEnv(home, hubUrl), repo, async () => null);

describe("the capture check reads THIS repo's sessions, whatever the mtime order", () => {
  const OTHER_REPO = "github.com/acme/other";

  test("a corpse of THIS repo is not called a live capture failure", async () => {
    // Arrange: this repo's session died past the idle window carrying 7 fires
    // and no targets; the newest state file on the machine is a fresh session
    // of a DIFFERENT repo.
    const { repo, home } = await fixture("doctor-capture-mask-a");
    const hubUrl = hubWith({
      stats: { delivered: 0, pulled: 0, claims: 0, windowDays: 7 },
    });
    const deadIso = new Date(Date.now() - DEAD_AGE_MS).toISOString();
    await seedSession(home, repo, hubUrl, "dead-mine", {
      startedAt: deadIso,
      lastHeartbeatAt: deadIso,
      editToolFires: 7,
      targetsCapturedCount: 0,
    });
    await seedSession(home, repo, hubUrl, "live-other", {
      repoId: OTHER_REPO,
      editToolFires: 3,
      targetsCapturedCount: 1,
    });
    await setMtime(home, "dead-mine", Date.now() - DEAD_AGE_MS);
    await setMtime(home, "live-other", Date.now());

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert: yesterday's corpse must not be reported as a live drop — it is
    // still PRINTED (its counters are real), and named idle rather than dead.
    expect(result.stdout).not.toContain("WARN  capture");
    const line = lineWith(result.stdout, "  capture  ");
    expect(line).toContain("PASS  capture");
    expect(line).toContain("7 edit-tool fires → 0 targets");
    expect(line).toContain("idle");
  });

  test("a LIVE broken session is reported even when the newest file is a corpse", async () => {
    // Arrange: the dangerous direction — this repo's session is live and
    // capturing nothing, and the newest state file on the machine is dead.
    const { repo, home } = await fixture("doctor-capture-mask-b");
    const hubUrl = hubWith({
      stats: { delivered: 0, pulled: 0, claims: 0, windowDays: 7 },
    });
    const deadIso = new Date(Date.now() - DEAD_AGE_MS).toISOString();
    await seedSession(home, repo, hubUrl, "live-mine", {
      editToolFires: 7,
      targetsCapturedCount: 0,
    });
    await seedSession(home, repo, hubUrl, "dead-other", {
      repoId: OTHER_REPO,
      startedAt: deadIso,
      lastHeartbeatAt: deadIso,
      editToolFires: 4,
      targetsCapturedCount: 0,
    });
    await setMtime(home, "live-mine", Date.now() - 60_000);
    await setMtime(home, "dead-other", Date.now());

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert: this is the H1 signature the whole line exists to surface
    const line = lineWith(result.stdout, "  capture  ");
    expect(line).toContain("WARN  capture");
    expect(line).toContain("7 edit-tool fires → 0 targets");
    expect(line).toContain("edits fire but nothing is captured");
  });

  test("a foreign-repo drop keeps its WARN once the heartbeat ages out", async () => {
    // Arrange: every edit of this session lands in ANOTHER connected checkout,
    // so PostToolUse returns at the first-wins branch (#9) — booking the fire
    // and the drop, and never reaching its heartbeat. A day in, the heartbeat
    // is the only stamp that has aged: the state file was written by the hook
    // that fired a second ago.
    const { repo, home } = await fixture("doctor-capture-foreign");
    const hubUrl = hubWith({
      stats: { delivered: 0, pulled: 0, claims: 0, windowDays: 7 },
    });
    const staleIso = new Date(Date.now() - DEAD_AGE_MS).toISOString();
    await seedSession(home, repo, hubUrl, "foreign-mine", {
      startedAt: staleIso,
      lastHeartbeatAt: staleIso,
      editToolFires: 9,
      targetsCapturedCount: 0,
      foreignRepoDrops: 9,
    });
    await setMtime(home, "foreign-mine", Date.now());

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert: this printed `PASS capture … heartbeat 30h ago, idle` while
    // `status` on the same machine sent the reader here. The clause naming the
    // state write is what makes the remedy believable.
    const line = lineWith(result.stdout, "  capture  ");
    expect(line).toContain("WARN  capture");
    expect(line).toContain("9 edit-tool fires → 0 targets");
    expect(line).toContain("state written");
    expect(line).not.toContain("idle");
  });

  test("one scan, so no two lines answer 'is a session live' differently", async () => {
    // Arrange: 61 state files, of which this repo's only live session is the
    // OLDEST written — outside a 50-file cap, inside a 200-file one. Doctor
    // used to run BOTH: the capture and hints lines came off the narrow scan,
    // `last capture sync`, `hooks firing` and `statusline last rendered` off
    // the wide one, and on a home this size they answered differently.
    const { repo, home } = await fixture("doctor-capture-caps");
    const hubUrl = hubWith({
      stats: { delivered: 0, pulled: 0, claims: 0, windowDays: 7 },
      contexts: [listRow()],
    });
    await seedSession(home, repo, hubUrl, "mine-live", {
      editToolFires: 9,
      targetsCapturedCount: 0,
    });
    await setMtime(home, "mine-live", Date.now() - 5 * 60 * 1000);
    for (let index = 0; index < 60; index += 1) {
      await seedSession(
        home,
        repo,
        hubUrl,
        `other-${String(index).padStart(2, "0")}`,
        { repoId: OTHER_REPO },
      );
    }

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert: one report printed `PASS capture no open session of this repo on
    // this machine` beside `WARN last capture sync … the session is running`.
    const capture = lineWith(result.stdout, "  capture  ");
    expect(capture).not.toContain("no open session of this repo");
    expect(capture).toContain("9 edit-tool fires → 0 targets");
    expect(result.stdout).toContain("the session is running");
    expect(result.stdout).not.toContain("(cap 50)");
  });

  test("a state file predating the counters says so, never '0 → 0'", async () => {
    // Arrange: a session that started under a connector without the capture
    // counters and is still running. `SessionStateSchema` defaults them to 0
    // so the file still parses, which is right for the parse and wrong for the
    // line: it reported a measured, healthy nothing for a session that may
    // have been editing all morning.
    const { repo, home } = await fixture("doctor-capture-unmeasured");
    const hubUrl = hubWith({
      stats: { delivered: 0, pulled: 0, claims: 0, windowDays: 7 },
    });
    const nowIso = new Date().toISOString();
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(
      join(home, "sessions", "old-shape.json"),
      JSON.stringify({
        hostSessionKey: "old-shape",
        crosscheckSessionId: "cc_old-shape",
        workContextId: "wc_old-shape",
        repoId: REPO_ID,
        repoRoot: repo,
        hubUrl,
        developerId: "dev_self",
        startedAt: nowIso,
        lastHeartbeatAt: nowIso,
      }),
      "utf8",
    );

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert
    const line = lineWith(result.stdout, "  capture  ");
    expect(line).toContain("PASS  capture");
    expect(line).toContain("counters not measured");
    expect(line).not.toContain("0 edit-tool fires → 0 targets");
  });

  test("a session quiet for hours is stale on every line, not just one", async () => {
    // Arrange: 7 fires, 0 targets, and nothing said for three hours — inside
    // the 24 h idle window and outside the 1 h one the rest of doctor reads.
    const { repo, home } = await fixture("doctor-capture-band");
    const hubUrl = hubWith({
      stats: { delivered: 0, pulled: 0, claims: 0, windowDays: 7 },
    });
    const quietIso = new Date(Date.now() - QUIET_AGE_MS).toISOString();
    await seedSession(home, repo, hubUrl, "band-mine", {
      startedAt: quietIso,
      lastHeartbeatAt: quietIso,
      editToolFires: 7,
      targetsCapturedCount: 0,
    });
    await setMtime(home, "band-mine", Date.now() - QUIET_AGE_MS);

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert: one report cannot call the same session stale and running. The
    // capture WARN's remedy is "the next edit updates this line", and this
    // reader has just been told nothing is running here to edit in.
    expect(lineWith(result.stdout, "  capture  ")).toContain("PASS  capture");
    expect(lineWith(result.stdout, "unclosed sessions")).toContain("stale >1h");
  });
});

describe("the hints check says whether a hint can fire at all", () => {
  test("zero claims beside an open session names the structural fact and WARNs", async () => {
    // Arrange
    const { repo, home } = await fixture("doctor-hints-dead");
    const hubUrl = hubWith({
      stats: { delivered: 0, pulled: 0, claims: 0, windowDays: 7 },
      contexts: [listRow()],
    });
    await seedSession(home, repo, hubUrl, "hints-a", { editToolFires: 0 });

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert
    const line = lineWith(result.stdout, "  hints  ");
    expect(line).toContain("WARN  hints");
    expect(line).toContain("0 claims");
    expect(line).toContain("hints cannot fire yet");
    expect(line).toContain("hub 7d: 0 delivered, 0 pulled");
  });

  test("zero claims on a machine with no open session is a fresh team, not a defect", async () => {
    // Arrange: the same hub, and nobody running anything here
    const { repo, home } = await fixture("doctor-hints-fresh");
    const hubUrl = hubWith({
      stats: { delivered: 0, pulled: 0, claims: 0, windowDays: 7 },
      contexts: [listRow()],
    });

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert: a warning that greets every new install is one nobody reads —
    // the facts still print, only the level moves
    const line = lineWith(result.stdout, "  hints  ");
    expect(line).toContain("PASS  hints");
    expect(line).toContain("0 claims");
  });

  test("an idle session does not re-arm the WARN a corpse cannot justify", async () => {
    // Arrange: a state file that never ended, silent past the idle window
    const { repo, home } = await fixture("doctor-hints-corpse");
    const hubUrl = hubWith({
      stats: { delivered: 0, pulled: 0, claims: 0, windowDays: 7 },
      contexts: [listRow()],
    });
    const deadIso = new Date(Date.now() - DEAD_AGE_MS).toISOString();
    await seedSession(home, repo, hubUrl, "hints-corpse", {
      startedAt: deadIso,
      lastHeartbeatAt: deadIso,
    });
    await setMtime(home, "hints-corpse", Date.now() - DEAD_AGE_MS);

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert
    expect(lineWith(result.stdout, "  hints  ")).toContain("PASS  hints");
  });

  test("the hub's own claim count is preferred to the contexts page's sum", async () => {
    // Arrange: the page shows none (it is capped and this repo is old), the
    // ledger endpoint knows about eleven. The endpoint's number is the repo's.
    const { repo, home } = await fixture("doctor-hints-source");
    const hubUrl = hubWith({
      stats: { delivered: 5, pulled: 2, claims: 11, windowDays: 7 },
      contexts: [listRow({ targetCount: 3 })],
    });
    await seedSession(home, repo, hubUrl, "hints-b", { hintCandidatesSeen: 1 });

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert
    const line = lineWith(result.stdout, "  hints  ");
    expect(line).toContain("PASS  hints");
    expect(line).toContain("11 claims");
    expect(line).toContain("hub 7d: 5 delivered, 2 pulled");
  });

  test("an older hub without the endpoint is a PASS that says so, never a WARN", async () => {
    // Arrange: an old hub is not a defect of this install (§R6). Its context
    // listing still carries the claim count, so the sentence keeps a number.
    const { repo, home } = await fixture("doctor-hints-old");
    const hubUrl = hubWith({
      stats: null,
      contexts: [listRow({ claimCount: 2, targetCount: 3 })],
    });
    await seedSession(home, repo, hubUrl, "hints-c", { hintCandidatesSeen: 1 });

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert
    const line = lineWith(result.stdout, "  hints  ");
    expect(line).toContain("PASS  hints");
    expect(line).toContain("2 claims, 3 targets");
    expect(line).toContain("hub predates /api/hints/stats");
  });

  test("a rejected key says not measured, never 'this hub does not have it'", async () => {
    // Arrange: the whole point of M3 was a PASS that claimed something false
    // under `FAIL hub reachable invalid api key`. A 401 means the endpoint was
    // never asked, not that the hub lacks it.
    const { repo, home } = await fixture("doctor-hints-401");
    const hubUrl = hubWith({ stats: null, rejectKey: true });
    await seedSession(home, repo, hubUrl, "hints-d", {});

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert: "absent" (the hub answered 404) and "unmeasured" (rejected key,
    // unreachable, 5xx) are different claims, and so are "unreachable" and
    // "your key was refused" — the credential verdict is `hub reachable`'s two
    // lines up. Asserting only the first half let `not measured (hub
    // unreachable)` satisfy a case whose whole point is that it must not.
    const line = lineWith(result.stdout, "  hints  ");
    expect(line).toContain("PASS  hints");
    expect(line).toContain("not measured");
    expect(line).not.toContain("predates");
    expect(line).not.toContain("unreachable");
    expect(result.stdout).toContain("FAIL  hub reachable  invalid api key");
  });
});

describe("runDoctor carries both lines, once each", () => {
  test("seven fires and no targets WARN, beside a 0-claim hub", async () => {
    // Arrange
    const { repo, home } = await fixture("doctor-capture");
    const hubUrl = hubWith({
      stats: { delivered: 0, pulled: 0, claims: 0, windowDays: 7 },
      contexts: [listRow()],
    });
    await seedSession(home, repo, hubUrl, "cap-a", {
      editToolFires: 7,
      targetsCapturedCount: 0,
    });

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert
    expect(result.stdout).toContain("WARN  capture");
    expect(result.stdout).toContain("7 edit-tool fires → 0 targets");
    expect(result.stdout).toContain("WARN  hints");
    expect(result.stdout).toContain("hints cannot fire yet");
  });

  test("ONE capture line and ONE hints line — the duplicate surface is gone", async () => {
    // Arrange: two implementations of each check were merged, and a report
    // that states the same thing twice from two readers is how they disagree.
    const { repo, home } = await fixture("doctor-capture-once");
    const hubUrl = hubWith({
      stats: { delivered: 1, pulled: 1, claims: 4, windowDays: 7 },
      contexts: [listRow({ claimCount: 4, targetCount: 2 })],
    });
    await seedSession(home, repo, hubUrl, "cap-b", {
      editToolFires: 2,
      targetsCapturedCount: 2,
      hintCandidatesSeen: 1,
    });

    // Act
    const result = await runFixtureDoctor(home, repo, hubUrl);

    // Assert
    const lines = result.stdout.split("\n");
    expect(lines.filter((line) => /^(PASS|WARN|FAIL)  capture  /.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /^(PASS|WARN|FAIL)  hints  /.test(line))).toHaveLength(1);
  });
});
