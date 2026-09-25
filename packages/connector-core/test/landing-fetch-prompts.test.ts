/**
 * A FETCH NOBODY ASKED FOR MUST NEVER ASK ANYBODY ANYTHING
 * (docs/1.0/landed-changes.md, step 2).
 *
 * The background fetch starts from a hook, while an agent is working. If it
 * could prompt, the prompt would land somewhere the developer is not looking:
 * an editor's password dialog (VS Code hands its terminals a GIT_ASKPASS
 * that opens one), or ssh asking for a key passphrase on the terminal the
 * agent's own screen is drawn on — reading the next keystrokes as the
 * passphrase. Measured before this was built: a child a hook starts the
 * ordinary way CAN open /dev/tty.
 *
 * So every way git or ssh could ask is closed, and each is pinned here with
 * the real binary doing the asking: an HTTP origin that answers 401, a fake
 * `ssh` on PATH, the developer's own ssh command, and a pseudo-terminal.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { fetchLandingBranches } from "../src/landed-changes/fetch-worker.ts";
import { gitIn, makeLandingRepos } from "./fixtures/landing-repos.ts";
import type { LandingRepos } from "./fixtures/landing-repos.ts";

const HEAVY_SETUP_MS = 60_000;

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

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const repos = async (label: string): Promise<LandingRepos> => {
  const made = await makeLandingRepos(label);
  paths.push(made.base);
  return made;
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** An executable that appends its argv, one per line, to `log` and fails. */
const recorder = async (dir: string, name: string, log: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\necho hunter2\nexit 255\n`, "utf8");
  await chmod(path, 0o755);
  return path;
};

const readLines = async (path: string): Promise<readonly string[]> =>
  (await exists(path)) ? (await readFile(path, "utf8")).split("\n") : [];

describe("credentials that would need a prompt", () => {
  test(
    "an HTTP origin asking for a password fails the fetch without running any askpass",
    async () => {
      const made = await repos("lf-http-401");
      let hits = 0;
      const server = Bun.serve({
        port: 0,
        fetch: () => {
          hits += 1;
          return new Response("authentication required", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="acme"' },
          });
        },
      });
      servers.push(server);
      await gitIn(made.reader, [
        "remote",
        "set-url",
        "origin",
        `http://127.0.0.1:${String(server.port)}/acme/api.git`,
      ]);
      const askpassLog = join(made.base, "askpass.log");
      const askpass = await recorder(made.base, "askpass", askpassLog);
      // Every place a developer's machine can name an askpass program.
      await gitIn(made.reader, ["config", "core.askPass", askpass]);

      const outcome = await fetchLandingBranches({
        root: made.reader,
        env: { ...ENV, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass },
      });

      expect(outcome).toEqual({ kind: "failed", step: "ls-remote", timedOut: false });
      // Git DID reach the server and was told to authenticate — the askpass
      // stayed silent because it was never run, not because nothing asked.
      expect(hits).toBeGreaterThan(0);
      expect(await readLines(askpassLog)).toEqual([]);
    },
    HEAVY_SETUP_MS,
  );
});

