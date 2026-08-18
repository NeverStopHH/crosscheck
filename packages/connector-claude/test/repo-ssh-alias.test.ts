/**
 * A multi-account SSH ALIAS must not fork the repo's identity. The incident
 * (2026-08-18 trial onboarding): a teammate's remote
 * `git@github.com-toandiep:org/repo` produced repo id
 * `github.com-toandiep/org/repo` while the same repo everywhere else was
 * `github.com/org/repo` — the hub saw two different repos and the two
 * developers would silently never match. Trial-killing, and invisible: both
 * machines were green.
 *
 * The fix resolves the ssh host through the user's OWN ssh config (`ssh -G`,
 * bounded, fail-open); these tests inject the resolver so no test depends on
 * this machine's ~/.ssh/config. The default resolver's boundedness is proven
 * through a subprocess probe with a fake `ssh` on PATH — the
 * git-timeout.test.ts pattern, because executable lookup is fixed at process
 * start.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SSH_CANONICALIZE_ENV } from "../src/constants.ts";
import { resolveRepoIdentity } from "../src/git/repo-identity.ts";
import { makeRepo } from "./helpers.ts";

const ALIASED_REMOTE = "git@github.com-toandiep:Acme/API.git";
const CANONICAL_REMOTE = "git@github.com:Acme/API.git";
const CANONICAL_ID = "github.com/acme/api";

/** The teammate's ssh config, as an injected resolver: alias → real host. */
const aliasResolver = async (host: string): Promise<string | null> =>
  host === "github.com-toandiep" ? "github.com" : host;

/** A config with no aliases: ssh -G echoes the host back. */
const echoResolver = async (host: string): Promise<string | null> => host;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

describe("ssh-alias remotes resolve to the canonical repo identity", () => {
  test("aliased and canonical remotes of the same repo yield the SAME id", async () => {
    // Arrange: two checkouts of one repo — one through the alias, one direct
    const aliased = await makeRepo("alias", { remote: ALIASED_REMOTE });
    const canonical = await makeRepo("canonical", { remote: CANONICAL_REMOTE });
    paths.push(aliased, canonical);

    // Act
    const aliasedIdentity = await resolveRepoIdentity(aliased, aliasResolver);
    const canonicalIdentity = await resolveRepoIdentity(canonical, echoResolver);

    // Assert: ONE repo on the hub, not two
    expect(aliasedIdentity?.repoId).toBe(CANONICAL_ID);
    expect(canonicalIdentity?.repoId).toBe(CANONICAL_ID);
  });

  test("a genuinely different host (self-hosted gitea) stays distinct", async () => {
    // Arrange
    const gitea = await makeRepo("gitea", {
      remote: "git@gitea.internal:Acme/API.git",
    });
    paths.push(gitea);

    // Act
    const identity = await resolveRepoIdentity(gitea, echoResolver);

    // Assert: no alias configured, no collapse — different host, different repo
    expect(identity?.repoId).toBe("gitea.internal/acme/api");
    expect(identity?.repoId).not.toBe(CANONICAL_ID);
  });

  test("an ssh:// url with a port resolves its alias too", async () => {
    // Arrange
    const repo = await makeRepo("ssh-url", {
      remote: "ssh://git@github.com-toandiep:2222/Acme/API.git",
    });
    paths.push(repo);

    // Act
    const identity = await resolveRepoIdentity(repo, aliasResolver);

    // Assert: alias resolved AND the port stripped as it always was
    expect(identity?.repoId).toBe(CANONICAL_ID);
  });
});

