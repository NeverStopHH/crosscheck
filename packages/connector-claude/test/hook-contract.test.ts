/**
 * The hook contract, from both sides.
 *
 * Our whole capture layer rests on a contract we do not own: which events fire,
 * which fields arrive on stdin, how `additionalContext` comes back. And the
 * hooks are deliberately fail-open — every error exits 0 in silence so a
 * developer's session is never broken. Correct, and it means a contract change
 * is INVISIBLE: hooks keep exiting 0, briefings just stop arriving.
 *
 * Two halves, and they answer different questions:
 *
 *   WE BROKE IT — the recorded payloads in fixtures/hook-contract/payloads.ts
 *   are driven through the real parsers and the real hooks. Runs on every pull
 *   request. Catches a tightened schema, a renamed output key, a dropped field.
 *
 *   THEY CHANGED IT — the extractor and differ behind the weekly watcher
 *   (scripts/hook-contract-watch.ts), exercised offline against committed doc
 *   excerpts. Runs here so that the watcher itself is known to work, including
 *   the part that matters most: telling "the docs changed" apart from "I could
 *   not read the docs at all".
 *
 * Nothing here needs Claude Code installed, an API key, or the public network.
 * It is NOT hermetic beyond that, and the difference matters when this file goes
 * red: `liveHook` binds a mock hub on a loopback port, and every hook below does
 * a real HTTP round trip to it that has to finish inside the hook's own budget —
 * CROSSCHECK_TIMEOUT_MS times the per-hook ratio, so 1000 ms for SessionStart at
 * the 400 ms default (constants.ts). A runner loaded enough to miss that budget
 * makes the hook fail open and print nothing, which is a fact about the box and
 * not about the contract. `parsedHookOutput` below is what keeps the two apart.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  extractFailureText,
  extractFilePaths,
  isFailureResponse,
  parseHookPayload,
  runHook,
  runStatusline,
} from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  EXIT_DRIFT,
  EXIT_IN_SYNC,
  EXIT_UNREADABLE,
  HOOK_PROBES,
  diffContract,
  extractContract,
  main as runContractWatch,
} from "../scripts/hook-contract-watch.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import { TEAMMATE_NAME, startSlowHub } from "./fixtures/slow-hub.ts";
import type { MockHub } from "./fixtures/slow-hub.ts";
import {
  POST_TOOL_USE_INPUT,
  POST_TOOL_USE_INPUT_FAILURE,
  PRE_TOOL_USE_OUTPUT,
  SESSION_END_INPUT,
  SESSION_START_INPUT,
  SESSION_START_INPUT_WITH_TITLE,
  SESSION_START_OUTPUT,
  STATUSLINE_INPUT,
} from "./fixtures/hook-contract/payloads.ts";

const FIXTURE_DIR = resolve(import.meta.dir, "fixtures", "hook-contract");
const SNAPSHOT = join(FIXTURE_DIR, "docs-snapshot.json");
const HOOKS_EXCERPT = join(FIXTURE_DIR, "docs-excerpt-hooks.md");
const STATUSLINE_EXCERPT = join(FIXTURE_DIR, "docs-excerpt-statusline.md");

const OFFLINE_SOURCES = [
  "--hooks-file",
  HOOKS_EXCERPT,
  "--statusline-file",
  STATUSLINE_EXCERPT,
];

const paths: string[] = [];
const hubs: MockHub[] = [];

afterEach(async () => {
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const asJson = (payload: unknown): string => JSON.stringify(payload);

describe("recorded hook payloads are still accepted by our parsers", () => {
  test.each([
    ["SessionStart", SESSION_START_INPUT],
    ["SessionStart with a session title", SESSION_START_INPUT_WITH_TITLE],
    ["PostToolUse", POST_TOOL_USE_INPUT],
    ["PostToolUse for a failed Bash call", POST_TOOL_USE_INPUT_FAILURE],
    ["SessionEnd", SESSION_END_INPUT],
    ["statusline", STATUSLINE_INPUT],
  ])("%s", (_label, payload) => {
    // Act
    const parsed = parseHookPayload(asJson(payload));

    // Assert: the two fields every path requires, and no rejection over the
    // fields we ignore — tolerating unknown keys is part of the contract.
    expect(parsed).not.toBeNull();
    expect(parsed?.session_id).toBe("abc123");
    expect(parsed?.cwd).toBe("/home/dev/acme/api");
  });

  test("carries the event-specific fields each hook reads", () => {
    // Act
    const start = parseHookPayload(asJson(SESSION_START_INPUT_WITH_TITLE));
    const post = parseHookPayload(asJson(POST_TOOL_USE_INPUT));
    const end = parseHookPayload(asJson(SESSION_END_INPUT));

    // Assert
    expect(start?.source).toBe("resume");
    expect(start?.session_title).toBe("Rate limiter drops burst traffic");
    expect(post?.tool_name).toBe("Write");
    expect(extractFilePaths(post?.tool_input)).toEqual([
      "/home/dev/acme/api/src/rate-limit.ts",
    ]);
    expect(end?.reason).toBe("other");
  });

  test("reads success and failure out of a recorded tool_response", () => {
    // Act
    const succeeded = parseHookPayload(asJson(POST_TOOL_USE_INPUT));
    const failed = parseHookPayload(asJson(POST_TOOL_USE_INPUT_FAILURE));

    // Assert: a fingerprint is only ever taken from an explicit failure
    expect(isFailureResponse(succeeded?.tool_response)).toBe(false);
    expect(isFailureResponse(failed?.tool_response)).toBe(true);
    expect(extractFailureText(failed?.tool_response)).toContain("expected 200");
  });
});

interface Live {
  readonly repo: string;
  readonly env: Env;
}

/** A repo, a home and a hub that answers instantly: only shapes are on trial. */
const liveHook = async (label: string): Promise<Live> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startSlowHub({ ingest: 0, end: 0, other: 0 });
  hubs.push(hub);
  return {
    repo,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_DISABLED: "0",
    },
  };
};

