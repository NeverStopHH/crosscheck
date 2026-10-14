/**
 * EVERY CROSSCHECK PROCESS STARTS ISOLATED FROM THE REPO IT RUNS IN
 * (config/runtime-isolation.ts). The process-level proof — a bait repo's
 * bunfig preload and .env steering nothing in a real hook — lives in
 * packages/cli/test/e2e/bait-repo-isolation.e2e.test.ts; this pins the
 * pieces: the flags every self-spawn carries, the two launcher forms init
 * writes, and doctor's verdict on a hook command written before the flags.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkLauncherCommand } from "../src/config/launcher-check.ts";
import { resolveCommandPrefix, resolveMcpLauncher } from "../src/config/launcher.ts";
import {
  ISOLATED_BUNFIG_PATH,
  RUNTIME_ISOLATION_FLAGS,
  bunStartupKeysIn,
  hasBunStartupKey,
  isRuntimeInjectionKey,
  selfLaunch,
  selfSpawnCmd,
  withoutRuntimeInjection,
} from "../src/config/runtime-isolation.ts";
import { summarizerWorkerEnv } from "../src/model/worker-env.ts";

const ENTRY = new URL("../../cli/src/bin/crosscheck.ts", import.meta.url).pathname;
const KEYWORDS = ["hook", "statusline", "mcp"];
const PACKAGES_DIR = new URL("../../", import.meta.url).pathname;
const THIS_MODULE = "connector-core/src/config/runtime-isolation.ts";

/** Every source file a package ships: its `src/`, which is what pack-npm.ts packs. */
const shippedSources = async (): Promise<readonly string[]> => {
  const files: string[] = [];
  for await (const file of new Bun.Glob("*/src/**/*.{ts,tsx,js,cjs,mjs}").scan({ cwd: PACKAGES_DIR })) {
    files.push(file);
  }
  return files.sort();
};

const filesMatching = async (pattern: RegExp): Promise<readonly string[]> => {
  const hits: string[] = [];
  for (const file of await shippedSources()) {
    if (pattern.test(await Bun.file(`${PACKAGES_DIR}${file}`).text())) {
      hits.push(file);
    }
  }
  return hits;
};