describe("resolution is fail-open — today's identity is the floor", () => {
  test("a resolver that yields null keeps the literal host", async () => {
    // Arrange: ssh missing / timed out / printed nothing parseable
    const repo = await makeRepo("failopen-null", { remote: ALIASED_REMOTE });
    paths.push(repo);

    // Act
    const identity = await resolveRepoIdentity(repo, async () => null);

    // Assert
    expect(identity?.repoId).toBe("github.com-toandiep/acme/api");
  });

  test("a resolver that throws keeps the literal host", async () => {
    // Arrange
    const repo = await makeRepo("failopen-throw", { remote: ALIASED_REMOTE });
    paths.push(repo);

    // Act
    const identity = await resolveRepoIdentity(repo, async () => {
      throw new Error("ssh exploded");
    });

    // Assert
    expect(identity?.repoId).toBe("github.com-toandiep/acme/api");
  });

  test("a file:// remote never consults ssh config at all", async () => {
    // Arrange: a colon before the path made this LOOK scp-shaped, so every
    // resolution used to spawn a wasted bounded `ssh -G file` (identity was
    // unchanged either way — the spawn is the defect).
    const repo = await makeRepo("file-url", {
      remote: "file:///srv/git/api.git",
    });
    paths.push(repo);
    let consulted = 0;

    // Act
    const identity = await resolveRepoIdentity(repo, async (host) => {
      consulted += 1;
      return host;
    });

    // Assert
    expect(identity?.repoId).toBeDefined();
    expect(consulted).toBe(0);
  });

  test("a Windows drive-letter remote never consults ssh config at all", async () => {
    // Arrange: C:\repo parses as scp host "C" — a drive, not a host
    const repo = await makeRepo("drive-path", { remote: "C:\\projects\\api" });
    paths.push(repo);
    let consulted = 0;

    // Act
    const identity = await resolveRepoIdentity(repo, async (host) => {
      consulted += 1;
      return host;
    });

    // Assert
    expect(identity?.repoId).toBeDefined();
    expect(consulted).toBe(0);
  });

  test("an https remote never consults ssh config at all", async () => {
    // Arrange: https hosts are DNS names; the user's ssh aliases must not
    // touch them
    const repo = await makeRepo("https", {
      remote: "https://github.com/Acme/API.git",
    });
    paths.push(repo);
    let consulted = 0;

    // Act
    const identity = await resolveRepoIdentity(repo, async (host) => {
      consulted += 1;
      return host;
    });

    // Assert
    expect(identity?.repoId).toBe(CANONICAL_ID);
    expect(consulted).toBe(0);
  });
});

describe("the default resolver is bounded and fail-open", () => {
  /** Probe startup plus the 500 ms deadline, with generous headroom. */
  const BOUNDED_CEILING_MS = 2_000;
  /** A fake ssh below this cannot have been waited out by the deadline. */
  const DEADLINE_FLOOR_MS = 400;
  /** Far past the ceiling: only the deadline can explain a fast return. */
  const HANG_LIFETIME_S = 5;

  interface ProbeReport {
    readonly hostname: string | null;
    readonly elapsedMs: number;
  }

  const makeFakeSshDir = async (script: string): Promise<string> => {
    const binDir = await mkdtemp(join(tmpdir(), "cx-fake-ssh-"));
    paths.push(binDir);
    const fake = join(binDir, "ssh");
    await writeFile(fake, script, "utf8");
    await chmod(fake, 0o755);
    return binDir;
  };

  const runProbe = async (pathPrefix: string): Promise<ProbeReport> => {
    const probe = join(import.meta.dir, "fixtures", "ssh-hostname-probe.ts");
    // The suite preload sets the canonicalization off-switch; this probe
    // exercises the REAL spawn machinery, so it opts back in by dropping the
    // variable (test/preload.ts names this contract).
    const { [SSH_CANONICALIZE_ENV]: _omitted, ...envOptedIn } = process.env;
    const proc = Bun.spawn({
      cmd: [process.execPath, probe],
      cwd: import.meta.dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...envOptedIn, PATH: `${pathPrefix}:${process.env.PATH ?? ""}` },
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`probe exited ${String(exitCode)}`);
    }
    return JSON.parse(stdout) as ProbeReport;
  };

  test("an ssh that hangs is abandoned at the deadline, answer null", async () => {
    // Arrange: the shape of a Match-exec config gone wrong
    const binDir = await makeFakeSshDir(
      `#!/bin/sh\n/bin/sleep ${String(HANG_LIFETIME_S)}\nexit 0\n`,
    );

    // Act
    const report = await runProbe(binDir);

    // Assert: null within the bound — the caller keeps the literal host. The
    // floor proves the deadline produced the null, not an instant exec error.
    expect(report.hostname).toBeNull();
    expect(report.elapsedMs).toBeLessThan(BOUNDED_CEILING_MS);
    expect(report.elapsedMs).toBeGreaterThan(DEADLINE_FLOOR_MS);
  });

  test("a real -G style dump yields the hostname line's value", async () => {
    // Arrange: what OpenSSH prints for an aliased host, abbreviated
    const binDir = await makeFakeSshDir(
      '#!/bin/sh\necho "user git"\necho "hostname github.com"\necho "port 22"\nexit 0\n',
    );

    // Act
    const report = await runProbe(binDir);

    // Assert
    expect(report.hostname).toBe("github.com");
  });
});
