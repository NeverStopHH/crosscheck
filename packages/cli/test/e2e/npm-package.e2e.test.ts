/**
 * Proof by execution for the published npm package: pack the real tarball,
 * install it into a clean temp dir far from this workspace, and drive the
 * installed binary the way a stranger would — `npx crosscheck-hub --help`,
 * `crosscheck serve`, `crosscheck doctor` — through BOTH runtimes: the Node
 * shim (the npx path) and Bun directly. Reading package.json proves nothing;
 * this file is what makes the README one-liner a tested claim.
 *
 * Heavy setup (pack + npm install, network for registry deps) runs once,
 * lazily, inside the first test that needs it — bun's hook timeout is not
 * relied on — and every test that follows reuses the same install.
 *
 * REQUIREMENTS THE REST OF THE SUITE DOES NOT HAVE: node and npm on PATH,
 * and (on a cold npm cache) the npm registry over the network. When either
 * is missing, every test here SKIPS LOUDLY — a console warning naming what
 * was not proven — instead of failing on a non-defect. CI runners have node,
 * npm and network, so a skip can only happen on a developer machine.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const PACK_SCRIPT = join(
  REPO_ROOT,
  "packages",
  "cli",
  "scripts",
  "pack-npm.ts",
);

/** Pack + clean npm install, registry download included, on a cold CI cache. */
const SETUP_TIMEOUT_MS = 240_000;
/** Cold PGlite boot inside the packed install, plus the shim's re-exec hop. */
const SERVE_TIMEOUT_MS = 30_000;
const DRIVE_TIMEOUT_MS = 30_000;
/** A SIGTERM the shim forwards; longer than this is a hang, not a shutdown. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Source-only tarball: the four runtime deps stay EXTERNAL (fetched by npm),
 * so the packed size is our own source plus licenses and nothing else. The
 * cap is generous headroom over the measured size, not a target — it exists
 * to catch the day node_modules, docs or fixtures leak into the whitelist.
 */
const TARBALL_SIZE_CAP_BYTES = 1_000_000;

const nodeExe = Bun.which("node");
const npmExe = Bun.which("npm");

/** Fast either way on a working network; unanswered = treated as offline. */
const REGISTRY_PROBE_TIMEOUT_MS = 3_000;
const REGISTRY_URL = "https://registry.npmjs.org/";

interface Installed {
  readonly ok: true;
  readonly tarballPath: string;
  readonly installDir: string;
  readonly packageDir: string;
  readonly binPath: string;
  readonly shimPath: string;
}

/** The environment cannot run this suite; the reason is what gets warned. */
interface Skipped {
  readonly ok: false;
  readonly reason: string;
}

type Setup = Installed | Skipped;

let setupPromise: Promise<Setup> | undefined;
const cleanups: string[] = [];

const isRegistryUnreachable = async (): Promise<boolean> => {
  try {
    await fetch(REGISTRY_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(REGISTRY_PROBE_TIMEOUT_MS),
    });
    return false;
  } catch {
    return true;
  }
};

/**
 * The loud part of the loud skip: a green run with this warning in it proved
 * NOTHING about the packed tarball, and the warning is the only place that
 * says so. Returned as a value so each test can `return warnSkip(...)`.
 */
const warnSkip = (reason: string): undefined => {
  console.warn(
    `npm-package e2e SKIPPED: ${reason} — the packed-tarball claims were NOT proven on this run`,
  );
  return undefined;
};

