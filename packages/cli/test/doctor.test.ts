import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DOCTOR_FLUSH_LOCK_WARN_MS,
  MS_PER_DAY,
  recordUnclosedSession,
  repoKey,
  runCli,
} from "../src/index.ts";
import {
  ensureDir,
  spoolCursorPath,
  spoolDataPath,
  spoolDir,
  spoolDropsPath,
  spoolFlushLockPath,
} from "@crosscheck/connector-core/config/paths.ts";
import { recordDrop } from "@crosscheck/connector-core/spool/drops.ts";
import {
  deriveSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo, spawnZombie } from "../../connector-core/test/helpers.ts";

/** Unreachable on purpose: the spool checks run whether the hub answers or not. */
const HUB_URL = "http://127.0.0.1:9";
const REPO_ID = "github.com/acme/api";

const doctorEnv = (home: string) => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
});

const paths: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A hub whose `?open=1` answers with `count` silent-but-open sessions. */
const startOpenSessionsHub = (
  count: number,
): { readonly url: string; readonly stop: () => void } => {
  const sessions = Array.from({ length: count }, (_unused, index) => ({
    id: `ses_${String(index)}`,
    repo: REPO_ID,
    branch: "main",
    status: "done",
    lastHeartbeatAt: new Date(Date.now() - MS_PER_DAY).toISOString(),
  }));
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/sessions") {
        return Promise.resolve(Response.json({ ok: true, data: { sessions } }));
      }
      return Promise.resolve(Response.json({ ok: true, data: {} }));
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    stop: () => {
      server.stop(true);
    },
  };
};

const fixture = async (): Promise<{
  readonly repo: string;
  readonly home: string;
}> => {
  const repo = await makeRepo("doctor", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("doctor");
  paths.push(repo, home);
  return { repo, home };
};

const DEBUG_BUNFIG = 'logLevel = "debug"\n';

describe("crosscheck doctor bun logging check", () => {
  test("warns and names the file when a repo bunfig enables debug logging", async () => {
    // Arrange
    const { repo, home } = await fixture();
    await writeFile(join(repo, "bunfig.toml"), DEBUG_BUNFIG, "utf8");

    // Act
    const result = await runCli(
      ["doctor"],
      { CROSSCHECK_HOME: home, HOME: home },
      repo,
    );

    // Assert
    expect(result.stdout).toContain("WARN  bun request logging");
    expect(result.stdout).toContain(join(repo, "bunfig.toml"));
    expect(result.stdout).toContain("rotate the key");
  });

  test("warns when the debug logLevel sits in the user's home instead", async () => {
    // Arrange
    const { repo, home } = await fixture();
    await writeFile(join(home, ".bunfig.toml"), DEBUG_BUNFIG, "utf8");

    // Act
    const result = await runCli(
      ["doctor"],
      { CROSSCHECK_HOME: home, HOME: home },
      repo,
    );

    // Assert
    expect(result.stdout).toContain("WARN  bun request logging");
    expect(result.stdout).toContain(join(home, ".bunfig.toml"));
  });

  test("passes when no discoverable bunfig turns logging up", async () => {
    // Arrange
    const { repo, home } = await fixture();
    await writeFile(join(repo, "bunfig.toml"), 'logLevel = "warn"\n', "utf8");

    // Act
    const result = await runCli(
      ["doctor"],
      { CROSSCHECK_HOME: home, HOME: home },
      repo,
    );

    // Assert
    expect(result.stdout).toContain("PASS  bun request logging");
  });
});

describe("crosscheck doctor workspace-root check (trial finding #9)", () => {
  test("warns when run ABOVE a connected repo — sessions starting here are invisible", async () => {
    // Arrange: a plain workspace folder with a connected repo one level down
    const workspace = await mkdtemp(join(tmpdir(), "cx-doctor-workspace-"));
    paths.push(workspace);
    const child = join(workspace, "monorepo");
    // A real connected repo carries BOTH marks: the git boundary and the
    // committed config — the same two conditions the capture walk requires.
    await mkdir(join(child, ".git"), { recursive: true });
    await writeFile(
      join(child, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: HUB_URL })}\n`,
      "utf8",
    );
    const home = await makeHome("doctor-workspace");
    paths.push(home);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), workspace);

    // Assert
    expect(result.stdout).toContain("WARN  workspace root");
    expect(result.stdout).toContain("monorepo");
    expect(result.stdout).toContain("invisible");
  });

  test("a stray config WITHOUT a git boundary is not called a connected repo", async () => {
    // Arrange: config but no .git — the capture walk would NEVER connect
    // this folder (connected-repo.ts requires the boundary), so the WARN's
    // advice "touch a file inside it" would be a lie here (adversarial
    // review: the check and the walk must agree on what "connected" means).
    const workspace = await mkdtemp(join(tmpdir(), "cx-doctor-strayconf-"));
    paths.push(workspace);
    const child = join(workspace, "notes");
    await mkdir(child, { recursive: true });
    await writeFile(
      join(child, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: HUB_URL })}\n`,
      "utf8",
    );
    const home = await makeHome("doctor-strayconf");
    paths.push(home);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), workspace);

    // Assert
    expect(result.stdout).not.toContain("workspace root");
  });

  test("stays quiet inside a repo and above folders without configs", async () => {
    // Arrange: a workspace whose subdirs carry no crosscheck config
    const workspace = await mkdtemp(join(tmpdir(), "cx-doctor-plain-"));
    paths.push(workspace);
    await mkdir(join(workspace, "notes"), { recursive: true });
    const home = await makeHome("doctor-plain");
    paths.push(home);

    // Act
    const above = await runCli(["doctor"], doctorEnv(home), workspace);
    const { repo, home: home2 } = await fixture();
    const inside = await runCli(["doctor"], doctorEnv(home2), repo);

    // Assert
    expect(above.stdout).not.toContain("workspace root");
    expect(inside.stdout).not.toContain("WARN  workspace root");
  });
});