const withCwd = (
  payload: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> => ({ ...payload, cwd });

/**
 * `runHook` returns "" for every failure — that is the documented fail-open
 * contract this file's header describes — and it also returns "" when the
 * total-budget race resolves before the handler does (hooks/runner.ts), which a
 * loaded runner can cause on its own. `JSON.parse("")` throws
 * `SyntaxError: JSON Parse error: Unexpected EOF`, and that message inside a
 * test named "our hook output still matches the documented output contract"
 * reads as "Claude Code changed its output format" when the real cause is a busy
 * box. `briefingOf` in hook-time-budget.test.ts wraps the identical parse in a
 * try/catch for the identical reason; this mirrors it, and the assertions below
 * then name the missing briefing rather than a syntax error.
 *
 * That sibling is named rather than cited by line number. The previous version
 * of this sentence pointed at "hook-time-budget.test.ts:312-321", which by then
 * held `runHookBinary`; a line range is a pointer that rots silently every time
 * anybody edits the file above it, and this one had. A name does not, and it can
 * be checked:
 *
 * VERIFY: grep -A6 'const briefingOf' packages/connector-claude/test/hook-time-budget.test.ts | grep -c 'catch {'
 * PRINTS: 1
 *
 * TRIAGE, MEASURED. An empty stdout here is a starved runner, not a contract
 * change. Reproduce it with 16 busy-spin processes against a 2-CPU quota:
 *
 *   docker run --rm -v "$PWD":/w -w /w --cpus=2 oven/bun:1 sh -c '
 *     apt-get update -qq >/dev/null 2>&1
 *     apt-get install -y -qq git >/dev/null 2>&1
 *     bun install --frozen-lockfile >/dev/null 2>&1
 *     for i in $(seq 1 16); do (while :; do :; done) & done
 *     for round in 1 2 3 4 5 6 7 8; do
 *       bun test packages/connector-claude/test/hook-contract.test.ts
 *     done'
 *
 * which failed this test — "SessionStart returns hookSpecificOutput and nothing
 * else", the same one every time — in 5 of the 8 rounds, at 1806, 2410, 2098,
 * 2186 and 1815 ms against the 1000 ms SessionStart budget, with NO bun timeout
 * line anywhere in the log. Measured this round in oven/bun:1 on linux/arm64;
 * the RATE is a property of the host and yours will differ, so re-measure rather
 * than trusting the 5. What is stable is the SIGNATURE: empty stdout, one test,
 * over budget, no timeout line.
 *
 * A genuine contract change looks different: stdout is non-empty and one of the
 * KEY assertions below is what fails.
 */
const parsedHookOutput = (
  stdout: string,
): typeof SESSION_START_OUTPUT | null => {
  try {
    return JSON.parse(stdout) as typeof SESSION_START_OUTPUT;
  } catch {
    return null;
  }
};

/** Names the fail-open case in the assertion message rather than in a stack. */
const contractWhere = (stdout: string): string =>
  stdout === ""
    ? "the hook printed NOTHING: it failed open, which on a loaded runner means " +
      "a missed budget rather than a changed contract — see the triage recipe above"
    : `the hook printed ${JSON.stringify(stdout.slice(0, 200))}`;

describe("our hook output still matches the documented output contract", () => {
  test("SessionStart returns hookSpecificOutput and nothing else", async () => {
    // Arrange
    const live = await liveHook("contract-start");

    // Act
    const stdout = await runHook(
      "session-start",
      asJson(withCwd(SESSION_START_INPUT, live.repo)),
      live.env,
    );

    // Assert: same keys as the recorded output shape, at both levels. Parsed
    // defensively first, so a fail-open "" reports as a missing briefing rather
    // than as a JSON syntax error.
    const parsed = parsedHookOutput(stdout);
    const where = contractWhere(stdout);
    expect(parsed, where).not.toBeNull();
    expect(Object.keys(parsed ?? {}), where).toEqual(
      Object.keys(SESSION_START_OUTPUT),
    );
    expect(Object.keys(parsed?.hookSpecificOutput ?? {}), where).toEqual(
      Object.keys(SESSION_START_OUTPUT.hookSpecificOutput),
    );
    expect(parsed?.hookSpecificOutput.hookEventName, where).toBe("SessionStart");
    expect(parsed?.hookSpecificOutput.additionalContext, where).toContain(
      TEAMMATE_NAME,
    );
  });

  test.each([
    ["post-tool-use", POST_TOOL_USE_INPUT],
    ["session-end", SESSION_END_INPUT],
  ] as const)("%s prints nothing at all", async (hookName, payload) => {
    // Arrange: neither event has decision control we use, and stdout on
    // PostToolUse would reach the reader's context unasked
    const live = await liveHook(`contract-${hookName}`);

    // Act
    const stdout = await runHook(hookName, asJson(withCwd(payload, live.repo)), live.env);

    // Assert
    expect(stdout).toBe("");
  });

  test("the statusline accepts its own recorded input shape", async () => {
    // Arrange
    const live = await liveHook("contract-statusline");

    // Act
    const line = await runStatusline(
      asJson(withCwd(STATUSLINE_INPUT, live.repo)),
      live.env,
    );

    // Assert: one line, and it is the presence line rather than a silent "".
    // Same fail-open caveat as SessionStart above — the statusline also reaches
    // the loopback hub, so an empty line here is the runner, not the contract.
    const where = contractWhere(line);
    expect(line.startsWith("cx "), where).toBe(true);
    expect(line, where).toContain(TEAMMATE_NAME);
  });
});

interface Report {
  readonly lines: string[];
  readonly write: (line: string) => void;
}

const collect = (): Report => {
  const lines: string[] = [];
  return {
    lines,
    write: (line) => {
      lines.push(line);
    },
  };
};

describe("the drift watcher itself", () => {
  test("reports in sync when the docs still say what the snapshot recorded", async () => {
    // Arrange
    const report = collect();

    // Act
    const code = await runContractWatch(
      [...OFFLINE_SOURCES, "--snapshot", SNAPSHOT],
      report.write,
    );

    // Assert
    expect(code).toBe(EXIT_IN_SYNC);
    expect(report.lines.join("\n")).toContain("in sync");
  });

  /**
   * `sectionBody` resolves a section to its FIRST `### ` match, so a SECOND
   * block under the same heading is unreachable and every probe aimed at it
   * silently reads the first one instead. Merging two branches that had each
   * grown their own PreToolUse section produced exactly that: 35 fixture lines,
   * the only `#### PreToolUse input` block among them, that no observation could
   * reach — gutting the whole second block flipped 0 of 29 observations, while
   * gutting the first flipped `PreToolUse.output.additionalContext`. The two are
   * folded into one section now; this is what keeps them that way.
   */
  test("no `###` section is written twice, so no probe reads a dead block", async () => {
    // Arrange
    const hooks = await Bun.file(HOOKS_EXCERPT).text();

    // Act
    const headings = hooks
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("### "));

    // Assert
    expect(headings.length).toBeGreaterThan(0);
    expect([...new Set(headings)]).toEqual(headings);
  });

  /**
   * `extractContract` builds the view with `Object.fromEntries`, which keeps the
   * LAST entry for a repeated key and says nothing about the one it dropped —
   * so two copies of a probe can drift apart in silence, and no pinned count can
   * show it, because every count is taken after the dedupe. Merging two branches
   * that had each grown a PreToolUse block left 23 entries under 21 keys.
   */
  test("every probe key is written once, so no copy can drift unseen", () => {
    // Act
    const keys = HOOK_PROBES.map((probe) => probe.key);

    // Assert
    expect([...new Set(keys)]).toEqual(keys);
  });

  test("fails loudly and names the observation when the snapshot disagrees", async () => {
    // Arrange: a snapshot claiming a field we depend on was never documented
    const dir = await mkdtemp(join(tmpdir(), "cx-contract-"));
    paths.push(dir);
    const altered = join(dir, "snapshot.json");
    const recorded = (await Bun.file(SNAPSHOT).json()) as Record<string, boolean>;
    await writeFile(
      altered,
      JSON.stringify(
        { ...recorded, "SessionStart.output.additionalContext": false },
        null,
        2,
      ),
      "utf8",
    );
    const report = collect();

    // Act
    const code = await runContractWatch(
      [...OFFLINE_SOURCES, "--snapshot", altered],
      report.write,
    );

    // Assert
    expect(code).toBe(EXIT_DRIFT);
    const text = report.lines.join("\n");
    expect(text).toContain("DRIFT");
    expect(text).toContain("SessionStart.output.additionalContext");
  });

  test("reports a source it could not read as its own outcome, not as drift", async () => {
    // Arrange: this is the failure the watcher exists to prevent — going quiet
    // because it cannot see. A fetch that fails must never read as "in sync",
    // and must not be confused with a real contract change either.
    const report = collect();

    // Act
    const code = await runContractWatch(
      [
        "--hooks-file",
        join(FIXTURE_DIR, "does-not-exist.md"),
        "--statusline-file",
        STATUSLINE_EXCERPT,
        "--snapshot",
        SNAPSHOT,
      ],
      report.write,
    );

    // Assert
    expect(code).toBe(EXIT_UNREADABLE);
    expect(code).not.toBe(EXIT_DRIFT);
    const text = report.lines.join("\n");
    expect(text).toContain("SOURCE UNREADABLE");
    expect(text).toContain("was NOT checked");
  });

  test.each([
    [
      "field names in bold rather than in backticks",
      (hooks: string): string => hooks.replace(/`([a-zA-Z_]+)`/g, "**$1**"),
      4,
    ],
    [
      "every heading promoted one level",
      (hooks: string): string =>
        hooks.replace(/^### /gm, "#### ").replace(/^## /gm, "### "),
      // Widened twice before it settled here: M17 read EVENTS from the
      // registered-hook list instead of a hand-kept literal (three events →
      // six), and the #17/#18/#20 round added sections of its own. Every
      // section probe rides on the `### ` heading level, so each addition
      // brought observations a heading promotion can flip. RE-DERIVED by
      // running extractContract over the merged fixture, never adjusted by
      // hand — 16 before M17, 26 after it, 20 on the other side of the merge,
      // and neither of those two is the answer for the union of both.
      27,
    ],
  ] as const)(
    "KNOWN LIMIT: a formatting-only rewrite reports drift (%s)",
    async (_label, rewrite, expectedFlips) => {
      // Arrange: the watcher's header used to claim it "reads no prose and no
      // formatting, so a docs rewrite that keeps the contract cannot cry wolf".
      // The second half is false. Both rewrites below leave every documented
      // field name and every section in place — the CONTRACT is untouched — and
      // the watcher still reports drift, because it matches on the backticks and
      // on the exact `### ` heading level.
      //
      // Pinned rather than fixed. This direction fails SAFE: a false alarm makes
      // somebody read the reference and re-record with --write, where a missed
      // change would make the watcher go quiet instead. The counts live here so
      // the numbers quoted in that header cannot age without this test saying so.
      const hooks = await Bun.file(HOOKS_EXCERPT).text();
      const statusline = await Bun.file(STATUSLINE_EXCERPT).text();

      // Act
      const before = extractContract({ hooks, statusline });
      const after = extractContract({ hooks: rewrite(hooks), statusline });

      // Assert
      const flipped = Object.keys(before).filter(
        (key) => before[key] !== after[key],
      );
      expect(flipped.length).toBe(expectedFlips);
      expect(diffContract(before, after).length).toBe(expectedFlips);
    },
  );

  /**
   * Trial finding M17: the watcher's `EVENTS` list said three where the
   * installer registers six, and its comment claimed to name "the events we
   * register". The list is now read from the same constant both the installer
   * and the doctor read, which kills that drift by construction — and these
   * are the ten observations that appeared the moment it was.
   */
  test("the six registered events and the tripwire contract are all watched", async () => {
    // Arrange
    const hooks = await Bun.file(HOOKS_EXCERPT).text();
    const statusline = await Bun.file(STATUSLINE_EXCERPT).text();

    // Act
    const view = extractContract({ hooks, statusline });

    // Assert: the three events that were invisible
    expect(view["event.PreToolUse"]).toBe(true);
    expect(view["event.UserPromptSubmit"]).toBe(true);
    expect(view["event.Stop"]).toBe(true);
    // The tripwire's decision contract, `ask` included — it is a documented
    // VALUE rather than a field name, and the quote-delimited rule finds it.
    expect(view["PreToolUse.output.permissionDecision"]).toBe(true);
    expect(view["PreToolUse.output.permissionDecisionReason"]).toBe(true);
    expect(view["PreToolUse.output.ask"]).toBe(true);
    // The prompt path and the summarizer gate's two inputs
    expect(view["UserPromptSubmit.input.prompt"]).toBe(true);
    expect(view["UserPromptSubmit.output.additionalContext"]).toBe(true);
    expect(view["Stop.input.transcript_path"]).toBe(true);
    expect(view["Stop.input.stop_hook_active"]).toBe(true);
  });

  test("the tripwire's own OUTPUT shape is pinned, not just its input", async () => {
    // Arrange: only SessionStart's output was pinned before M17, so a rename
    // on the decision-control side would have been caught by nothing.
    const hooks = await Bun.file(HOOKS_EXCERPT).text();
    const decision = PRE_TOOL_USE_OUTPUT.hookSpecificOutput;

    // Act
    const withoutDecision = hooks
      .split("\n")
      .filter((line) => !line.includes("permissionDecision"))
      .join("\n");
    const after = extractContract({
      hooks: withoutDecision,
      statusline: await Bun.file(STATUSLINE_EXCERPT).text(),
    });

    // Assert: the emitted shape is what the docs must keep documenting
    expect(decision.hookEventName).toBe("PreToolUse");
    expect(decision.permissionDecision).toBe("ask");
    expect(typeof decision.permissionDecisionReason).toBe("string");
    // …and removing it from the reference is seen, so the `true` above means
    // something rather than the probe never looking.
    expect(after["PreToolUse.output.permissionDecision"]).toBe(false);
    expect(after["PreToolUse.output.permissionDecisionReason"]).toBe(false);
  });

  test("sees a field that is gone, so a recorded true means something", async () => {
    // Arrange: the same excerpt with one documented field removed. Without
    // this, every observation being `true` could just mean the probe never
    // looks at anything.
    const hooks = await Bun.file(HOOKS_EXCERPT).text();
    const statusline = await Bun.file(STATUSLINE_EXCERPT).text();
    const withoutTitle = hooks
      .split("\n")
      .filter((line) => !line.includes("`session_title`"))
      .join("\n");

    // Act
    const before = extractContract({ hooks, statusline });
    const after = extractContract({ hooks: withoutTitle, statusline });

    // Assert
    expect(before["SessionStart.input.session_title"]).toBe(true);
    expect(after["SessionStart.input.session_title"]).toBe(false);
    expect(after["SessionStart.input.source"]).toBe(true);
  });
});