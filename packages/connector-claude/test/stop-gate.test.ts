/**
 * The Tier-1 summarizer's deterministic gate (DESIGN.md §3 Tier 1): every
 * decision that spends the developer's own Claude quota is made HERE, by
 * cheap checks a test can pin — heuristics over the turn's transcript slice,
 * a debounce, and a hard per-session cap. No LLM is anywhere near this file.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SUMMARIZER_DEBOUNCE_TURNS,
  SUMMARIZER_MAX_FIRES_PER_SESSION,
  SUMMARIZER_TAIL_BYTES,
} from "@crosscheck/connector-core/constants.ts";
import {
  hasErrorOutput,
  hasHypothesisLanguage,
  hasTestCommand,
  isDiagnosisMoment,
  summarizerFireAllowed,
  withStopTurn,
  withSummarizerDraft,
  withSummarizerFire,
  withSummarizerNone,
} from "../src/summarizer/gate.ts";
import {
  extractSliceText,
  readSliceRange,
  readTurnSlice,
} from "../src/summarizer/transcript.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

const baseState = (overrides: Partial<SessionState> = {}): SessionState => ({
  hostSessionKey: "s1",
  crosscheckSessionId: "cc_s1",
  workContextId: "wc_cc_s1",
  repoId: "github.com/acme/api",
  repoRoot: "/tmp/repo",
  hubUrl: "http://127.0.0.1:1",
  developerId: "dev_1",
  startedAt: "2026-08-11T09:00:00.000Z",
  lastHeartbeatAt: null,
  seenTargets: [],
  deliveredHintRefs: [],
  deliveredHintHashes: [],
  tripwireAskedFiles: [],
  briefingSolvedRefs: [],
  foreignRepoDrops: 0,
  briefingPending: false,
  stopTurnCount: 0,
  summarizerFireCount: 0,
  summarizerLastFireTurn: null,
  summarizerEstimatedTokens: 0,
  summarizerNoneCount: 0,
  summarizerDraftCount: 0,
  summarizerFailCount: 0,
  summarizerLastFailure: null,
  outsideRootDrops: 0,
  knownWorktreeRoots: [],
  editToolFires: 0,
  targetsCapturedCount: 0,
  lastTargetAt: null,
  lastPostToolUseTool: null,
  lastEditedPath: null,
  lastEditedPathResolvedAgainst: null,
  hintCandidatesSeen: 0,
  ...overrides,
});

describe("diagnosis-moment heuristics", () => {
  test("a test command in a Bash tool_use counts as a test run", () => {
    expect(hasTestCommand("tool_use Bash: bun test packages/api")).toBe(true);
    expect(hasTestCommand("tool_use Bash: pytest tests/test_auth.py")).toBe(true);
    expect(hasTestCommand("tool_use Bash: go test ./...")).toBe(true);
    expect(hasTestCommand("tool_use Bash: npm run test")).toBe(true);
  });

  test("ordinary commands are not test runs", () => {
    expect(hasTestCommand("tool_use Bash: git status")).toBe(false);
    expect(hasTestCommand("we should test this later")).toBe(false);
    expect(hasTestCommand("tool_use Bash: ls contest/")).toBe(false);
  });

  test("error output markers are recognised", () => {
    expect(hasErrorOutput("TypeError: undefined is not a function")).toBe(true);
    expect(hasErrorOutput("1 tests failed")).toBe(true);
    expect(hasErrorOutput("Traceback (most recent call last):")).toBe(true);
    expect(hasErrorOutput("panic: runtime error")).toBe(true);
  });

  test("clean output carries no error marker", () => {
    expect(hasErrorOutput("all green, nothing to report")).toBe(false);
    expect(hasErrorOutput("compiled successfully")).toBe(false);
  });

  test("hypothesis language is recognised in assistant prose", () => {
    expect(hasHypothesisLanguage("The root cause is the stale cursor")).toBe(true);
    expect(hasHypothesisLanguage("I suspect the lock is never released")).toBe(true);
    expect(hasHypothesisLanguage("this fails because the config is null")).toBe(true);
    expect(hasHypothesisLanguage("Turns out the retry loop swallows it")).toBe(true);
  });

  test("plain narration is not hypothesis language", () => {
    expect(hasHypothesisLanguage("I edited the file and ran the build")).toBe(false);
    expect(hasHypothesisLanguage("Here is the updated component")).toBe(false);
  });

  test("a diagnosis moment needs an evidence signal AND hypothesis language", () => {
    const evidenceOnly = "tool_use Bash: bun test x\nTypeError: boom";
    const hypothesisOnly = "The root cause is the stale cursor";
    const both = `${evidenceOnly}\nassistant: the root cause is the stale cursor`;
    expect(isDiagnosisMoment(evidenceOnly)).toBe(false);
    expect(isDiagnosisMoment(hypothesisOnly)).toBe(false);
    expect(isDiagnosisMoment(both)).toBe(true);
  });
});

describe("debounce and hard cap (DESIGN.md §3: >=2 turns apart, 6/session)", () => {
  test("a first fire is allowed", () => {
    expect(summarizerFireAllowed(baseState({ stopTurnCount: 1 }))).toBe(true);
  });

  test("the very next turn after a fire is debounced", () => {
    const state = baseState({
      stopTurnCount: 4,
      summarizerFireCount: 1,
      summarizerLastFireTurn: 3,
    });
    expect(summarizerFireAllowed(state)).toBe(false);
  });

  test("two turns after a fire is allowed again", () => {
    const state = baseState({
      stopTurnCount: 5,
      summarizerFireCount: 1,
      summarizerLastFireTurn: 5 - SUMMARIZER_DEBOUNCE_TURNS,
    });
    expect(summarizerFireAllowed(state)).toBe(true);
  });

  test("the hard cap refuses fire number cap+1 exactly", () => {
    // The arithmetic detector for scripts/mutation-check.ts: raising the
    // constant must flip this expectation on every machine, no stopwatch.
    const atCap = baseState({
      stopTurnCount: 40,
      summarizerFireCount: SUMMARIZER_MAX_FIRES_PER_SESSION,
      summarizerLastFireTurn: 20,
    });
    const oneBelow = baseState({
      stopTurnCount: 40,
      summarizerFireCount: SUMMARIZER_MAX_FIRES_PER_SESSION - 1,
      summarizerLastFireTurn: 20,
    });
    expect(summarizerFireAllowed(atCap)).toBe(false);
    expect(summarizerFireAllowed(oneBelow)).toBe(true);
    // The named constant IS the spec'd budget: 6/session.
    expect(SUMMARIZER_MAX_FIRES_PER_SESSION).toBe(6);
  });

  test("withStopTurn increments and never mutates", () => {
    const before = baseState();
    const after = withStopTurn(before);
    expect(after.stopTurnCount).toBe(1);
    expect(before.stopTurnCount).toBe(0);
  });

  test("withSummarizerFire records fire turn, count and token estimate", () => {
    const before = baseState({ stopTurnCount: 7, summarizerEstimatedTokens: 100 });
    const after = withSummarizerFire(before, 250);
    expect(after.summarizerFireCount).toBe(1);
    expect(after.summarizerLastFireTurn).toBe(7);
    expect(after.summarizerEstimatedTokens).toBe(350);
    expect(before.summarizerFireCount).toBe(0);
  });
});

describe("summarizer outcome telemetry (trial signal-to-noise instrument)", () => {
  test("withSummarizerNone counts a NONE answer and never mutates", () => {
    const before = baseState({ summarizerNoneCount: 1 });
    const after = withSummarizerNone(before);
    expect(after.summarizerNoneCount).toBe(2);
    expect(after.summarizerDraftCount).toBe(0);
    expect(before.summarizerNoneCount).toBe(1);
  });

  test("withSummarizerDraft counts a spooled draft and never mutates", () => {
    const before = baseState({ summarizerDraftCount: 2 });
    const after = withSummarizerDraft(before);
    expect(after.summarizerDraftCount).toBe(3);
    expect(after.summarizerNoneCount).toBe(0);
    expect(before.summarizerDraftCount).toBe(2);
  });
});

/** One transcript line in Claude Code's JSONL shape. */
const line = (entry: unknown): string => `${JSON.stringify(entry)}\n`;

