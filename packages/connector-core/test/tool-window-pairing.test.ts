/**
 * THE PAIRING RULE ITSELF, at the allocator rather than through the hooks.
 *
 * Two cases cannot be driven from PostToolUse and must still be pinned. The
 * first is a KEY COLLISION: two tool calls with the same `tool_name` and the
 * same `tool_input` digest to one key, and because they name the same file the
 * second one's target is deduplicated away before a bracket could be read off
 * the spool. The second is the CAP: the list is bounded, so an eviction has to
 * be observable and counted rather than inferred from a missing bracket.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";

import { sessionStatePath } from "../src/config/paths.ts";

import { MAX_TOOL_WINDOWS } from "../src/constants.ts";
import {
  allocateSeq,
  allocateToolSeq,
  openToolWindow,
  readSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import type { SeqRange, SessionStateInput } from "../src/state/session-state.ts";
import { toolWindowKey } from "../src/state/tool-window-key.ts";
import { compareEvents, seqKindFor } from "@crosscheck/server";
import type { OrderedEvent, SessionCausalOrder } from "@crosscheck/server";
import { makeHome } from "./helpers.ts";

const SESSION_ID = "tool-window-uuid";
const HUB = "http://127.0.0.1:1";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const stateFor = (): SessionStateInput => ({
  hostSessionKey: SESSION_ID,
  crosscheckSessionId: `cc_${SESSION_ID}`,
  workContextId: `wc_cc_${SESSION_ID}`,
  repoId: "github.com/acme/api",
  repoRoot: "/tmp/acme-api",
  hubUrl: HUB,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
  seqEpoch: EPOCH,
  eventSeq: 0,
});

const fixture = async (label: string): Promise<string> => {
  const home = await makeHome(label);
  paths.push(home);
  await writeSessionState(home, stateFor());
  return home;
};

const KEY = toolWindowKey("Edit", { file_path: "/tmp/acme-api/src/a.ts" });

describe("a window is found by its own tool's key", () => {
  test("two identical parallel calls both bracket from the OLDER floor", async () => {
    // Arrange: T1 opens, a real position lands, T2 opens under the SAME key.
    // Handing the second closer the YOUNGER floor puts the racing position
    // BELOW its bracket, and the hub then reads an explanation written while
    // both tools ran as preceding an edit that may have come first. Every
    // closer in a colliding group therefore gets the group's oldest floor.
    const home = await fixture("window-collide");
    const first = await openToolWindow(home, SESSION_ID, KEY);
    const raced = await allocateSeq(home, SESSION_ID, 1);
    const second = await openToolWindow(home, SESSION_ID, KEY);

    // Act
    const closedFirst = await allocateToolSeq(home, SESSION_ID, 1, KEY);
    const closedSecond = await allocateToolSeq(home, SESSION_ID, 1, KEY);

    // Assert
    expect(first).toBe(1);
    expect(raced?.from).toBe(2);
    expect(second).toBe(3);
    expect(closedFirst?.after).toBe(first!);
    expect(closedSecond?.after).toBe(first!);
    expect((await readSessionState(home, SESSION_ID))?.toolWindows).toEqual([]);
  });

  test("a key nothing opened takes no bracket and removes no window", async () => {
    // Arrange: Bash, a hook installed mid-tool, an evicted entry. The window
    // that IS open belongs to someone else and must survive.
    const home = await fixture("window-foreign-key");
    await openToolWindow(home, SESSION_ID, KEY);
    const other = toolWindowKey("Write", { file_path: "/tmp/acme-api/src/b.ts" });

    // Act
    const range = await allocateToolSeq(home, SESSION_ID, 1, other);

    // Assert
    expect(range?.after).toBeUndefined();
    expect((await readSessionState(home, SESSION_ID))?.toolWindows).toHaveLength(1);
  });

  test("the cap evicts the OLDEST window and counts the eviction", async () => {
    // Arrange: a session whose PreToolUse hooks outnumber their PostToolUse
    // ones — every failed edit leaks one entry — must cost bounded memory.
    const home = await fixture("window-cap");
    const keys = Array.from({ length: MAX_TOOL_WINDOWS + 1 }, (_, index) =>
      toolWindowKey("Edit", { file_path: `/tmp/acme-api/src/${String(index)}.ts` }),
    );

    // Act
    for (const key of keys) {
      await openToolWindow(home, SESSION_ID, key);
    }

    // Assert: the oldest is gone, its close takes no bracket, and the count
    // says so rather than leaving a missing bracket to be guessed at.
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.toolWindows).toHaveLength(MAX_TOOL_WINDOWS);
    expect(state?.toolWindowEvictions).toBe(1);
    const evicted = await allocateToolSeq(home, SESSION_ID, 1, keys[0]!);
    expect(evicted?.after).toBeUndefined();
  });

  test("a state file from before the list gives its in-flight tools no bracket", async () => {
    // Arrange: the previous version's two fields, written by a connector that
    // is now gone. There is no list to match against, so the honest answer is
    // no bracket — never the floor those fields happen to carry.
    const home = await fixture("window-legacy");
    await writeSessionState(home, {
      ...stateFor(),
      eventSeq: 4,
      toolWindowFloor: 2,
      toolWindowOpen: 1,
    } as SessionStateInput);

    // Act
    const range = await allocateToolSeq(home, SESSION_ID, 1, KEY);

    // Assert
    expect(range?.after).toBeUndefined();
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.toolWindows).toEqual([]);
    // ...and the retired keys do not survive the write-back, so nothing on
    // disk looks like a window nobody reads.
    const raw = await readFile(sessionStatePath(home, SESSION_ID), "utf8");
    expect(raw).not.toContain("toolWindowFloor");
    expect(raw).not.toContain("toolWindowOpen");
  });
});

/**
 * THE AMBIGUITY MAY ONLY COST CERTAINTY — the fifth binding principle's
 * operational form (docs/1.0/README.md): "Ambiguous or unmatched closure can
 * only reduce certainty. It can never increase it."
 *
 * The oldest-match rule above is a CHOICE made under ambiguity: two tool calls
 * with one key, and no way to tell which closer owns which floor. A choice
 * made under ambiguity is exactly where the defect this branch closes lived —
 * a foreign PostToolUse turned a state that was not provable at all into an
 * exonerating `predeclared` — so the rule is not allowed to rest on the
 * sentence that says it is conservative. It is proved over PAIRS: one arm
 * where the two calls are distinguishable, one arm where the SAME allocator
 * traffic collides on one key, and the hub asked the same question of both.
 *
 * WHAT COUNTS AS CONSERVATIVE, stated as the assertion and not as prose: for
 * every question, the ambiguous arm answers what the unambiguous arm answered,
 * or it REFUSES. There is no question it answers where the other refused, and
 * none it answers differently. `null` is the only value it may add.
 */
