/**
 * NO TEST REACHES A REAL HUB. Runs before every test file (wired by every
 * bunfig.toml that runs tests: the repo root's and each package's own, so
 * both `bun test` invocation cwds get it) and wraps the global `fetch`: a
 * request to the port a real hub listens on (DEFAULT_PORT 7100, on any
 * loopback spelling) or to any tailnet host is refused before a socket is
 * opened (the rules: test/network-guard-rules.ts).
 *
 * Why it exists: a developer machine runs a REAL hub on 127.0.0.1:7100, and
 * three config-only tests once named exactly that URL. None of them connected,
 * but nothing would have stopped one that did — a test that reached it would
 * write synthetic sessions, records and claims into a team's real archive.
 *
 * The connector's HTTP client (src/http/client.ts) calls the global `fetch`
 * at request time, so every hub call a test drives in-process — a hook run
 * through `runHook`, an MCP tool, a CLI command — passes through this guard;
 * test/network-guard.test.ts proves both doors and that this very run was
 * wired. A refused request rejects the way a network failure does, so
 * fail-open code paths stay fail-open, and each refusal is counted.
 *
 * AND THE CHILDREN (round 3, F-M3). A wrapped `fetch` guards this process
 * only, and tests spawn hooks, CLIs, servers and workers of their own. So the
 * run that starts first also:
 *
 *   - deletes the hub variables a developer's shell may export
 *     (HUB_ENV_KEYS) from `process.env`, so no child spawned with
 *     `{...process.env}` is pointed at the real hub or the real archive —
 *     keeping only what a test sets: an in-process hub on a port of its own,
 *     an archive under the OS temp directory;
 *   - points CROSSCHECK_HOME at a temp directory of its own unless it is one
 *     already, so no such child reads or writes ~/.crosscheck;
 *   - exports `BUN_OPTIONS=--preload=<this file>`, so every bun child spawned
 *     with that env runs this guard before its own entry;
 *   - marks the env (GUARD_CHILD_ENV), so a child keeps what it was handed —
 *     its test hub's URL among it — and only wraps its own `fetch`.
 *
 * A child spawned with NO `env:` gets the environment this process STARTED
 * with, not `process.env` (Bun.spawn and node:child_process alike), so none
 * of the above reaches it: network-guard.test.ts fails on any bun child in a
 * test tree spawned that way.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BLOCKED_FETCHES_KEY,
  GUARD_CHILD_ENV,
  GUARD_INSTALLED_KEY,
  HUB_CONNECTION_KEYS,
  HUB_DATA_KEY,
  isRealHubUrl,
  isTestHubUrl,
  isUnderDir,
  withGuardPreload,
} from "./network-guard-rules.ts";
import type { GuardMarks } from "./network-guard-rules.ts";

type FetchInput = Parameters<typeof fetch>[0];

const targetOf = (input: FetchInput): URL | null => {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
};

const marks = globalThis as GuardMarks;
const unguarded = globalThis.fetch;

const guarded = (input: FetchInput, init?: RequestInit): Promise<Response> => {
  const target = targetOf(input);
  if (target !== null && isRealHubUrl(target)) {
    marks[BLOCKED_FETCHES_KEY] = (marks[BLOCKED_FETCHES_KEY] ?? 0) + 1;
    return Promise.reject(
      new TypeError(`test network guard: ${target.host} may be a real hub — start an in-process hub on port 0`),
    );
  }
  return unguarded(input, init);
};

if (marks[GUARD_INSTALLED_KEY] !== true) {
  globalThis.fetch = Object.assign(guarded, { preconnect: unguarded.preconnect }) as typeof fetch;
  marks[GUARD_INSTALLED_KEY] = true;
}

/**
 * The directories a test's homes and archives live in: this process's temp
 * directory, and the platform's own — a child handed an env without TMPDIR
 * resolves a different one than the test that made its home.
 */
const TEMP_ROOTS: readonly string[] = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

const isTempPath = (path: string | undefined): boolean => TEMP_ROOTS.some((root) => isUnderDir(path, root));

/**
 * What the first run hands every child it spawns with `{...process.env}`: no
 * hub, a home of its own, this guard. What only a TEST could have set is
 * kept — an in-process hub's URL on a port of its own (and the key that goes
 * with it), a home or an archive under the OS temp directory — so a process
 * a test or a probe starts with an explicit env and this guard preloaded,
 * and no child marker, still talks to the hub it was handed.
 */
const guardTheChildren = (): void => {
  if (!isTestHubUrl(process.env["CROSSCHECK_HUB_URL"])) {
    for (const key of HUB_CONNECTION_KEYS) {
      delete process.env[key];
    }
  }
  if (!isTempPath(process.env[HUB_DATA_KEY])) {
    delete process.env[HUB_DATA_KEY];
  }
  if (!isTempPath(process.env["CROSSCHECK_HOME"])) {
    const home = mkdtempSync(join(tmpdir(), "cx-test-home-"));
    process.env["CROSSCHECK_HOME"] = home;
    process.on("exit", () => {
      rmSync(home, { recursive: true, force: true });
    });
  }
  process.env["BUN_OPTIONS"] = withGuardPreload(process.env["BUN_OPTIONS"], import.meta.path);
  process.env[GUARD_CHILD_ENV] = "1";
};

/**
 * A CROSSCHECK ENTRY A TEST STARTS RUNS GUARDED, NOT RESTARTED (the
 * key-origin merge). Every crosscheck entry's first import restarts it
 * without `BUN_OPTIONS` (connector-core config/runtime-isolation.ts
 * `ensureCleanRuntime`), so under this guard's `BUN_OPTIONS` a hook, the cli,
 * the ACP proxy or a worker came back as a second process with no guard at
 * all — another pid, and signals sent to the first never reaching it. A child
 * whose `BUN_OPTIONS` is this guard ALONE, installed just above, drops it
 * before its entry runs: nothing else was preloaded, so a restart would undo
 * nothing. Any other preload stays, and the entry restarts as it must.
 */
const CROSSCHECK_ENTRY = /\/packages\/[^/]+\/src\/(?:bin\/crosscheck|(?:[^/]+\/)*[^/]*worker-entry)\.ts$/u;

const isGuardAlone = (bunOptions: string | undefined): boolean =>
  bunOptions?.trim() === withGuardPreload(undefined, import.meta.path);

if (
  process.env[GUARD_CHILD_ENV] === "1" &&
  CROSSCHECK_ENTRY.test(process.argv[1] ?? "") &&
  isGuardAlone(process.env["BUN_OPTIONS"])
) {
  delete process.env["BUN_OPTIONS"];
}

if (process.env[GUARD_CHILD_ENV] !== "1") {
  guardTheChildren();
}
