#!/usr/bin/env node
"use strict";
/*
 * The published `crosscheck` bin: a plain-CommonJS launcher any Node >= 18 can
 * run, because npx invokes bins with Node and the real CLI is TypeScript that
 * only Bun executes. Three paths, in order:
 *
 *   1. Already under Bun (`bunx --bun crosscheck-hub`, or bun ran this file):
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
 * by packages/cli/test/e2e/npm-package.e2e.test.ts.
 *
 * ISOLATED FROM THE REPO (connector-core config/runtime-isolation.ts). Hooks,
 * the statusline and the MCP server run with the project as cwd, and bun
 * would read that directory's bunfig.toml (a `preload` runs the repo's code
 * in the process holding the api key) and its .env files (which steer the hub
 * url, the key, a proxy). Path 2 therefore starts bun with `--no-env-file`
 * and `--config=` naming crosscheck's own empty bunfig inside this package —
 * the same relative layout in a global install and an npx cache (a checkout
 * has no packages/ beside packaging/bin, so this shim refuses to start there),
 * which is why it is resolved from __dirname and checked before the spawn: a
 * missing file must fail loudly, never fall back to reading the repo's.
 * Path 1 cannot be isolated from in here: the bun running this file has
 * already read the cwd's bunfig and .env. crosscheck never wires a hook that
 * way (init writes the node shim or `bun <flags> <entry>`); a person who runs
 * `bunx --bun crosscheck-hub` inside a repo gets that repo's bun config.
 */
const fs = require("node:fs");
const path = require("node:path");

const ENTRY = path.join(
  __dirname,
  "..",
  "packages",
  "cli",
  "src",
  "bin",
  "crosscheck.ts",
);

const ISOLATED_BUNFIG = path.join(
  __dirname,
  "..",
  "packages",
  "connector-core",
  "src",
  "config",
  "isolated.bunfig.toml",
);

/* BSD sysexits EX_SOFTWARE: an internal failure that is not the child's. */
const EXIT_INTERNAL = 70;

/*
 * ENVIRONMENT THAT CONFIGURES A RUNTIME (connector-core config/runtime-isolation.ts
 * `isRuntimeInjectionKey`, the same set): bun reads BUN_OPTIONS (a preload),
 * BUN_CONFIG_* (BUN_CONFIG_VERBOSE_FETCH prints the bearer) and BUN_INSPECT*
 * before the first line of crosscheck, and a host can supply them — a committed
 * .mcp.json entry's `env` block reaches this process. Bun is started without
 * them. NODE_OPTIONS goes too, but for THIS node process it has already acted
 * before this line ran; nothing of crosscheck's is loaded here, and nothing
 * here reads a config or a key.
 */
const RUNTIME_INJECTION_KEY = /^(BUN_OPTIONS|BUN_CONFIG_[A-Z0-9_]+|BUN_INSPECT[A-Z0-9_]*|NODE_OPTIONS)$/;

const withoutRuntimeInjection = function (env) {
  const kept = {};
  for (const name of Object.keys(env)) {
    if (!RUNTIME_INJECTION_KEY.test(name) && env[name] !== undefined) {
      kept[name] = env[name];
    }
  }
  return kept;
};

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

  if (!fs.existsSync(ISOLATED_BUNFIG)) {
    console.error(
      "crosscheck's own bunfig is missing from its package (" +
        ISOLATED_BUNFIG +
        "), and crosscheck will not start without it: it is what keeps a " +
        "repo's bunfig.toml and .env out of crosscheck. Reinstall crosscheck-hub.",
    );
    process.exit(EXIT_INTERNAL);
  }

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
      ["--no-env-file", "--config=" + ISOLATED_BUNFIG, ENTRY].concat(process.argv.slice(2)),
      { stdio: "inherit", env: withoutRuntimeInjection(process.env) },
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
