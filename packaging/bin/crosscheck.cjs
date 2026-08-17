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
 *      Bun is spawned DIRECTLY — a failed spawn falls through to the next
 *      location — because a separate `bun --version` pre-probe would add a
 *      whole process launch to every hook invocation through this shim.
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
  const { spawn } = require("node:child_process");
  const { homedir } = require("node:os");

  const CANDIDATES = ["bun", path.join(homedir(), ".bun", "bin", "bun")];

  /*
   * Forward what a terminal or supervisor sends, so killing the npx wrapper
   * kills the hub instead of orphaning it. The exit codes are the shell
   * convention 128 + signal number, applied when the CHILD dies by signal.
   */
  const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  let child = null;
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.on(signal, function () {
      if (child !== null) {
        child.kill(signal);
      }
    });
  }

  /* A spawn error meaning "this candidate is not runnable here, try the next". */
  const RETRIABLE_SPAWN_ERRORS = ["ENOENT", "ENOTDIR", "EACCES"];

  const startWith = function (index) {
    if (index >= CANDIDATES.length) {
      console.error(
        "crosscheck runs on the Bun runtime (https://bun.sh) — the hub, the " +
          "hooks and the MCP server all use it — and bun was not found on " +
          "this machine.",
      );
      console.error("Install it, then re-run the same command:");
      console.error("  curl -fsSL https://bun.sh/install | bash");
      process.exit(1);
    }
    const current = spawn(
      CANDIDATES[index],
      [ENTRY].concat(process.argv.slice(2)),
      { stdio: "inherit" },
    );
    child = current;
    let retried = false;
    current.on("error", function (error) {
      if (RETRIABLE_SPAWN_ERRORS.indexOf(error.code) !== -1) {
        retried = true;
        startWith(index + 1);
        return;
      }
      console.error("crosscheck failed to start bun: " + error.message);
      process.exit(EXIT_INTERNAL);
    });
    current.on("exit", function (code, signal) {
      /* A failed spawn can emit both `error` and `exit`; `error` already
       * moved on to the next candidate, so this event is not an answer. */
      if (retried) {
        return;
      }
      process.exit(
        code !== null ? code : SIGNAL_EXIT_CODES[signal] || EXIT_INTERNAL,
      );
    });
  };
  startWith(0);
}
