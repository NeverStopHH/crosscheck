/**
 * Installs the connector into the fixture exactly as a developer would (09 §3),
 * per run and into a throwaway `CROSSCHECK_HOME` — NEVER `~/.crosscheck`:
 *
 *   1. `assertHomeUnderRun` refuses before anything runs unless the resolved
 *      CROSSCHECK_HOME sits under this run's temp dir and is not the real home.
 *      This is the one guardrail the pre-registration names twice ("Never
 *      `~/.crosscheck`, never the team's hub"); it throws rather than warns.
 *   2. `crosscheck login <hubUrl>` with the reader key on STDIN (never argv,
 *      never a shell-history positional), from this worktree's bin.
 *   3. `crosscheck init` in the fixture with `--command-prefix "<bun> <bin>"`,
 *      so the `.claude/settings.json` hooks and the `.mcp.json` server both run
 *      THIS worktree's source — through a neutral link, so the checkout's own
 *      directory name never lands in a file the agent can read (A2.4). The
 *      durable-install rules send the override
 *      through `sh -c` for the MCP entry (config/launcher.ts), which is exactly
 *      what the strict-mcp run then loads.
 *
 * It returns the env the run carries (only CROSSCHECK_HOME is added; HOME is
 * left untouched so claude's own login still works) and the two paths init
 * wrote, which the caller checks and commits.
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { runProcess } from "./exec.ts";
import { crosscheckBinPath, runtimePath } from "./paths.ts";

/**
 * The tripwire mode the run pins (A1.5). The product default `ask` is a
 * one-shot DENY under `-p` with no person at the prompt — not what a developer
 * experiences; the connector itself names `notice` for headless sessions. Same
 * in both arms.
 */
export const RUN_TRIPWIRE_MODE = "notice";

export interface InstallInput {
  /** The throwaway CROSSCHECK_HOME for this run — under `runTempDir`. */
  readonly home: string;
  /** This run's temp root; `home` must resolve under it. */
  readonly runTempDir: string;
  readonly hubUrl: string;
  readonly readerKey: string;
  readonly fixtureRoot: string;
  /**
   * The `--command-prefix` init writes into the hooks and `.mcp.json` — this
   * worktree's bin reached through a neutral link (paths.ts, A2.4).
   */
  readonly commandPrefix: string;
}

export interface InstallResult {
  /** Carried into the claude run; HOME is deliberately NOT changed. */
  readonly env: Readonly<Record<string, string>>;
  readonly settingsPath: string;
  readonly mcpPath: string;
  readonly repoConfigPath: string;
}

/**
 * Throws unless `home` resolves strictly under `runTempDir` and is not the
 * developer's real `~/.crosscheck`. Called before login writes a byte.
 */
export const assertHomeUnderRun = (home: string, runTempDir: string): void => {
  const resolvedHome = resolve(home);
  const resolvedRun = resolve(runTempDir);
  const underRun =
    resolvedHome === resolvedRun ||
    resolvedHome.startsWith(`${resolvedRun}${sep}`);
  if (!underRun) {
    throw new Error(
      `CROSSCHECK_HOME ${resolvedHome} is not under the run temp dir ${resolvedRun} — refusing`,
    );
  }
  const realHome = resolve(homedir(), ".crosscheck");
  if (resolvedHome === realHome) {
    throw new Error(
      `CROSSCHECK_HOME must never be the real ${realHome} — refusing`,
    );
  }
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Throws unless the `.crosscheck.json` init wrote names the run's OWN hub
 * (A1.5 "Wrong hub"). A launcher's `CROSSCHECK_HUB_URL` outranks everything in
 * init, so a leak would wire the fixture's hooks to the team hub; this is the
 * last line that refuses it. Pure, over the raw file contents.
 */
export const assertRepoConfigHub = (raw: string, expectedHubUrl: string): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`.crosscheck.json is unreadable: ${raw.slice(0, 80)}`);
  }
  const hubUrl =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["hubUrl"]
      : undefined;
  if (hubUrl !== expectedHubUrl) {
    throw new Error(
      `.crosscheck.json names hub ${String(hubUrl)}, not the run's own ${expectedHubUrl} — refusing`,
    );
  }
};

export const install = async (input: InstallInput): Promise<InstallResult> => {
  assertHomeUnderRun(input.home, input.runTempDir);
  await mkdir(input.home, { recursive: true });
  const env = {
    CROSSCHECK_HOME: input.home,
    CROSSCHECK_TRIPWIRE: RUN_TRIPWIRE_MODE,
  };

  const login = await runProcess(
    [runtimePath(), crosscheckBinPath(), "login", input.hubUrl],
    { env, stdin: `${input.readerKey}\n` },
  );
  if (login.exitCode !== 0) {
    throw new Error(`crosscheck login failed (${String(login.exitCode)})`);
  }

  const init = await runProcess(
    [
      runtimePath(),
      crosscheckBinPath(),
      "init",
      "--command-prefix",
      input.commandPrefix,
    ],
    { cwd: input.fixtureRoot, env },
  );
  if (init.exitCode !== 0) {
    throw new Error(
      `crosscheck init failed (${String(init.exitCode)}): ${init.stdout.trim()} ${init.stderr.trim()}`,
    );
  }

  const settingsPath = join(input.fixtureRoot, ".claude", "settings.json");
  const mcpPath = join(input.fixtureRoot, ".mcp.json");
  const repoConfigPath = join(input.fixtureRoot, ".crosscheck.json");
  if (!(await exists(settingsPath)) || !(await exists(mcpPath))) {
    throw new Error("crosscheck init did not write settings.json and .mcp.json");
  }
  // A1.5 "Wrong hub": the committed config must name the run's own hub, never a
  // team hub a leaked CROSSCHECK_HUB_URL could have written.
  assertRepoConfigHub(await readFile(repoConfigPath, "utf8"), input.hubUrl);
  return { env, settingsPath, mcpPath, repoConfigPath };
};
