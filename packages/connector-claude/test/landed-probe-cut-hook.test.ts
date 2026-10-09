/**
 * A LANDED-CHANGE CHECK CUT SHORT LEAVES AN HONEST TRACE (2026-10-08),
 * through the real hooks.
 *
 * The flake hunt's finding, the empty briefing's shape: under load the
 * PreToolUse probe's deadline (then 300 ms) ended it before any landing
 * branch answered, the hook stopped nothing and recorded nothing, and the
 * reader edited a teammate's landed change with nothing saying a check had
 * not finished. Now:
 *
 *   - the probe has ONE REQUEST, the window the live tripwire's hub call
 *     beside it already holds (LANDED_PROBE_BUDGET_MS), so git that answers
 *     inside it is never cut by an earlier deadline of its own;
 *   - a cut anyway is booked — the session's counter and the local ledger —
 *     by the hook when its probe came back cut, by the runner when the budget
 *     abandoned the hook first (measured at a load average near 90, where
 *     the steps before the probe spent most of the race), once per edit;
 *     and the edit itself prints nothing for it;
 *   - the session's next prompt says how many, once.
 *
 * Deterministic: the hook runs in a child whose `git` was chosen by the test
 * (fixtures/run-hook-in-child.ts says why a child): one that never answers
 * the probe's walks inside the hook's budget, or one that answers each of
 * them only after a fixed delay. Machine load decides nothing here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { runHookWith } from "../src/hooks/runner.ts";
import { landedProbeCutsLine } from "@crosscheck/connector-core/briefing/omission.ts";
import {
  SessionStateSchema,
  readSessionState,
  updateSessionState,
  withLandedProbeCut,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { readLandedProbeCuts } from "@crosscheck/connector-core/state/landed-probe-cuts.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import {
  landWithMergeCommit,
  makeLandingRepos,
  readerFetches,
} from "../../connector-core/test/fixtures/landing-repos.ts";
import type { LandingRepos } from "../../connector-core/test/fixtures/landing-repos.ts";
import { startHintHub } from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const SESSION_ID = "probe-cut-uuid";
const FILE = "src/lines.ts";
const DAY_MS = 86_400_000;
const RUN_HOOK_IN_CHILD = join(import.meta.dir, "fixtures", "run-hook-in-child.ts");
/** The default per-request timeout: an abandoned PreToolUse's race is twice this. */
const CUT_TIMEOUT_MS = "400";
/** Longer than any budget in this file: a walk held this long never answers inside the hook. */
const HELD_GIT_SECONDS = 3;
/**
 * The handler's own cases: a timeout long enough that the HOOK's budget
 * (twice it) is never what decides them, even on a loaded machine — so a
 * held walk is cut by the probe and booked by the handler, never by the
 * runner — and, in the found case, a delay per walk that three sequential
 * walks of the missing half add up past the OLD 300 ms deadline, while each
 * one still answers well inside LANDED_GIT_TIMEOUT_MS (250 ms).
 */
const ROOMY_TIMEOUT_MS = "1500";
const DELAYED_GIT_SECONDS = 0.12;
/** A prompt with no meaning to hint on and no intent to derive: the cut line alone answers it. */
const BARE_PROMPT = "ok";

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

interface Fixture {
  readonly repos: LandingRepos;
  readonly home: string;
  readonly env: Env;
  readonly key: string;
}

const fixture = async (label: string, timeoutMs: string): Promise<Fixture> => {
  const repos = await makeLandingRepos(label);
  const home = await makeHome(label);
  paths.push(repos.base, home);
  const hub = startHintHub();
  hub.setCandidates([]);
  hubs.push(hub);
  const identity = await resolveRepoIdentity(repos.reader);
  if (identity === null) {
    throw new Error("the reader clone has no repo identity");
  }
  await writeSessionState(
    home,
    SessionStateSchema.parse({
      hostSessionKey: SESSION_ID,
      crosscheckSessionId: `cc_${SESSION_ID}`,
      workContextId: `wc_cc_${SESSION_ID}`,
      repoId: identity.repoId,
      repoRoot: repos.reader,
      hubUrl: hub.url,
      developerId: "dev_nick",
      startedAt: new Date().toISOString(),
    }),
  );
  // Mike's change, merged into staging months ago; Nick's branch never got it.
  await landWithMergeCommit(repos, {
    file: FILE,
    content: "export const offset = 2;\n",
    subject: "Fix line offset",
    landing: "staging",
    writtenAt: new Date(Date.now() - 91 * DAY_MS).toISOString(),
    landedAt: new Date(Date.now() - 90 * DAY_MS).toISOString(),
  });
  await readerFetches(repos);
  return {
    repos,
    home,
    key: repoKey(hub.url, identity.repoId),
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: timeoutMs,
      TZ: "Europe/Berlin",
      CROSSCHECK_LANDING_FETCH: "off",
    },
  };
};