describe("crosscheck doctor foreign-repo drops check (trial finding #9)", () => {
  test("WARNs when a live session dropped touches of another connected repo", async () => {
    // Arrange: a session bound to acme/api that dropped 3 foreign touches —
    // the multi-repo workspace whose second repo is silently invisible.
    // Without this line NOTHING on any surface says so (the counter had no
    // reader — adversarial review's headline gap).
    const { repo, home } = await fixture();
    await writeSessionState(home, {
      ...deriveSessionState({
        hostSessionKey: "fdrops-uuid",
        repoId: "github.com/acme/api",
        repoRoot: repo,
        hubUrl: HUB_URL,
        developerId: "dev_a",
        startedAt: new Date("2026-08-19T08:00:00.000Z").toISOString(),
      }),
      foreignRepoDrops: 3,
    });

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert: the count, the bound repo, and the remedy in one sentence
    expect(result.stdout).toContain("WARN  foreign-repo drops");
    expect(result.stdout).toContain("3");
    expect(result.stdout).toContain("github.com/acme/api");
    expect(result.stdout).toContain("one agent session reports to one repo");
  });

  test("renders nothing when no session dropped anything", async () => {
    // Arrange: a live session with a zero counter
    const { repo, home } = await fixture();
    await writeSessionState(
      home,
      deriveSessionState({
        hostSessionKey: "fdrops-zero-uuid",
        repoId: "github.com/acme/api",
        repoRoot: repo,
        hubUrl: HUB_URL,
        developerId: "dev_a",
        startedAt: new Date("2026-08-19T08:00:00.000Z").toISOString(),
      }),
    );

    // Act + Assert: no line at all — zero is not news
    const result = await runCli(["doctor"], doctorEnv(home), repo);
    expect(result.stdout).not.toContain("foreign-repo drops");
  });
});

/**
 * Anhang A, A4-10: `readCursorOffset` refuses any cursor that fails
 * `isSameFile`, and half of that identity is the inode — so a `~/.crosscheck`
 * that was copied or restored gets new inodes and every ALREADY-DELIVERED
 * line reads as pending. 315 phantom records were observed on one such home,
 * and `spool depth` reported them in the voice it uses for real backlog.
 * Replay is safe (the hub dedups); the line just has to say which kind of
 * pending it is looking at.
 */
describe("crosscheck doctor spool depth wording", () => {
  test("a cursor from a different file explains the pending count", async () => {
    // Arrange: one delivered record, plus a cursor whose stored identity
    // belongs to a file that no longer exists at that path.
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    await ensureDir(spoolDir(home, key));
    await writeFile(
      spoolDataPath(home, key, "restored-session"),
      `${JSON.stringify({ id: "env_1", kind: "work_context" })}\n`,
      "utf8",
    );
    await writeFile(
      spoolCursorPath(home, key, "restored-session"),
      `${JSON.stringify({ ino: 999_999, firstLine: "0".repeat(32), offset: 0 })}\n`,
      "utf8",
    );

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("cursor identity changed for 1 session file");
    expect(result.stdout).toContain("the hub deduplicates them");
  });

  test("an ordinary spool says nothing extra", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  spool depth  0 pending records");
    expect(result.stdout).not.toContain("cursor identity changed");
  });
});

