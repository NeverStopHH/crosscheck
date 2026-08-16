#!/usr/bin/env node
"use strict";
/*
 * The published `crosscheck` bin: a plain-CommonJS launcher any Node >= 18 can
 * run, because npx invokes bins with Node and the real CLI is TypeScript that
 * only Bun executes. Three paths, in order:
 *
 *   1. Already under Bun (`bunx --bun crosscheck`, or bun ran this file):
 *      import the TS entry in-process — no second process, no PATH probing.
 *   2. Under Node with bun findable (PATH, then ~/.bun/bin — the default
 *      install location, which login-shell-less environments omit from PATH):
 *      re-exec the TS entry under bun, stdio inherited, signals forwarded.
 *   3. Under Node with no bun anywhere: ONE clear install instruction on
 *      stderr and exit 1 — never a stack trace.
 *
 * No TypeScript, no Bun APIs, no dependencies in this file — it must run
 * exactly where nothing else of ours can. Proven end-to-end (all three paths)
 * by packages/connector-claude/test/e2e/npm-package.e2e.test.ts.
 */
const path = require("node:path");

const ENTRY = path.join(
  __dirname,
  "..",
  "packages",
  "connector-claude",
  "src",
  "bin",
  "crosscheck.ts",
);

/* BSD sysexits EX_SOFTWARE: an internal failure that is not the child's. */
const EXIT_INTERNAL = 70;

if (process.versions.bun !== undefined) {
  import(ENTRY).catch(function (error) {
    console.error(
      "crosscheck failed to start: " +
        (error && error.message ? error.message : String(error)),
    );
    process.exit(EXIT_INTERNAL);
  });
} else {
  const { spawn, spawnSync } = require("node:child_process");
  const { homedir } = require("node:os");

  const findBun = function () {
    const candidates = ["bun", path.join(homedir(), ".bun", "bin", "bun")];
    for (const candidate of candidates) {
      const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
      if (probe.error === undefined && probe.status === 0) {
        return candidate;
      }
    }
    return null;
  };

  const bunExe = findBun();
  if (bunExe === null) {
    console.error(
      "crosscheck runs on the Bun runtime (https://bun.sh) — the hub, the " +
        "hooks and the MCP server all use it — and bun was not found on " +
        "this machine.",
    );
    console.error("Install it, then re-run the same command:");
    console.error("  curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  }

  const child = spawn(bunExe, [ENTRY].concat(process.argv.slice(2)), {
    stdio: "inherit",
  });

  /*
   * Forward what a terminal or supervisor sends, so killing the npx wrapper
   * kills the hub instead of orphaning it. The exit codes are the shell
   * convention 128 + signal number, applied when the CHILD dies by signal.
   */
  const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.on(signal, function () {
      child.kill(signal);
    });
  }
  child.on("exit", function (code, signal) {
    process.exit(
      code !== null ? code : SIGNAL_EXIT_CODES[signal] || EXIT_INTERNAL,
    );
  });
  child.on("error", function (error) {
    console.error("crosscheck failed to start bun: " + error.message);
    process.exit(EXIT_INTERNAL);
  });
}
