/**
 * PATH ENTRIES A REPO CANNOT SUPPLY (config/trusted-path.ts; review round 2,
 * N6). A relative entry or one inside the repo lets the repo answer to
 * `crosscheck` or `bun`. Lookups skip both; the launcher writes no bare name
 * a host would resolve through them; doctor says so for hooks that have one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { checkLauncherCommand } from "../src/config/launcher-check.ts";
import { resolveLauncher } from "../src/config/launcher.ts";
import { enclosingRepoRoot, isTrustedPathEntry, trustedPath, untrustedPathEntries } from "../src/config/trusted-path.ts";

const ENTRY = new URL("../../cli/src/bin/crosscheck.ts", import.meta.url).pathname;
const KEYWORDS = ["hook", "statusline", "mcp"];

let base = "";
let repo = "";
/** A durable install outside the repo, holding a crosscheck that identifies as ours. */
let outsideBin = "";

/** A `crosscheck` whose --version answers like ours. */
const ownLookingCrosscheck = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "crosscheck"), "#!/bin/sh\necho 'crosscheck 0.11.0'\n", "utf8");
  await chmod(join(dir, "crosscheck"), 0o755);
};

/** Runs `act` with the process cwd inside the repo, as init and doctor run. */
const inRepo = async <T>(act: () => Promise<T>): Promise<T> => {
  const before = process.cwd();
  process.chdir(join(repo, "sub"));
  try {
    return await act();
  } finally {
    process.chdir(before);
  }
};

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "cx-trusted-path-"));
  repo = join(base, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "sub"), { recursive: true });
  await ownLookingCrosscheck(join(repo, "node_modules", ".bin"));
  outsideBin = join(base, "global", "bin");
  await ownLookingCrosscheck(outsideBin);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("a PATH entry is trusted", () => {
  test("only when absolute and outside the repo the cwd is in", () => {
    // Arrange
    const cwd = join(repo, "sub");
    const entries = ["node_modules/.bin", ".", "", join(repo, "node_modules", ".bin"), repo, join(repo, "..bin"), "/usr/bin", join(base, "sibling")];

    // Act
    const trusted = entries.filter((entry) => isTrustedPathEntry(entry, cwd));

    // Assert — a repo directory named `..bin` is still inside it
    expect(trusted).toEqual(["/usr/bin", join(base, "sibling")]);
  });

  test("the repo is the nearest ancestor holding .git, a worktree's file included, else the cwd", async () => {
    // Arrange
    const worktree = join(base, "wt");
    await mkdir(join(worktree, "deep"), { recursive: true });
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere\n", "utf8");
    const loose = join(base, "loose");
    await mkdir(loose, { recursive: true });

    // Act + Assert — by real path (macOS's tmpdir sits behind /var -> /private/var)
    expect(enclosingRepoRoot(join(repo, "sub"))).toBe(await realpath(repo));
    expect(enclosingRepoRoot(join(worktree, "deep"))).toBe(await realpath(worktree));
    expect(isTrustedPathEntry(join(loose, "bin"), loose)).toBe(false);
  });

  test("trustedPath keeps the trusted entries in order, untrustedPathEntries names the rest", () => {
    // Arrange
    const cwd = join(repo, "sub");
    const pathValue = ["node_modules/.bin", outsideBin, join(repo, "node_modules", ".bin"), "/usr/bin"].join(delimiter);

    // Act + Assert
    expect(trustedPath(pathValue, cwd)).toBe([outsideBin, "/usr/bin"].join(delimiter));
    expect(untrustedPathEntries(pathValue, cwd)).toEqual(["node_modules/.bin", join(repo, "node_modules", ".bin")]);
  });
});

describe("the launcher init writes", () => {
  test("never comes from a crosscheck inside the repo, and is not the bare name while PATH has such an entry", async () => {
    // Arrange — the repo's own crosscheck first, the real one after it
    const env = { PATH: [join(repo, "node_modules", ".bin"), outsideBin, "/usr/bin", "/bin"].join(delimiter) };

    // Act
    const launcher = await inRepo(() => resolveLauncher(undefined, env, ENTRY));

    // Assert — the absolute form, which no PATH lookup can redirect
    expect(launcher.kind).toBe("entry");
  });

  test("is the bare install on a PATH a repo has no part in (the control arm)", async () => {
    // Arrange
    const env = { PATH: [outsideBin, "/usr/bin", "/bin"].join(delimiter) };

    // Act
    const launcher = await inRepo(() => resolveLauncher(undefined, env, ENTRY));

    // Assert
    expect(launcher).toEqual({ kind: "bare", path: join(outsideBin, "crosscheck") });
  });

  test("doctor WARNs on a bare crosscheck hook under a PATH that names a relative entry", async () => {
    // Arrange
    const env = { PATH: ["node_modules/.bin", outsideBin, "/usr/bin", "/bin"].join(delimiter) };

    // Act
    const health = await inRepo(() => checkLauncherCommand("crosscheck hook session-start", env, KEYWORDS));

    // Assert
    expect(health.level).toBe("WARN");
    expect(health.detail).toContain("PATH carries node_modules/.bin");
    expect(health.detail).toContain("rerun crosscheck init here");
  });
});