const USABLE_ORDER: SessionCausalOrder = {
  sessionId: "s",
  state: "usable",
  reason: "sequenced",
  epochs: 1,
};

/** `compareEvents`' own answer for "A happens before B" — the exonerating one. */
const PRECEDES: -1 = -1;

/** A tool-lane row as the hub stores it — `seqKind` from the hub's own map. */
const editRow = (range: SeqRange): OrderedEvent => ({
  sessionId: "s",
  seqEpoch: EPOCH,
  seqN: range.from + range.count - 1,
  seqAfter: range.after ?? null,
  seqKind: seqKindFor("tool_edit", {
    epoch: EPOCH,
    n: range.from,
    ...(range.after === undefined ? {} : { after: range.after }),
  }),
  seqReason: "sequenced",
  observedAt: new Date(),
});

/** An MCP publish: a POINT, `emitted`, allocated at the thing it records. */
const pointRow = (n: number): OrderedEvent => ({
  sessionId: "s",
  seqEpoch: EPOCH,
  seqN: n,
  seqAfter: null,
  seqKind: "emitted",
  seqReason: "sequenced",
  observedAt: new Date(),
});

interface Arm {
  /** The racing explanation's position — identical in both arms. */
  readonly raced: number;
  /** The two closers, in the order their PostToolUse ran. */
  readonly closed: readonly SeqRange[];
}

