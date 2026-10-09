/**
 * THE GIT LANE'S WINDOW ACROSS COMPACTS, RESUMES AND LIVES (integration review
 * of batch 2, H1 and L1).
 *
 * The Stop-time git lane files what the session changed since it STARTED
 * (flows/git-lane.ts). A SessionStart re-fire — compact, resume — restamped
 * that start, so a Bash-only file written before the fire fell out of the
 * turn's Stop; and a resume after SessionEnd started a new life with no
 * window and no roots, so what the ended life left dirty, committed or
 * Bash-created reached a teammate again only when touched again (0 of 6 in
 * the review's run). Nothing counted either.
 *
 * Pinned here against real git repositories and the shipped flows, on a hub
 * that refuses every connection: the register and the end do not land, which
 * is exactly when the state and the lineage are all there is. The end-to-end
 * run of the review's sequence is connector-claude's
 * test/e2e/capture-across-lives.e2e.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_AGENT_KIND, MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../src/constants.ts";
import { repoKey, sessionLineagePathForSlug, sessionSlug } from "../src/config/paths.ts";
import { endSessionFlow } from "../src/flows/end-session.ts";
import { selectGitLaneRoots, sweepGitRoots, windowStartOf } from "../src/flows/git-lane.ts";
import type { GitLaneChoice } from "../src/flows/git-lane.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import type { HubContext } from "../src/http/client.ts";
import { withLock } from "../src/spool/lock.ts";
import { readCaptureLosses } from "../src/state/loss-ledger.ts";
import {
  carriedCaptureOf,
  readCarriedCapture,
  reapStaleLineages,
  recordEndedLife,
} from "../src/state/session-lineage.ts";
import {
  deriveSessionState,
  publishSessionState,
  readSessionState,
  sessionStateLockPath,
  writeSessionState,
} from "../src/state/session-state.ts";
import type { KnownWorktreeRoot, SessionState, SessionStateInput } from "../src/state/session-state.ts";
import { makeHome, makeRepo, writeRepoFile } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
/** Port 9 refuses at once: a hub that never answers, without the wait. */
const DEAD_HUB = "http://127.0.0.1:9";
const OTHER_HUB = "http://127.0.0.1:8";
const KEY = repoKey(DEAD_HUB, REPO_ID);
const MINUTE_MS = 60_000;
/** A deadline any git process meets on a loaded machine. */
const WIDE_GIT_TIMEOUT_MS = 30_000;
/** Older than the lineage reap's bound. */
const STALE_MS = (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY;
/** The busy-lock case waits out the publish's whole patience (400 ms) before it falls back. */
const BUSY_LOCK_TEST_TIMEOUT_MS = 20_000;

const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const deadHub = (home: string): HubContext => ({
  hubUrl: DEAD_HUB,
  apiKey: "test-key",
  keyOrigin: DEAD_HUB,
  timeoutMs: 1000,
  home,
  repoKey: KEY,
  now: () => new Date(),
});

const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();

interface World {
  readonly home: string;
  /** The session's own checkout. */
  readonly root: string;
  /** A sibling worktree of the same repo the session reached later. */
  readonly sibling: string;
}

const worldFor = async (label: string): Promise<World> => {
  const root = await realpath(await makeRepo(`${label}-own`, { remote: "git@github.com:acme/api.git" }));
  const sibling = await realpath(await makeRepo(`${label}-sib`, { remote: "git@github.com:acme/api.git" }));
  const home = await makeHome(label);
  cleanups.push(root, sibling, home);
  return { home, root, sibling };
};

/** A file only a shell wrote, `minutesAgo` ago — no edit tool ever named it. */
const bashWrote = async (root: string, path: string, minutesAgo: number): Promise<void> => {
  const full = await writeRepoFile(root, path, "export const generated = 1;\n");
  const at = new Date(Date.now() - minutesAgo * MINUTE_MS);
  await utimes(full, at, at);
};

const knownRoot = (root: string, touchedAt: string, bashTouchedAt: string | null): KnownWorktreeRoot => ({
  root,
  repoId: REPO_ID,
  attempts: 1,
  stamp: null,
  branch: "main",
  headStamp: null,
  firstHead: null,
  firstTouchedAt: touchedAt,
  lastTouchedAt: touchedAt,
  bashTouchedAt,
  gitSweptAt: null,
});

const stateFor = (world: World, startedAt: string, label: string): SessionState =>
  deriveSessionState({
    hostSessionKey: label,
    repoId: REPO_ID,
    repoRoot: world.root,
    hubUrl: DEAD_HUB,
    developerId: "dev_nick",
    startedAt,
  });

/** A seen-set key's path: a topic's keys carry its `~t…/` prefix (flows/topic-contexts.ts topicSeenKey). */
const pathOf = (key: string): string => (key.startsWith("~t") ? key.slice(key.indexOf("/") + 1) : key);

/** The paths the lane files for `state` when it runs now: Stop's sweep, or a subagent's. */
const laneFiles = async (world: World, state: SessionState, choice: GitLaneChoice): Promise<readonly string[]> => {
  const roots = await selectGitLaneRoots(state, choice);
  const sweep = await sweepGitRoots({
    home: world.home,
    repoKey: KEY,
    hostSessionKey: state.hostSessionKey,
    state,
    roots,
    producer: { developerId: "dev_nick", agentKind: DEFAULT_AGENT_KIND, sessionId: state.crosscheckSessionId },
    denylist: null,
    now: new Date(),
    seq: null,
    gitTimeoutMs: WIDE_GIT_TIMEOUT_MS,
  });
  return sweep.captured.map(pathOf);
};

const STOP: GitLaneChoice = { cwdRoot: null };
const SUBAGENT_STOP: GitLaneChoice = { cwdRoot: null, subagent: true };

/** Runs `act` while another holder keeps the state lock for its whole length. */
const whileLockIsHeld = async (home: string, key: string, act: () => Promise<void>): Promise<void> => {
  const release: { value: () => void } = { value: () => undefined };
  const gate = new Promise<void>((done) => {
    release.value = done;
  });
  const held = withLock(sessionStateLockPath(home, key), undefined, () => gate);
  try {
    await act();
  } finally {
    release.value();
    await held;
  }
};

const registerNextLife = async (world: World, label: string): Promise<void> => {
  await registerSessionFlow({
    home: world.home,
    repoKey: KEY,
    hub: deadHub(world.home),
    agentKind: DEFAULT_AGENT_KIND,
    hostSessionKey: label,
    repoId: REPO_ID,
    repoRoot: world.root,
    branch: "main",
    baseCommit: "0000000000000000000000000000000000000000",
    hubUrl: DEAD_HUB,
    fallbackDeveloperId: "dev_nick",
    title: fallbackWorkContextTitle("main", REPO_ID),
    titleSource: "fallback",
    status: "implementing",
    now: new Date(),
    guarantees: guaranteeDeclarationFor(DEFAULT_AGENT_KIND),
  });
};

const endLife = async (world: World, state: SessionState): Promise<void> => {
  await endSessionFlow({
    home: world.home,
    repoKey: KEY,
    hub: deadHub(world.home),
    hostSessionKey: state.hostSessionKey,
    crosscheckSessionId: state.crosscheckSessionId,
    developerId: state.developerId,
    flushBudgetMs: 0,
    now: () => new Date(),
  });
};

/** The sweeps booked as owed by a life that ended (state/session-lineage.ts bookUnsweptCapture). */
const unsweptBooked = async (home: string): Promise<number> =>
  (await readCaptureLosses(home, KEY)).byDetail["hook_timed_out:session-end"] ?? 0;

describe("a compact or resume re-fire keeps the window the turn's Stop sweeps (H1)", () => {
  test("a Bash-only file written before a compact is still filed by the Stop after it", async () => {
    // Arrange: the session started ten minutes ago; a shell wrote a file five
    // minutes ago; then the conversation compacted.
    const label = "cal-compact";
    const world = await worldFor(label);
    const firstStart = isoAgo(10 * MINUTE_MS);
    await writeSessionState(world.home, stateFor(world, firstStart, label));
    await bashWrote(world.root, "src/by-bash.ts", 5);

    // Act: the compact's SessionStart publishes a fresh state stamped now.
    await publishSessionState(world.home, stateFor(world, new Date().toISOString(), label));
    const state = await readSessionState(world.home, label);
    if (state === null) {
      throw new Error("the compact published no state");
    }

    // Assert: the session's first start stands, and the Stop files the file.
    expect(state.startedAt).toBe(firstStart);
    expect(await laneFiles(world, state, STOP)).toContain("src/by-bash.ts");
  });

  test(
    "a compact under a busy state lock keeps the roots, the shell mark and the window (L1)",
    async () => {
      // Arrange: a session that reached a sibling worktree and ran a shell there.
      const label = "cal-busy";
      const world = await worldFor(label);
      const firstStart = isoAgo(10 * MINUTE_MS);
      const touched = isoAgo(8 * MINUTE_MS);
      const before: SessionStateInput = {
        ...stateFor(world, firstStart, label),
        knownWorktreeRoots: [knownRoot(world.sibling, touched, touched)],
        shellSweepSince: touched,
      };
      await writeSessionState(world.home, before);
      await bashWrote(world.sibling, "src/by-bash.ts", 7);

      // Act: the compact publishes while a sibling hook holds the state lock.
      await whileLockIsHeld(world.home, label, async () => {
        await publishSessionState(world.home, stateFor(world, new Date().toISOString(), label));
      });
      const state = await readSessionState(world.home, label);
      if (state === null) {
        throw new Error("the compact published no state");
      }

      // Assert: nothing the next sweep needs was forgotten, and it finds the file.
      expect(state.startedAt).toBe(firstStart);
      expect(state.knownWorktreeRoots.map((entry) => entry.root)).toEqual([world.sibling]);
      expect(state.shellSweepSince).toBe(touched);
      expect(await laneFiles(world, state, SUBAGENT_STOP)).toContain("src/by-bash.ts");
    },
    BUSY_LOCK_TEST_TIMEOUT_MS,
  );
});

describe("a resume after SessionEnd sweeps what the ended life left (H1)", () => {
  test("the lineage keeps the conversation's first start and its roots", async () => {
    // Arrange
    const label = "cal-lineage";
    const world = await worldFor(label);
    const firstStart = isoAgo(10 * MINUTE_MS);
    const touched = isoAgo(8 * MINUTE_MS);
    const state: SessionState = {
      ...stateFor(world, firstStart, label),
      knownWorktreeRoots: [knownRoot(world.sibling, touched, touched)],
    };
    await writeSessionState(world.home, state);

    // Act
    await endLife(world, state);

    // Assert: the state is gone, and the lineage says where the next lane looks.
    expect(await readSessionState(world.home, label)).toBeNull();
    const carried = await readCarriedCapture(world.home, label);
    expect(carried?.since).toBe(firstStart);
    expect(carried?.roots.map((entry) => entry.root)).toEqual([world.sibling]);
    expect(carried?.roots[0]?.bashTouchedAt).toBe(touched);
  });

  test("the next life's first lane — a subagent's — files a Bash-only file the ended life left unswept", async () => {
    // Arrange: life one reached the sibling, a shell wrote there, and the
    // conversation ended before any lane swept it.
    const label = "cal-resume";
    const world = await worldFor(label);
    const firstStart = isoAgo(10 * MINUTE_MS);
    const touched = isoAgo(8 * MINUTE_MS);
    const ended: SessionState = {
      ...stateFor(world, firstStart, label),
      knownWorktreeRoots: [knownRoot(world.sibling, touched, touched)],
    };
    await writeSessionState(world.home, ended);
    await bashWrote(world.sibling, "src/by-bash.ts", 7);
    await endLife(world, ended);

    // Act: the conversation resumes — a new life, registered state-less.
    await registerNextLife(world, label);
    const resumed = await readSessionState(world.home, label);
    if (resumed === null) {
      throw new Error("the resume published no state");
    }

    // Assert: the window opens at the conversation's first start, and the
    // first lane files the file under the life that is live now.
    expect(resumed.crosscheckSessionId).not.toBe(ended.crosscheckSessionId);
    expect(windowStartOf(resumed).toISOString()).toBe(firstStart);
    expect(await laneFiles(world, resumed, SUBAGENT_STOP)).toContain("src/by-bash.ts");
  });

  test("a resume bound to another hub carries nothing of the ended life", async () => {
    // Arrange
    const label = "cal-rebound";
    const world = await worldFor(label);
    const touched = isoAgo(8 * MINUTE_MS);
    const ended = { ...stateFor(world, isoAgo(10 * MINUTE_MS), label), knownWorktreeRoots: [knownRoot(world.sibling, touched, null)] };
    await recordEndedLife(world.home, label, `cc_${label}`, new Date(), null, null, { ...carriedCaptureOf(ended), hubUrl: OTHER_HUB });

    // Act
    await registerNextLife(world, label);
    const resumed = await readSessionState(world.home, label);

    // Assert: another binding's roots are not this session's to sweep.
    expect(resumed?.knownWorktreeRoots).toEqual([]);
    expect(resumed?.captureSince).toBeUndefined();
  });
});

describe("a sweep no life will make is booked, never dropped (H1)", () => {
  /** One root a shell worked in and no lane swept since, and one swept clean. */
  const owing = (world: World, label: string, touched: string): SessionState => ({
    ...stateFor(world, isoAgo(10 * MINUTE_MS), label),
    knownWorktreeRoots: [knownRoot(world.sibling, touched, touched), knownRoot(world.root, touched, null)],
  });

  test("a lineage that could not be written books the sweeps the ended life still owed", async () => {
    // Arrange: the lineage's path is taken by a directory, so no end can write it.
    const label = "cal-unwritable";
    const world = await worldFor(label);
    const lineage = sessionLineagePathForSlug(world.home, sessionSlug(label));
    await mkdir(lineage, { recursive: true });
    await writeFile(join(lineage, "occupied"), "", "utf8");
    const state = owing(world, label, isoAgo(8 * MINUTE_MS));
    await writeSessionState(world.home, state);

    // Act
    await endLife(world, state);

    // Assert: the one root a shell worked in, unswept and carried nowhere.
    expect(await unsweptBooked(world.home)).toBe(1);
  });

  test("a conversation that never came back books them when its lineage is reaped", async () => {
    // Arrange: a lineage older than the reap's bound, still owing a sweep.
    const label = "cal-reaped";
    const world = await worldFor(label);
    const endedAt = new Date(Date.now() - STALE_MS);
    await recordEndedLife(world.home, label, `cc_${label}`, endedAt, null, null, carriedCaptureOf(owing(world, label, endedAt.toISOString())));
    await utimes(sessionLineagePathForSlug(world.home, sessionSlug(label)), endedAt, endedAt);

    // Act
    await reapStaleLineages(world.home, new Date());

    // Assert
    expect(await unsweptBooked(world.home)).toBe(1);
  });

  test("a lineage swept clean books nothing when it is reaped", async () => {
    // Arrange: every root swept before the end — the work was filed.
    const label = "cal-clean";
    const world = await worldFor(label);
    const endedAt = new Date(Date.now() - STALE_MS);
    const clean = { ...stateFor(world, isoAgo(10 * MINUTE_MS), label), knownWorktreeRoots: [knownRoot(world.sibling, endedAt.toISOString(), null)] };
    await recordEndedLife(world.home, label, `cc_${label}`, endedAt, null, null, carriedCaptureOf(clean));
    await utimes(sessionLineagePathForSlug(world.home, sessionSlug(label)), endedAt, endedAt);

    // Act
    await reapStaleLineages(world.home, new Date());

    // Assert
    expect(await unsweptBooked(world.home)).toBe(0);
  });

  test("an end in another binding books the capture it replaces", async () => {
    // Arrange: the last end left a capture of this hub still owing a sweep.
    const label = "cal-replaced";
    const world = await worldFor(label);
    const touched = isoAgo(8 * MINUTE_MS);
    await recordEndedLife(world.home, label, `cc_${label}`, new Date(), null, null, carriedCaptureOf(owing(world, label, touched)));

    // Act: a later life of the conversation, bound to another hub, ends.
    const elsewhere = { ...carriedCaptureOf(owing(world, label, touched)), hubUrl: OTHER_HUB };
    await recordEndedLife(world.home, label, `cc_${label}~r1`, new Date(), null, null, elsewhere);

    // Assert: the first capture is booked to its own repo; the second is on file.
    expect(await unsweptBooked(world.home)).toBe(1);
    expect((await readCarriedCapture(world.home, label))?.hubUrl).toBe(OTHER_HUB);
  });

  test("an end that carries no capture keeps the one on file", async () => {
    // Arrange
    const label = "cal-kept";
    const world = await worldFor(label);
    await recordEndedLife(world.home, label, `cc_${label}`, new Date(), null, null, carriedCaptureOf(owing(world, label, isoAgo(MINUTE_MS))));

    // Act: a heal retires an orphan life — its state lives on, it carries nothing.
    await recordEndedLife(world.home, label, `cc_${label}~r1`, new Date());

    // Assert
    expect((await readCarriedCapture(world.home, label))?.roots).toHaveLength(2);
    expect(await unsweptBooked(world.home)).toBe(0);
  });
});