const userText = (text: string): string =>
  line({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });

const toolResult = (content: string): string =>
  line({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", content }],
    },
  });

const assistantText = (text: string): string =>
  line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

const assistantToolUse = (name: string, input: unknown): string =>
  line({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name, input }],
    },
  });

const writeTranscript = async (content: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-transcript-"));
  const path = join(dir, "transcript.jsonl");
  await writeFile(path, content, "utf8");
  return path;
};

describe("turn slice from the transcript tail", () => {
  test("the slice starts at the LAST real user prompt, not a tool result", async () => {
    const path = await writeTranscript(
      userText("earlier turn question") +
        assistantText("earlier turn answer with the root cause of that bug") +
        userText("why does bun test fail here") +
        assistantToolUse("Bash", { command: "bun test packages/api" }) +
        toolResult("1 fail — TypeError: cursor is undefined") +
        assistantText("The root cause is the stale cursor id"),
    );

    const slice = await readTurnSlice(path);
    expect(slice).not.toBeNull();
    const text = extractSliceText(slice?.raw ?? "");
    // Current turn is in
    expect(text).toContain("why does bun test fail here");
    expect(text).toContain("stale cursor id");
    expect(text).toContain("bun test packages/api");
    // The previous turn is OUT — its diagnosis must not be re-captured
    expect(text).not.toContain("earlier turn answer");
  });

  test("a missing transcript is null, never a throw", async () => {
    expect(await readTurnSlice("/nonexistent/transcript.jsonl")).toBeNull();
  });

  test("unparseable lines are skipped, not fatal", async () => {
    const path = await writeTranscript(
      userText("the question") + "{not json\n" + assistantText("the answer"),
    );
    const slice = await readTurnSlice(path);
    const text = extractSliceText(slice?.raw ?? "");
    expect(text).toContain("the question");
    expect(text).toContain("the answer");
  });

  test("slice bounds are absolute byte offsets a worker can re-read", async () => {
    const before = userText("old turn") + assistantText("old answer");
    const current = userText("new question") + assistantText("new answer");
    const path = await writeTranscript(before + current);

    const slice = await readTurnSlice(path);
    expect(slice?.start).toBe(Buffer.byteLength(before));
    expect(slice?.end).toBe(Buffer.byteLength(before + current));
  });

  test("a tail boundary splitting a multibyte char cannot shift the offsets", async () => {
    // Arrange: a transcript past the tail window whose window boundary lands
    // MID-EMOJI. Offsets computed from the DECODED tail drift here — U+FFFD
    // replacement bytes are not the original bytes — and the worker would
    // re-read different bytes than the gate saw.
    const emoji = String.fromCodePoint(0x1f642); // 4 bytes in UTF-8
    const makeContent = (fill: string): string =>
      assistantText(`pad-${emoji.repeat(33_000)}`) +
      userText(`why does bun test fail ${fill}`) +
      assistantText("the stale cursor id is the root cause");
    let content = makeContent("");
    const runStart = Buffer.from(content).indexOf(Buffer.from(emoji));
    // Nudge the tail boundary off 4-byte alignment with filler in the LAST
    // turn, so the window provably starts inside one emoji's bytes.
    for (let filler = 1; filler <= 3; filler += 1) {
      const boundary = Buffer.byteLength(content) - SUMMARIZER_TAIL_BYTES;
      if ((boundary - runStart) % 4 !== 0) {
        break;
      }
      content = makeContent("z".repeat(filler));
    }
    const size = Buffer.byteLength(content);
    const boundary = size - SUMMARIZER_TAIL_BYTES;
    expect(boundary).toBeGreaterThan(runStart);
    expect((boundary - runStart) % 4).not.toBe(0);
    const path = await writeTranscript(content);

    // Act
    const slice = await readTurnSlice(path);

    // Assert: the end is exactly EOF, never past it …
    expect(slice).not.toBeNull();
    expect(slice?.end).toBe(size);
    // … the worker's re-read of [start, end) sees the SAME text the gate
    // gated on …
    const reread = await readSliceRange(path, slice?.start ?? 0, slice?.end ?? 0);
    expect(reread).toBe(slice?.raw ?? "");
    // … and the slice begins at a real line start: the user prompt parses.
    const firstLine = (slice?.raw ?? "").split("\n")[0] ?? "";
    expect((JSON.parse(firstLine) as { type?: string }).type).toBe("user");
  });
});