/**
 * ONE allocator script, run with whichever keys the caller hands it. The
 * traffic is identical in both arms — same opens, same racing allocation, same
 * closes, so every POSITION matches and only the brackets can differ.
 */
const runArm = async (
  label: string,
  keys: readonly [string, string],
): Promise<Arm> => {
  const home = await fixture(label);
  await openToolWindow(home, SESSION_ID, keys[0]);
  const raced = await allocateSeq(home, SESSION_ID, 1);
  await openToolWindow(home, SESSION_ID, keys[1]);
  const second = await allocateToolSeq(home, SESSION_ID, 1, keys[1]);
  const first = await allocateToolSeq(home, SESSION_ID, 1, keys[0]);
  if (raced === null || second === null || first === null) {
    throw new Error(`${label}: the allocator refused with no lock contention`);
  }
  return { raced: raced.from, closed: [second, first] };
};

describe("an ambiguous key can only cost certainty", () => {
  test("a colliding key never answers where distinct keys refused", async () => {
    // Arrange: the same session, the same allocations, the same questions —
    // once with two tools the key can tell apart, once with two the key
    // cannot.
    const distinct = await runArm("conservative-distinct", [
      toolWindowKey("Edit", { file_path: "/tmp/acme-api/src/a.ts" }),
      toolWindowKey("Edit", { file_path: "/tmp/acme-api/src/b.ts" }),
    ]);
    const collided = await runArm("conservative-collided", [KEY, KEY]);

    // Act: ask the hub about every position the session handed out, for both
    // closers, in both arms. A single hand-picked question could be the one
    // the rule happens to be safe for.
    const highest = Math.max(
      ...distinct.closed.map((range) => range.from + range.count - 1),
    );
    const questions = Array.from({ length: highest }, (_, index) => index + 1);
    const verdicts = (arm: Arm): readonly (number | null)[] =>
      arm.closed.flatMap((range) =>
        questions.map((n) => compareEvents(USABLE_ORDER, pointRow(n), editRow(range))),
      );
    const withoutAmbiguity = verdicts(distinct);
    const withAmbiguity = verdicts(collided);

    // Assert, in three parts.
    // 1. The arms asked the SAME questions of the same numbers, or the
    //    comparison below would be between two different sessions.
    expect(collided.raced).toBe(distinct.raced);
    expect(collided.closed.map((range) => range.from)).toEqual(
      distinct.closed.map((range) => range.from),
    );
    // 2. THE PROPERTY: every ambiguous answer is the unambiguous one or a
    //    refusal. Never a different answer, never an answer where the other
    //    refused — so no `predeclared` can be reached only by the ambiguity.
    expect(withAmbiguity).toHaveLength(withoutAmbiguity.length);
    for (const [index, answer] of withAmbiguity.entries()) {
      expect([withoutAmbiguity[index], null]).toContain(answer);
    }
    // 3. NOT VACUOUS: the ambiguity really does cost something here, so a
    //    future rule that quietly stopped widening could not pass part 2 by
    //    changing nothing at all. The racing explanation is ordered BEFORE the
    //    second tool's edit when the keys are distinct, and refused when they
    //    collide — an exoneration withdrawn, which is the direction the fifth
    //    principle demands.
    expect(
      compareEvents(USABLE_ORDER, pointRow(distinct.raced), editRow(distinct.closed[0]!)),
    ).toBe(PRECEDES);
    expect(
      compareEvents(USABLE_ORDER, pointRow(collided.raced), editRow(collided.closed[0]!)),
    ).toBeNull();
    // ...and the bracket it did that with is the WIDER one: an ambiguous floor
    // is never later than the floor the same closer would have had.
    expect(collided.closed[0]?.after).toBeLessThan(distinct.closed[0]!.after!);
  });
});