const editPayload = (repo: string, toolUseId: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_use_id: toolUseId,
    tool_input: { file_path: `${repo}/${FILE}` },
  });

const promptPayload = (repo: string): string =>
  JSON.stringify({ session_id: SESSION_ID, cwd: repo, hook_event_name: "UserPromptSubmit", prompt: BARE_PROMPT });

interface HookOutput {
  readonly hookSpecificOutput?: {
    readonly permissionDecision?: string;
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
  };
}

const outputOf = (stdout: string): HookOutput["hookSpecificOutput"] =>
  stdout.length === 0 ? undefined : (JSON.parse(stdout) as HookOutput).hookSpecificOutput;

/**
 * A `git` that, for the probe's walks (`log`, `merge-base`), either never
 * answers inside the hook (`held`) or answers after a fixed delay
 * (`delayed`); every other call — repo identity, refs, trees — is the real
 * git, at once.
 */
const gitWrapper = async (shape: "held" | "delayed"): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-probe-cut-git-"));
  paths.push(dir);
  const realGit = Bun.which("git");
  if (realGit === null) {
    throw new Error("git is not on PATH");
  }
  const walk =
    shape === "held"
      ? `exec sleep ${String(HELD_GIT_SECONDS)}`
      : `sleep ${String(DELAYED_GIT_SECONDS)}; exec "${realGit}" "$@"`;
  // The subcommand sits past crosscheck's pinned `-c` options (git.ts
  // pinnedGitArgv), so it is found the way git finds it, never as `$1`.
  const findSubcommand =
    'sub=""; skip=0\nfor a in "$@"; do\n  if [ "$skip" = 1 ]; then skip=0; continue; fi\n' +
    '  case "$a" in -c|-C) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac\ndone\n';
  await writeFile(
    join(dir, "git"),
    `#!/bin/sh\n${findSubcommand}case "$sub" in\n  log|merge-base) ${walk} ;;\nesac\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 },
  );
  return dir;
};

/** The REAL pre-edit hook, in a child whose `git` is `gitDir`'s. */
const editInChild = async (gitDir: string, stdin: string, env: Env): Promise<string> => {
  const child = Bun.spawn({
    cmd: [process.execPath, RUN_HOOK_IN_CHILD, "pre-tool-use", stdin, JSON.stringify(env), "real"],
    env: { ...process.env, PATH: `${gitDir}:${process.env["PATH"] ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) {
    throw new Error(`the hook child failed: ${await new Response(child.stderr).text()}`);
  }
  return stdout;
};