describe("crosscheck doctor spool drops check", () => {
  test("says the drop total is a lower bound when a ledger append failed", async () => {
    // Arrange: a directory where the ledger file belongs, so its append fails
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    await ensureDir(spoolDropsPath(home, key, "gone-session"));
    await recordDrop(home, key, "gone-session", 7, "expired", new Date());

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert: the count nobody could write down is still visible here
    expect(result.stdout).toContain("WARN  spool drops");
    expect(result.stdout).toContain("lower bound");
  });

  test("status marks the same total as a lower bound, so both commands agree", async () => {
    // Arrange: same unwritable-ledger setup doctor uses
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    await ensureDir(spoolDropsPath(home, key, "gone-session"));
    await recordDrop(home, key, "gone-session", 7, "expired", new Date());

    // Act
    const result = await runCli(["status"], doctorEnv(home), repo);

    // Assert: a number status cannot vouch for must not read as exact
    expect(result.stdout).toContain("lower bound");
  });

  test("passes when every drop reached a ledger", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  spool drops  none");
  });
});

/**
 * The lock refuses to take a claim whose holder process is still running, which
 * is what stops a flush being robbed mid-request. A holder that CRASHED is not
 * running even while the process table still lists it — a zombie is retired by
 * the lock and reported here as gone — so what is left is the narrower state
 * that cannot resolve itself: a crashed holder's pid reused by an unrelated
 * long-lived process, whose claim is never retired and for whose lifetime flush
 * and reap are deferred. Failing open must not mean going silently dead, so it
 * has to be visible here — and the warning must not talk the reader out of the
 * case it exists for.
 */