describe("ssh", () => {
  const sshOrigin = "ssh://git@example.invalid/acme/api.git";

  test(
    "runs in batch mode when the developer has not chosen an ssh command",
    async () => {
      const made = await repos("lf-ssh-batch");
      await gitIn(made.reader, ["remote", "set-url", "origin", sshOrigin]);
      const bin = join(made.base, "bin");
      await Bun.write(join(bin, ".keep"), "");
      const sshLog = join(made.base, "ssh.log");
      await recorder(bin, "ssh", sshLog);

      const outcome = await fetchLandingBranches({
        root: made.reader,
        env: { ...ENV, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      });

      expect(outcome.kind).toBe("failed");
      expect(await readLines(sshLog)).toContain("BatchMode=yes");
    },
    HEAVY_SETUP_MS,
  );

  test.each([
    ["GIT_SSH_COMMAND", "env"],
    ["core.sshCommand", "config"],
  ] as const)(
    "the developer's own %s is kept as it is",
    async (name, where) => {
      const made = await repos(`lf-ssh-own-${where}`);
      await gitIn(made.reader, ["remote", "set-url", "origin", sshOrigin]);
      const bin = join(made.base, "bin");
      await Bun.write(join(bin, ".keep"), "");
      const defaultLog = join(made.base, "default-ssh.log");
      await recorder(bin, "ssh", defaultLog);
      const ownLog = join(made.base, "own-ssh.log");
      const own = await recorder(made.base, "my-ssh", ownLog);
      const command = `${own} -i /keys/work`;
      if (where === "config") {
        await gitIn(made.reader, ["config", name, command]);
      }

      const outcome = await fetchLandingBranches({
        root: made.reader,
        env: {
          ...ENV,
          PATH: `${bin}:${process.env["PATH"] ?? ""}`,
          ...(where === "env" ? { [name]: command } : {}),
        },
      });

      expect(outcome.kind).toBe("failed");
      const ownArgs = await readLines(ownLog);
      expect(ownArgs).toContain("/keys/work");
      expect(ownArgs).not.toContain("BatchMode=yes");
      expect(await readLines(defaultLog)).toEqual([]);
    },
    HEAVY_SETUP_MS,
  );

  test(
    "the developer's own GIT_SSH program is kept as it is",
    async () => {
      const made = await repos("lf-ssh-own-git-ssh");
      await gitIn(made.reader, ["remote", "set-url", "origin", sshOrigin]);
      const ownLog = join(made.base, "own-ssh.log");
      const own = await recorder(made.base, "my-ssh", ownLog);

      const outcome = await fetchLandingBranches({
        root: made.reader,
        env: { ...ENV, GIT_SSH: own },
      });

      expect(outcome.kind).toBe("failed");
      const ownArgs = await readLines(ownLog);
      expect(ownArgs.length).toBeGreaterThan(0);
      expect(ownArgs).not.toContain("BatchMode=yes");
    },
    HEAVY_SETUP_MS,
  );
});

/**
 * A pseudo-terminal, the way a developer's terminal hosts the agent. BSD
 * `script` (macOS) takes the command as argv; util-linux `script` takes one
 * shell string.
 */
const inPty = (argv: readonly string[]): readonly string[] =>
  process.platform === "darwin"
    ? ["script", "-q", "/dev/null", ...argv]
    : ["script", "-q", "-e", "-c", argv.map((arg) => `'${arg}'`).join(" "), "/dev/null"];

const TTY_CHECK = (out: string): string =>
  `if (exec 3</dev/tty) 2>/dev/null; then echo TTY; else echo NOTTY; fi > '${out}'`;

const SPAWN_MODULE = resolve(import.meta.dir, "..", "src", "landed-changes", "fetch-trigger.ts");

/** Runs `program` (a bun script) inside a pty; resolves when it and its child are done. */
const runInPty = async (dir: string, program: string, out: string): Promise<string | null> => {
  const script = join(dir, "program.ts");
  await writeFile(script, program, "utf8");
  const proc = Bun.spawn({
    cmd: [...inPty([process.execPath, script])],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  for (let waited = 0; waited < 5000; waited += 50) {
    if (await exists(out)) {
      const text = (await readFile(out, "utf8")).trim();
      if (text.length > 0) {
        return text;
      }
    }
    await Bun.sleep(50);
  }
  return null;
};

const plainSpawn = (out: string): string =>
  `const p = Bun.spawn({ cmd: ["sh", "-c", ${JSON.stringify(TTY_CHECK(out))}], stdin: "ignore", stdout: "ignore", stderr: "ignore" });\nawait p.exited;\n`;

const workerSpawn = (out: string, home: string): string =>
  `const { startDetachedWorker } = await import(${JSON.stringify(SPAWN_MODULE)});\n` +
  `startDetachedWorker({ cmd: ["sh", "-c", ${JSON.stringify(TTY_CHECK(out))}], env: process.env, home: ${JSON.stringify(home)} });\n`;

const PTY_DIR = await mkdtemp(join(tmpdir(), "cx-lf-pty-"));
/** Whether this machine can host a pty at all — the control, run once. */
const PTY_WORKS = (await runInPty(PTY_DIR, plainSpawn(join(PTY_DIR, "control.out")), join(PTY_DIR, "control.out"))) === "TTY";

/**
 * The portable half of the same proof, for machines without a usable pty
 * (the Linux runner that proves the mutation anchors): a child started in
 * its own session leads its own process group. One started the ordinary way
 * stays in the parent's group — and in its terminal.
 */
const groupOf = async (dir: string, start: (cmd: readonly string[]) => void): Promise<{ pid: string; pgid: string }> => {
  const out = join(dir, `group-${String(Math.random()).slice(2)}.out`);
  start(["sh", "-c", `echo "$$ $(ps -o pgid= -p $$)" > '${out}.tmp' && mv '${out}.tmp' '${out}'`]);
  for (let waited = 0; waited < 5000; waited += 50) {
    if (await exists(out)) {
      const [pid = "", pgid = ""] = (await readFile(out, "utf8")).trim().split(/\s+/);
      return { pid, pgid };
    }
    await Bun.sleep(50);
  }
  throw new Error("the child never reported its process group");
};

describe("no terminal to ask on", () => {
  test("the background worker leads its own process group, where an ordinary child does not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cx-lf-pgid-"));
    paths.push(dir);
    const { startDetachedWorker } = await import(SPAWN_MODULE);

    const worker = await groupOf(dir, (cmd) => {
      startDetachedWorker({ cmd, env: process.env, home: dir });
    });
    const ordinary = await groupOf(dir, (cmd) => {
      Bun.spawn({ cmd: [...cmd], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    });

    expect(worker.pid.length).toBeGreaterThan(0);
    expect(worker.pgid).toBe(worker.pid);
    // The control: the same probe, started the ordinary way, is NOT a leader.
    expect(ordinary.pgid).not.toBe(ordinary.pid);
  });


  test.skipIf(!PTY_WORKS)(
    "the background worker starts without a controlling terminal, where an ordinary child has one",
    async () => {
      paths.push(PTY_DIR);
      const out = join(PTY_DIR, "worker.out");

      // The control above proved an ordinary child of this pty CAN open
      // /dev/tty — which is exactly what ssh does to ask for a passphrase.
      expect(await runInPty(PTY_DIR, workerSpawn(out, PTY_DIR), out)).toBe("NOTTY");
    },
    HEAVY_SETUP_MS,
  );
});