const run = async (
  cmd: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const setup = async (): Promise<Setup> => {
  if (nodeExe === null || npmExe === null) {
    return {
      ok: false,
      reason:
        "node and npm are required on PATH (CI runners have both; install them locally)",
    };
  }
  // Packing is local disk work — a failure here is a defect, never a skip.
  const pack = await run([process.execPath, PACK_SCRIPT]);
  if (pack.exitCode !== 0) {
    throw new Error(`pack-npm.ts failed:\n${pack.stdout}\n${pack.stderr}`);
  }
  const tarballPath = pack.stdout.trim().split("\n").at(-1) ?? "";
  if (!tarballPath.endsWith(".tgz")) {
    throw new Error(`pack-npm.ts must print the tarball path last, got: ${tarballPath}`);
  }

  const installDir = await mkdtemp(join(tmpdir(), "crosscheck-pack-"));
  cleanups.push(installDir);
  await writeFile(
    join(installDir, "package.json"),
    `${JSON.stringify({ name: "pack-probe", private: true })}\n`,
    "utf8",
  );
  const install = await run(
    [npmExe, "install", tarballPath, "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: installDir },
  );
  if (install.exitCode !== 0) {
    // Only a PROVEN-unreachable registry downgrades this to a skip: the
    // install needs the network exactly when the npm cache is cold, and an
    // offline laptop failing 5 tests over that would train people to ignore
    // red. Any other install failure is a packaging defect and stays one.
    if (await isRegistryUnreachable()) {
      return {
        ok: false,
        reason: `npm registry unreachable (offline?) and npm install failed:\n${install.stderr}`,
      };
    }
    throw new Error(`npm install failed:\n${install.stdout}\n${install.stderr}`);
  }
  // The npm PACKAGE is `crosscheck-hub` (npm's similarity rule refused
  // `crosscheck`), so that is the install directory; the BIN stays `crosscheck`.
  const packageDir = join(installDir, "node_modules", "crosscheck-hub");
  return {
    ok: true,
    tarballPath,
    installDir,
    packageDir,
    binPath: join(installDir, "node_modules", ".bin", "crosscheck"),
    shimPath: join(packageDir, "bin", "crosscheck.cjs"),
  };
};

const getInstalled = (): Promise<Setup> => {
  setupPromise ??= setup();
  return setupPromise;
};

afterAll(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe("packed npm tarball", () => {
  test("ships every runtime asset and both licenses, and nothing else", async () => {
    // Arrange
    const installed = await getInstalled();
    if (!installed.ok) {
      return warnSkip(installed.reason);
    }
    const { tarballPath, packageDir } = installed;

    // Act: the contractual licensing split, per shipped directory
    const mustShip = [
      "package.json",
      "README.md",
      "LICENSE", // the root license MAP: which package is Apache, which is FSL
      "bin/crosscheck.cjs",
      "packages/schema/LICENSE",
      "packages/schema/NOTICE",
      "packages/schema/src/index.ts",
      "packages/server/LICENSE",
      "packages/server/src/index.ts",
      "packages/server/src/db/bootstrap.sql", // non-TS runtime asset
      "packages/server/src/ui/pages/login.tsx",
      "packages/connector-core/LICENSE",
      "packages/connector-core/NOTICE",
      "packages/connector-core/src/mcp/server.ts",
      "packages/connector-core/src/spool/append.ts",
      "packages/connector-acp/LICENSE",
      "packages/connector-acp/NOTICE",
      "packages/connector-acp/src/proxy.ts",
      "packages/connector-claude/LICENSE",
      "packages/connector-claude/NOTICE",
      "packages/connector-claude/src/hooks/index.ts",
      "packages/connector-cursor/LICENSE",
      "packages/connector-cursor/NOTICE",
      "packages/connector-cursor/src/index.ts",
      "packages/cli/LICENSE",
      "packages/cli/src/bin/crosscheck.ts",
      "packages/cli/src/cli/index.ts",
    ];
    const mustNotShip = [
      "packages/connector-claude/test",
      "packages/connector-core/test",
      "packages/connector-acp/test",
      "packages/connector-cursor/test",
      "packages/cli/test",
      "packages/server/test",
      "packages/schema/test",
      "packages/connector-claude/scripts",
      "packages/connector-core/scripts",
      "packages/cli/scripts",
      "docs",
      "bun.lock",
      // One package, one manifest — ALL SEVEN guarded: a nested package.json
      // would also change self-name resolution for everything beneath it.
      "packages/connector-claude/package.json",
      "packages/connector-core/package.json",
      "packages/connector-acp/package.json",
      "packages/connector-cursor/package.json",
      "packages/cli/package.json",
      "packages/schema/package.json",
      "packages/server/package.json",
    ];

    // Assert
    for (const relative of mustShip) {
      expect(await exists(join(packageDir, relative)), relative).toBe(true);
    }
    for (const relative of mustNotShip) {
      expect(await exists(join(packageDir, relative)), relative).toBe(false);
    }
    const tarball = await stat(tarballPath);
    expect(tarball.size).toBeLessThan(TARBALL_SIZE_CAP_BYTES);
    // npm pack names the tarball after the manifest's `name` — pinning the
    // basename pins the PUBLISHED name (e.g. crosscheck-hub-0.5.0.tgz).
    const workspaceVersion = (
      JSON.parse(
        await readFile(join(REPO_ROOT, "packages", "connector-claude", "package.json"), "utf8"),
      ) as { version: string }
    ).version;
    expect(basename(tarballPath)).toBe(`crosscheck-hub-${workspaceVersion}.tgz`);
  }, SETUP_TIMEOUT_MS);

  test("npx path: node runs the shim, the shim re-execs under bun", async () => {
    // Arrange
    const installed = await getInstalled();
    if (!installed.ok) {
      return warnSkip(installed.reason);
    }
    const { shimPath } = installed;
    const workspaceVersion = (
      JSON.parse(
        await readFile(join(REPO_ROOT, "packages", "connector-claude", "package.json"), "utf8"),
      ) as { version: string }
    ).version;

    // Act: explicitly under NODE — this is what npx does on every platform
    const help = await run([nodeExe ?? "node", shimPath, "--help"]);
    const version = await run([nodeExe ?? "node", shimPath, "--version"]);

    // Assert: output can only come from the TS entry, which node cannot run —
    // so seeing it proves the re-exec under bun happened.
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("usage: crosscheck <command>");
    expect(help.stdout).toContain("serve");
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(`crosscheck ${workspaceVersion}`);
  }, DRIVE_TIMEOUT_MS);

  test("bun path: the shim imports the TS entry in-process under bun", async () => {
    // Arrange: `bunx crosscheck-hub` runs bin scripts under BUN (and plain bunx
    // substitutes bun for the node shebang on node-less machines) — that is
    // shim path 1, which none of the node-driven tests above can reach.
    const installed = await getInstalled();
    if (!installed.ok) {
      return warnSkip(installed.reason);
    }
    const { shimPath } = installed;
    const workspaceVersion = (
      JSON.parse(
        await readFile(join(REPO_ROOT, "packages", "connector-claude", "package.json"), "utf8"),
      ) as { version: string }
    ).version;

    // Act: process.execPath under `bun test` IS bun
    const version = await run([process.execPath, shimPath, "--version"]);
    const help = await run([process.execPath, shimPath, "--help"]);

    // Assert: the in-process dynamic import resolved the packed TS entry
    expect(version.exitCode).toBe(0);
    expect(version.stdout.trim()).toBe(`crosscheck ${workspaceVersion}`);
    expect(version.stderr).not.toContain("failed to start");
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("usage: crosscheck <command>");
  }, DRIVE_TIMEOUT_MS);

  test("packed acp subcommand resolves its dynamic import and refuses bad args", async () => {
    // Arrange: `acp` lives in a SEPARATE workspace package reached through a
    // dynamic import — the one specifier the static rewrite audit cannot
    // execute. Driving it proves crosscheck-hub/connector-acp resolves in
    // the installed tree; the missing `--` makes it exit before any spawn.
    const installed = await getInstalled();
    if (!installed.ok) {
      return warnSkip(installed.reason);
    }

    // Act
    const refusal = await run([process.execPath, installed.shimPath, "acp"]);

    // Assert: the acp usage text can only come from the packed connector-acp.
    expect(refusal.exitCode).toBe(64);
    expect(refusal.stderr).toContain("usage: crosscheck acp");
  }, DRIVE_TIMEOUT_MS);

  test("without bun the shim prints one install line, never a stack trace", async () => {
    // Arrange: PATH without bun, HOME without ~/.bun — the shim's two probes
    const installed = await getInstalled();
    if (!installed.ok) {
      return warnSkip(installed.reason);
    }
    const { shimPath } = installed;
    const emptyHome = await mkdtemp(join(tmpdir(), "crosscheck-nobun-"));
    cleanups.push(emptyHome);
    const nodeDir = resolve(nodeExe ?? "/usr/local/bin/node", "..");

    // Act
    const result = await run([nodeExe ?? "node", shimPath, "--help"], {
      env: { PATH: `${nodeDir}:/usr/bin:/bin`, HOME: emptyHome },
    });

    // Assert
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("curl -fsSL https://bun.sh/install | bash");
    expect(result.stderr).not.toMatch(/\n\s+at /);
  }, DRIVE_TIMEOUT_MS);

  test("serve boots from the tarball: banner, 200 on /ui/login, clean SIGTERM", async () => {
    // Arrange: a real data dir in tmp — this is the embedded-PGlite promise
    const installed = await getInstalled();
    if (!installed.ok) {
      return warnSkip(installed.reason);
    }
    const { binPath, installDir } = installed;
    const dataDir = join(installDir, "hub-data");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const proc = Bun.spawn({
      cmd: [nodeExe ?? "node", binPath, "serve"],
      cwd: installDir,
      env: {
        ...process.env,
        PORT: String(port),
        CROSSCHECK_DATA_DIR: dataDir,
        ADMIN_TOKEN: "pack-e2e-admin",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Act
    const decoder = new TextDecoder();
    let banner = "";
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const deadline = Date.now() + SERVE_TIMEOUT_MS - SHUTDOWN_TIMEOUT_MS;
    while (!banner.includes("listening") && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolveRace) => {
          setTimeout(() => resolveRace("timeout"), deadline - Date.now());
        }),
      ]);
      if (next === "timeout" || next.done) {
        break;
      }
      banner += decoder.decode(next.value, { stream: true });
    }
    reader.releaseLock();
    const response = banner.includes("listening")
      ? await fetch(`http://127.0.0.1:${port}/ui/login`)
      : null;
    proc.kill("SIGTERM");
    const exit = await Promise.race([
      proc.exited,
      new Promise<"hung">((resolveRace) => {
        setTimeout(() => resolveRace("hung"), SHUTDOWN_TIMEOUT_MS);
      }),
    ]);

    // Assert: the WASM postgres came out of the tarball's dependency tree and
    // wrote a real cluster into CROSSCHECK_DATA_DIR; SIGTERM through the shim
    // took the whole process tree down, orphaning nothing.
    expect(banner).toContain(`listening on :${port}`);
    expect(response?.status).toBe(200);
    expect((await readFile(join(dataDir, "PG_VERSION"), "utf8")).trim()).toBe("17");
    expect(exit).not.toBe("hung");
    const orphanProbe = await fetch(`http://127.0.0.1:${port}/ui/login`).catch(() => null);
    expect(orphanProbe).toBeNull();
  }, SERVE_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS);

  test("doctor runs from the tarball and names what is missing", async () => {
    // Arrange: a fresh git repo, an empty crosscheck home — a stranger's laptop
    const installed = await getInstalled();
    if (!installed.ok) {
      return warnSkip(installed.reason);
    }
    const { binPath } = installed;
    const repoDir = await mkdtemp(join(tmpdir(), "crosscheck-doctor-"));
    cleanups.push(repoDir);
    await run(["git", "init", "-q"], { cwd: repoDir });
    const home = join(repoDir, "cx-home");

    // Act
    const result = await run([nodeExe ?? "node", binPath, "doctor"], {
      cwd: repoDir,
      env: { ...process.env, CROSSCHECK_HOME: home },
    });

    // Assert: exit 2 = FAIL findings (nothing configured yet), with the
    // check names present — a crash would print neither.
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("config present");
    expect(result.stdout).toContain("hub reachable");
  }, DRIVE_TIMEOUT_MS);
});