describe("the isolation flags", () => {
  test("are --no-env-file and crosscheck's own packaged bunfig, which exists", async () => {
    // Act + Assert
    expect(RUNTIME_ISOLATION_FLAGS).toEqual(["--no-env-file", `--config=${ISOLATED_BUNFIG_PATH}`]);
    expect(await Bun.file(ISOLATED_BUNFIG_PATH).exists()).toBe(true);
    expect((await Bun.file(ISOLATED_BUNFIG_PATH).text()).replace(/^#.*$/gm, "").trim()).toBe("");
  });

  test("lead every self-spawn, before the entry and its arguments", () => {
    // Act
    const cmd = selfSpawnCmd("/opt/crosscheck/worker-entry.ts", ["--session", "s1"]);

    // Assert
    expect(cmd).toEqual([
      process.execPath,
      "--no-env-file",
      `--config=${ISOLATED_BUNFIG_PATH}`,
      "/opt/crosscheck/worker-entry.ts",
      "--session",
      "s1",
    ]);
  });

  test("are in the hook prefix and the MCP entry init writes for the entry form", () => {
    // Arrange
    const launcher = { kind: "entry", launch: selfLaunch(ENTRY) } as const;

    // Act
    const prefix = resolveCommandPrefix(launcher);
    const mcp = resolveMcpLauncher(launcher);

    // Assert
    expect(prefix).toBe(`${process.execPath} --no-env-file --config=${ISOLATED_BUNFIG_PATH} ${ENTRY}`);
    expect(mcp).toEqual({
      type: "stdio",
      command: process.execPath,
      args: ["--no-env-file", `--config=${ISOLATED_BUNFIG_PATH}`, ENTRY, "mcp"],
    });
  });
});

describe("the one place that names the running bun", () => {
  // Structural, not lexical (review round 2, N1 and R1): a grep for two
  // spellings of an unflagged spawn missed `[launcher.runtime, entry, "mcp"]`
  // in the ACP injector and `String(process.execPath)` in a worker. A start
  // that does not take its argv from runtime-isolation.ts cannot name the
  // runtime without one of these words appearing in its file.
  test("is runtime-isolation.ts: no other shipped source mentions the runtime's path", async () => {
    // Arrange
    const sources = await shippedSources();

    // Act
    const naming = await filesMatching(/execPath|argv0/);

    // Assert — the walk is real (it sees the worker spawn sites), and only
    // the isolation module names the runtime
    expect(sources.length).toBeGreaterThan(100);
    expect(sources).toContain("connector-claude/src/hooks/landing-fetch.ts");
    expect(sources).toContain("connector-acp/src/inject/launcher.ts");
    expect(naming).toEqual([THIS_MODULE]);
  });

  test("no shipped source starts bun by its bare name", async () => {
    // Act
    const byName = await filesMatching(/cmd:\s*\[\s*["'`]bun["'`]|spawn\(\s*["'`]bun["'`]/);

    // Assert
    expect(byName).toEqual([]);
  });

  test("the absolute launcher carries only the finished isolated start", async () => {
    // Act
    const launch = selfLaunch(ENTRY);

    // Assert — there is no bare runtime or entry field a caller could reassemble
    expect(launch).toEqual({ command: process.execPath, args: [...RUNTIME_ISOLATION_FLAGS, ENTRY] });
    expect(Object.keys(launch).sort()).toEqual(["args", "command"]);
  });
});

describe("environment that configures the runtime (review round 2, N2)", () => {
  const INJECTION = ["BUN_OPTIONS", "BUN_CONFIG_VERBOSE_FETCH", "BUN_CONFIG_REGISTRY", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO", "NODE_OPTIONS"];
  const ORDINARY = ["PATH", "HOME", "BUN_INSTALL", "CROSSCHECK_HOME", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "XBUN_OPTIONS"];

  test("is bun's startup variables and NODE_OPTIONS, nothing else", () => {
    // Act + Assert
    expect(INJECTION.filter(isRuntimeInjectionKey)).toEqual(INJECTION);
    expect(ORDINARY.filter(isRuntimeInjectionKey)).toEqual([]);
  });

  test("the watch-mode variable is proven harmless: no restart, not stripped, never named (integration review L12)", () => {
    // Arrange: the one allow-listed name beside two that buy a restart
    const env = { PATH: "/bin", BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD: "1", BUN_OPTIONS: "--smol", BUN_CONFIG_REGISTRY: "https://registry.example.test" };

    // Act + Assert
    expect(isRuntimeInjectionKey("BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD")).toBe(false);
    expect(hasBunStartupKey({ PATH: "/bin", BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD: "1" })).toBe(false);
    expect(bunStartupKeysIn(env)).toEqual(["BUN_CONFIG_REGISTRY", "BUN_OPTIONS"]);
    expect(withoutRuntimeInjection(env)).toEqual({ PATH: "/bin", BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD: "1" });
  });

  test("is left out of what a child or a worker is given", () => {
    // Arrange
    const env = { PATH: "/bin", BUN_OPTIONS: "--preload ./x.ts", BUN_CONFIG_VERBOSE_FETCH: "curl", NODE_OPTIONS: "--require ./y.js", UNSET: undefined };

    // Act
    const child = withoutRuntimeInjection(env);
    const worker = summarizerWorkerEnv(env, "/tmp/home");

    // Assert
    expect(child).toEqual({ PATH: "/bin" });
    expect(Object.keys(worker).filter(isRuntimeInjectionKey)).toEqual([]);
    expect(worker["PATH"]).toBe("/bin");
  });

  test("is cleared first in every entry: the CLI and every worker import clean-runtime.ts before anything", async () => {
    // Arrange
    const entries: string[] = ["cli/src/bin/crosscheck.ts"];
    for await (const file of new Bun.Glob("*/src/**/*worker-entry.ts").scan({ cwd: PACKAGES_DIR })) {
      entries.push(file);
    }

    // Act
    const firstImports = await Promise.all(
      entries.map(async (file) => {
        const text = await Bun.file(`${PACKAGES_DIR}${file}`).text();
        return { file, first: /^import [^\n]*;$/m.exec(text)?.[0] ?? null };
      }),
    );

    // Assert — all ten workers and the CLI
    expect(entries.length).toBe(11);
    for (const entry of firstImports) {
      expect(entry).toEqual({ file: entry.file, first: 'import "@crosscheck/connector-core/config/clean-runtime.ts";' });
    }
  });

  /** An entry whose first import is clean-runtime.ts, reporting what it ended up with. */
  const runEntry = async (env: Record<string, string>): Promise<{ readonly exitCode: number; readonly seen: Record<string, unknown> }> => {
    const dir = await mkdtemp(join(tmpdir(), "cx-clean-runtime-"));
    try {
      const entry = join(dir, "entry.ts");
      await writeFile(
        entry,
        `import ${JSON.stringify(new URL("../src/config/clean-runtime.ts", import.meta.url).pathname)};\n` +
          `import { restartedWithoutRuntimeKeys } from ${JSON.stringify(new URL("../src/config/clean-restart.ts", import.meta.url).pathname)};\n` +
          "const stdin = await Bun.stdin.text();\n" +
          "console.log(JSON.stringify({ execArgv: process.execArgv, args: process.argv.slice(2), stdin, " +
          "bunConfig: process.env.BUN_CONFIG_MAX_HTTP_REQUESTS ?? null, watch: process.env.BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD ?? null, " +
          "nodeOptions: process.env.NODE_OPTIONS ?? null, restartedWithout: restartedWithoutRuntimeKeys(), marker: process.env.CROSSCHECK_RESTARTED_WITHOUT ?? null }));\n" +
          "process.exit(3);\n",
        "utf8",
      );
      const child = Bun.spawn({
        cmd: [process.execPath, entry, "first", "second"],
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir, ...env },
        stdin: new TextEncoder().encode("the payload"),
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdout = await new Response(child.stdout).text();
      return { exitCode: await child.exited, seen: JSON.parse(stdout.trim()) as Record<string, unknown> };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("a bun startup variable restarts the entry once: isolated, without it, same args, stdin and exit code — and told its name", async () => {
    // Act
    const run = await runEntry({ BUN_CONFIG_MAX_HTTP_REQUESTS: "64" });

    // Assert: the restarted process knows the NAME it was started without (doctor prints it), and the marker itself is gone
    expect(run.exitCode).toBe(3);
    expect(run.seen).toEqual({
      execArgv: [...RUNTIME_ISOLATION_FLAGS],
      args: ["first", "second"],
      stdin: "the payload",
      bunConfig: null,
      watch: null,
      nodeOptions: null,
      restartedWithout: ["BUN_CONFIG_MAX_HTTP_REQUESTS"],
      marker: null,
    });
  });

  test("the watch-mode variable alone costs no restart and stays (integration review L12)", async () => {
    // Act
    const run = await runEntry({ BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD: "1" });

    // Assert — started plain: no flags, the variable still there, nothing to report
    expect(run.exitCode).toBe(3);
    expect(run.seen).toEqual({
      execArgv: [],
      args: ["first", "second"],
      stdin: "the payload",
      bunConfig: null,
      watch: "1",
      nodeOptions: null,
      restartedWithout: [],
      marker: null,
    });
  });

  test("NODE_OPTIONS alone costs no restart: it is dropped for the children", async () => {
    // Act
    const run = await runEntry({ NODE_OPTIONS: "--max-old-space-size=64" });

    // Assert — started plain, so no restart means no flags
    expect(run.exitCode).toBe(3);
    expect(run.seen).toEqual({
      execArgv: [],
      args: ["first", "second"],
      stdin: "the payload",
      bunConfig: null,
      watch: null,
      nodeOptions: null,
      restartedWithout: [],
      marker: null,
    });
  });

  test("is stripped by the npm shim with the same set", async () => {
    // Arrange — the shim cannot import TypeScript, so it carries its own copy
    const shim = await Bun.file(new URL("../../../packaging/bin/crosscheck.cjs", import.meta.url).pathname).text();
    const literal = /const RUNTIME_INJECTION_KEY = \/(.+)\/;/.exec(shim)?.[1] ?? "";

    // Act
    const shimKey = new RegExp(literal);

    // Assert
    expect(literal.length).toBeGreaterThan(0);
    expect([...INJECTION, ...ORDINARY].filter((name) => shimKey.test(name))).toEqual(INJECTION);
    expect(shim).toContain('{ stdio: "inherit", env: restartedEnv(process.env) }');
    // ...and names what it stripped for the restarted bun, as clean-restart.ts does (L12).
    expect(shim).toContain('const RESTARTED_WITHOUT_ENV = "CROSSCHECK_RESTARTED_WITHOUT";');
    expect(shim).toContain("child[RESTARTED_WITHOUT_ENV] = names.join(\",\");");
  });
});

describe("doctor's launcher check on the isolation flags", () => {
  test("an entry-form hook command without them WARNs to rerun init", async () => {
    // Act
    const health = await checkLauncherCommand(`${process.execPath} ${ENTRY} hook session-start`, {}, KEYWORDS);

    // Assert
    expect(health.level).toBe("WARN");
    expect(health.detail).toContain("bunfig.toml preload and .env files run inside every hook");
    expect(health.detail).toContain("rerun crosscheck init");
  });

  test("the command init writes now passes", async () => {
    // Act
    const prefix = resolveCommandPrefix({ kind: "entry", launch: selfLaunch(ENTRY) });
    const health = await checkLauncherCommand(`${prefix} hook session-start`, {}, KEYWORDS);

    // Assert
    expect(health.level).toBe("PASS");
  });

  test("a --config naming a file that is gone FAILs, because bun would not start", async () => {
    // Act
    const health = await checkLauncherCommand(
      `${process.execPath} --no-env-file --config=/nonexistent/isolated.bunfig.toml ${ENTRY} hook session-start`,
      {},
      KEYWORDS,
    );

    // Assert
    expect(health.level).toBe("FAIL");
    expect(health.detail).toContain("/nonexistent/isolated.bunfig.toml does not exist");
  });
});