describe("crosscheck doctor flush lock check", () => {
  test("warns, and names the pid, when a live process has held the lock far too long", async () => {
    // Arrange: a claim aged well past anything a hook could still be doing,
    // whose pid is a process that really is running.
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    const held = Bun.spawn({
      cmd: ["sleep", "30"],
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    await ensureDir(spoolDir(home, key));
    const lockPath = spoolFlushLockPath(home, key);
    await writeFile(lockPath, `${held.pid}:wedged\n`, "utf8");
    const longAgo = new Date(Date.now() - 10 * DOCTOR_FLUSH_LOCK_WARN_MS);
    await utimes(lockPath, longAgo, longAgo);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);
    held.kill();

    // Assert: a developer can see WHICH process to go and look at, and is NOT
    // told to stand down when that pid turns out to be a crosscheck hook —
    // a crashed holder's pid is a crosscheck hook, and that advice sent the
    // operator away from the one case the warning exists for.
    expect(result.stdout).toContain("WARN  flush lock");
    expect(result.stdout).toContain(`pid ${held.pid}`);
    expect(result.stdout).not.toContain("if that pid is not a crosscheck hook");
  });

  test("passes when a stale lock's holder is gone, because the next flush retires it", async () => {
    // Arrange: the same aged claim, but nobody behind it. This one resolves
    // itself on the next acquisition and is not worth a developer's attention.
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    const gone = Bun.spawn({
      cmd: ["true"],
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    await gone.exited;
    await ensureDir(spoolDir(home, key));
    const lockPath = spoolFlushLockPath(home, key);
    await writeFile(lockPath, `${gone.pid}:crashed\n`, "utf8");
    const longAgo = new Date(Date.now() - 10 * DOCTOR_FLUSH_LOCK_WARN_MS);
    await utimes(lockPath, longAgo, longAgo);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  flush lock");
  });

  test("passes when a stale lock's holder is a zombie, not warns about it", async () => {
    // Arrange: the holder crashed and nobody has reaped it, so its entry is
    // still in the process table. Reported as running, this reads to an
    // operator as a healthy lock while the spool has in fact stopped draining.
    const { repo, home } = await fixture();
    const key = repoKey(HUB_URL, REPO_ID);
    const zombie = await spawnZombie();
    await ensureDir(spoolDir(home, key));
    const lockPath = spoolFlushLockPath(home, key);
    await writeFile(lockPath, `${zombie.pid}:crashed\n`, "utf8");
    const longAgo = new Date(Date.now() - 10 * DOCTOR_FLUSH_LOCK_WARN_MS);
    await utimes(lockPath, longAgo, longAgo);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);
    zombie.release();

    // Assert: the same answer any other dead holder gets.
    expect(result.stdout).toContain("PASS  flush lock");
    expect(result.stdout).toContain("holder that is gone");
  });

  test("passes when no flush is running", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  flush lock  free");
  });
});

describe("crosscheck doctor unclosed sessions check", () => {
  test("warns about a session end that expired before it reached the hub", async () => {
    // Arrange: reap retired a week-old `.pending-end` marker
    const { repo, home } = await fixture();
    const nineDaysAgo = new Date(Date.now() - 9 * MS_PER_DAY);
    await recordUnclosedSession(home, repoKey(HUB_URL, REPO_ID), nineDaysAgo);

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert: the count survived the marker, and it names how long ago
    expect(result.stdout).toContain("WARN  unclosed sessions");
    expect(result.stdout).toContain("1 session end");
    expect(result.stdout).toContain("9d ago");
  });

  test("passes when every deferred end was eventually delivered", async () => {
    // Arrange
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(["doctor"], doctorEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  unclosed sessions  none");
  });

  test("the hub's number is named as sessions that STOPPED reporting", async () => {
    // Arrange: a hub answering ?open=1 with two rows. The endpoint returns
    // only sessions that are open AND silent past the reaper's window
    // (services/sessions.ts listOpenSessions), so the sentence has to say so —
    // "holds 1 of your sessions open" read as a defect on every machine with
    // somebody working on it (review finding B2-03).
    const { repo, home } = await fixture();
    const hub = startOpenSessionsHub(2);
    stops.push(hub.stop);

    // Act
    const result = await runCli(
      ["doctor"],
      { ...doctorEnv(home), CROSSCHECK_HUB_URL: hub.url },
      repo,
    );

    // Assert
    expect(result.stdout).toContain("WARN  unclosed sessions");
    expect(result.stdout).toContain(
      "hub still holds 2 of your sessions open with no heartbeat",
    );
  });

  test("a hub with no silent sessions leaves the line at PASS", async () => {
    // Arrange
    const { repo, home } = await fixture();
    const hub = startOpenSessionsHub(0);
    stops.push(hub.stop);

    // Act
    const result = await runCli(
      ["doctor"],
      { ...doctorEnv(home), CROSSCHECK_HUB_URL: hub.url },
      repo,
    );

    // Assert
    expect(result.stdout).toContain("PASS  unclosed sessions  none");
  });
});

/**
 * Rule 6, on the MCP surface: fail-open must never mean silently dead.
 *
 * A hook that cannot run is invisible by design — it exits 0 and says nothing.
 * The MCP tools are the opposite: a failing CALL is visible to the agent, which
 * is better, but a tool that is not REGISTERED is never called at all and so
 * produces no message of any kind. Nothing else on this machine would say so.
 * That is the state these checks exist for.
 */
describe("crosscheck doctor mcp registration", () => {
  const initEnv = (home: string) => ({
    CROSSCHECK_HOME: home,
    HOME: home,
    CROSSCHECK_HUB_URL: HUB_URL,
    CROSSCHECK_API_KEY: "test-key",
  });

  test("fails when .mcp.json does not exist, and names the fix", async () => {
    // Arrange: a repo where the hooks may well be installed and the tools are
    // not — `init` predating this block leaves exactly this state
    const { repo, home } = await fixture();

    // Act
    const result = await runCli(["doctor"], initEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("FAIL  mcp tools registered");
    expect(result.stdout).toContain("crosscheck init");
  });

  test("passes once init has written it", async () => {
    // Arrange
    const { repo, home } = await fixture();
    await runCli(["init"], initEnv(home), repo);

    // Act
    const result = await runCli(["doctor"], initEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  mcp tools registered");
  });

  test("fails when the crosscheck entry was replaced by something else", async () => {
    // Arrange: the key is present, so a check that only looked for the KEY
    // would call this healthy. It points somewhere else entirely.
    const { repo, home } = await fixture();
    await writeFile(
      join(repo, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          crosscheck: { type: "stdio", command: "npx", args: ["-y", "something-else"] },
        },
      }),
      "utf8",
    );

    // Act
    const result = await runCli(["doctor"], initEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("FAIL  mcp tools registered");
    expect(result.stdout).toContain("not the one crosscheck init writes");
  });

  test("warns rather than failing when .mcp.json is unparseable", async () => {
    // Arrange: distinct from "missing" because the fix is different — a
    // developer has to look at the file rather than re-run init over it
    const { repo, home } = await fixture();
    await writeFile(join(repo, ".mcp.json"), "{ not json", "utf8");

    // Act
    const result = await runCli(["doctor"], initEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("mcp tools registered");
    expect(result.stdout).toContain("not valid json");
  });

  test("says the tools cannot work at all when there is no hub or key", async () => {
    // Arrange: the systematically-unusable case. Registration alone is not
    // enough — a registered server with no credentials answers every call with
    // an error, and the developer needs to know that before an agent finds out.
    const { repo, home } = await fixture();
    await runCli(["init"], initEnv(home), repo);

    // Act: no CROSSCHECK_API_KEY, and a home with no stored config
    const result = await runCli(["doctor"], { CROSSCHECK_HOME: home, HOME: home }, repo);

    // Assert
    expect(result.stdout).toContain("FAIL  mcp tools usable");
    expect(result.stdout).toContain("crosscheck login");
    expect(result.exitCode).toBe(2);
  });
});

/**
 * The launcher check: hooks and .mcp.json can pass every TEXTUAL check above
 * while calling a launcher that does not resolve (written from an npx cache)
 * or resolves to a FOREIGN binary that happens to be named `crosscheck`
 * (npm's crosscheck-cli ships one). Both are silent in the hooks by design,
 * so doctor must resolve and identify the launcher the way a hook would.
 */
describe("crosscheck doctor hook launcher check", () => {
  const launcherEnv = (home: string, pathDir?: string) => ({
    CROSSCHECK_HOME: home,
    HOME: home,
    CROSSCHECK_HUB_URL: HUB_URL,
    CROSSCHECK_API_KEY: "test-key",
    ...(pathDir === undefined ? {} : { PATH: pathDir }),
  });

  const fakeBin = async (script: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "cx-doctor-bin-"));
    paths.push(dir);
    const bin = join(dir, "crosscheck");
    await writeFile(bin, `#!/bin/sh\n${script}\n`, "utf8");
    await chmod(bin, 0o755);
    return dir;
  };

  test("fails when hooks call a bare crosscheck that is not on PATH", async () => {
    // Arrange: exactly what `npx crosscheck-hub init` used to leave behind
    const { repo, home } = await fixture();
    await runCli(
      ["init", "--command-prefix", "crosscheck"],
      launcherEnv(home),
      repo,
    );

    // Act: a PATH without crosscheck — the hooks' world after npx exits
    const result = await runCli(["doctor"], launcherEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("FAIL  hook launcher");
    expect(result.stdout).toContain("nothing by that name is on PATH");
    // The remedy names the npm PACKAGE (crosscheck-hub), not the bin.
    expect(result.stdout).toContain("npm install -g crosscheck-hub");
    expect(result.exitCode).toBe(2);
  });

  test("fails when the crosscheck on PATH is a different tool", async () => {
    // Arrange
    const { repo, home } = await fixture();
    const dir = await fakeBin('echo "othertool 1.2.3"');
    await runCli(
      ["init", "--command-prefix", "crosscheck"],
      launcherEnv(home, dir),
      repo,
    );

    // Act
    const result = await runCli(["doctor"], launcherEnv(home, dir), repo);

    // Assert
    expect(result.stdout).toContain("FAIL  hook launcher");
  });

  test("passes when the launcher resolves and identifies as crosscheck", async () => {
    // Arrange: the healthy global-install state
    const { repo, home } = await fixture();
    const dir = await fakeBin('echo "crosscheck 9.9.9"');
    await runCli(
      ["init", "--command-prefix", "crosscheck"],
      launcherEnv(home, dir),
      repo,
    );

    // Act
    const result = await runCli(["doctor"], launcherEnv(home, dir), repo);

    // Assert
    expect(result.stdout).toContain("PASS  hook launcher");
  });

  test("passes on the absolute-path launcher init writes without a PATH hit", async () => {
    // Arrange: the repo-checkout flow — runtime and entry both exist here
    const { repo, home } = await fixture();
    await runCli(["init"], launcherEnv(home), repo);

    // Act
    const result = await runCli(["doctor"], launcherEnv(home), repo);

    // Assert
    expect(result.stdout).toContain("PASS  hook launcher");
  });
});