describe("a landed-change check the hook could not finish", () => {
  test("is booked on every edit, printed on none, and told once at the next prompt", async () => {
    // Arrange — the probe's walks never answer inside the hook
    const { repos, home, env, key } = await fixture("cut", ROOMY_TIMEOUT_MS);
    const held = await gitWrapper("held");

    // Act — two edits of the same file, then two prompts
    const firstEdit = await editInChild(held, editPayload(repos.reader, "toolu_cut_1"), env);
    const secondEdit = await editInChild(held, editPayload(repos.reader, "toolu_cut_2"), env);
    const firstPrompt = await runHook("user-prompt-submit", promptPayload(repos.reader), env);
    const secondPrompt = await runHook("user-prompt-submit", promptPayload(repos.reader), env);

    // Assert — no stop and no line on either edit: a cut is never per-edit noise
    expect(firstEdit).toBe("");
    expect(secondEdit).toBe("");
    // Booked twice, in the session and in the ledger doctor and status count
    const cuts = await readLandedProbeCuts(home, key, new Date());
    expect(cuts.total).toBe(2);
    // Told once, as one line, at the next moment a person reads
    expect(outputOf(firstPrompt)?.additionalContext).toBe(landedProbeCutsLine(2));
    expect(secondPrompt).toBe("");
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.landedProbeCuts).toBe(2);
    expect(state?.landedProbeCutsTold).toBe(true);
    // The file was never stopped for its landed change, so the next edit asks again
    expect(state?.landedAskedFiles).not.toContain(FILE);
  });

  test("git that answers inside one request is not cut: the stop goes out", async () => {
    // Arrange — each walk answers after a fixed delay; three of them in a row
    // outlast the old 300 ms deadline, never one request
    const { repos, home, env, key } = await fixture("found", ROOMY_TIMEOUT_MS);
    const delayed = await gitWrapper("delayed");

    // Act
    const stdout = await editInChild(delayed, editPayload(repos.reader, "toolu_found"), env);

    // Assert
    const output = outputOf(stdout);
    expect(output?.permissionDecision).toBe("ask");
    expect(output?.permissionDecisionReason).toContain("«Fix line offset» by Mike, on staging");
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.landedAskedFiles).toContain(FILE);
    expect((await readLandedProbeCuts(home, key, new Date())).byReason.deadline).toBe(0);
  });
});

describe("a pre-edit hook the budget abandoned", () => {
  const neverSettles = (): Promise<string> => new Promise<string>(() => {});

  test("books its edit's check as cut, which the next prompt tells", async () => {
    // Arrange — the handler never answers: the race is the only way out
    const { repos, home, env, key } = await fixture("abandoned", CUT_TIMEOUT_MS);

    // Act
    const edit = await runHookWith("pre-tool-use", neverSettles, editPayload(repos.reader, "toolu_abandoned"), env);
    const prompt = await runHook("user-prompt-submit", promptPayload(repos.reader), env);

    // Assert
    expect(edit).toBe("");
    const cuts = await readLandedProbeCuts(home, key, new Date());
    expect(cuts.byReason.budget).toBe(1);
    expect(cuts.total).toBe(1);
    expect(outputOf(prompt)?.additionalContext).toBe(landedProbeCutsLine(1));
  });

  test("a tool that edits nothing had no check to lose", async () => {
    // Arrange
    const { repos, home, env, key } = await fixture("abandoned-bash", CUT_TIMEOUT_MS);
    const bash = JSON.stringify({
      session_id: SESSION_ID,
      cwd: repos.reader,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_bash",
      tool_input: { command: "ls" },
    });

    // Act
    await runHookWith("pre-tool-use", neverSettles, bash, env);

    // Assert
    expect((await readLandedProbeCuts(home, key, new Date())).total).toBe(0);
    expect((await readSessionState(home, SESSION_ID))?.landedProbeCuts ?? 0).toBe(0);
  });
});

describe("the once-per-session line", () => {
  test("two racing prompts tell it once", async () => {
    // Arrange — three cuts already booked
    const { repos, home, env } = await fixture("race", CUT_TIMEOUT_MS);
    for (const _ of [1, 2, 3]) {
      await updateSessionState(home, SESSION_ID, withLandedProbeCut);
    }

    // Act
    const answers = await Promise.all([
      runHook("user-prompt-submit", promptPayload(repos.reader), env),
      runHook("user-prompt-submit", promptPayload(repos.reader), env),
    ]);

    // Assert
    const told = answers.filter((stdout) => outputOf(stdout)?.additionalContext === landedProbeCutsLine(3));
    expect(told).toHaveLength(1);
    expect(answers.filter((stdout) => stdout === "")).toHaveLength(1);
  });

  test("a run no person reads is never told, so the line waits and doctor still counts", async () => {
    // Arrange
    const { repos, home, env } = await fixture("headless", CUT_TIMEOUT_MS);
    await updateSessionState(home, SESSION_ID, withLandedProbeCut);

    // Act
    const stdout = await runHook("user-prompt-submit", promptPayload(repos.reader), {
      ...env,
      CROSSCHECK_TRIPWIRE: "notice",
    });

    // Assert
    expect(stdout).toBe("");
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.landedProbeCuts).toBe(1);
    expect(state?.landedProbeCutsTold).not.toBe(true);
  });
});
