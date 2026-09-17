/**
 * THE PAIRING RULE ITSELF, at the allocator rather than through the hooks.
 *
 * The hooks key a window by the host's `tool_use_id` (state/tool-window-key.ts),
 * which names ONE call. This file pins what the allocator does with such keys —
 * the cap, the legacy fields, a key nothing opened — and then proves over pairs
 * that no close can be more certain than the call that made it: every answer the
 * hub gives from a bracket the allocator handed out is the answer it would give
 * with full information about which floor is whose, or a refusal.
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

/** What PostToolUse reserves per call — any block size proves the same thing. */
const CLOSE_BLOCK = 1;

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

/** The key a hook derives for one call — the host's id, never the input. */
const keyOf = (toolUseId: string): string => {
  const key = toolWindowKey("Edit", toolUseId);
  if (key === null) {
    throw new Error(`no key for ${toolUseId}`);
  }
  return key;
};

const KEY = keyOf("toolu_01ALPHA");

describe("a window is found by its own call's key", () => {
  test("a call with no host id has no key, and twins with two ids have two", () => {
    // The refusal and the fix in one place. No id → no key → no window, so the
    // edit travels as the upper bound it is. Two IDENTICAL calls — same tool,
    // same input — are two keys as long as the host gave them two ids, which
    // is exactly what a digest of the input could not tell apart.
    expect(toolWindowKey("Edit", undefined)).toBeNull();
    expect(toolWindowKey("Edit", "")).toBeNull();
    expect(keyOf("toolu_01TWIN_A")).not.toBe(keyOf("toolu_01TWIN_B"));
    expect(keyOf("toolu_01TWIN_A")).toBe(keyOf("toolu_01TWIN_A"));
    expect(keyOf("toolu_01TWIN_A")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("one call opened twice brackets both closes from its OLDER floor", async () => {
    // Arrange: a double-wired install runs PreToolUse once per wiring, so ONE
    // call opens twice under ONE key, with a real position landing between the
    // two opens. Both floors are that call's own and both precede its edit;
    // the older is the wider interval, and a wider interval can only refuse.
    const home = await fixture("window-double-wired");
    const first = await openToolWindow(home, SESSION_ID, KEY);
    const raced = await allocateSeq(home, SESSION_ID, 1);
    const second = await openToolWindow(home, SESSION_ID, KEY);

    // Act: the two PostToolUse runs of the same call.
    const closedFirst = await allocateToolSeq(home, SESSION_ID, CLOSE_BLOCK, KEY);
    const closedSecond = await allocateToolSeq(home, SESSION_ID, CLOSE_BLOCK, KEY);

    // Assert
    expect(first).toBe(1);
    expect(raced?.from).toBe(2);
    expect(second).toBe(3);
    expect(closedFirst?.after).toBe(first!);
    expect(closedSecond?.after).toBe(first!);
    expect((await readSessionState(home, SESSION_ID))?.toolWindows).toEqual([]);
  });

  test("a key nothing opened takes no bracket and removes no window", async () => {
    // Arrange: Bash, a hook installed mid-tool, a refused open, an evicted
    // entry. The window that IS open belongs to another call and must survive.
    const home = await fixture("window-foreign-key");
    await openToolWindow(home, SESSION_ID, KEY);

    // Act
    const range = await allocateToolSeq(home, SESSION_ID, CLOSE_BLOCK, keyOf("toolu_01OTHER"));

    // Assert
    expect(range?.after).toBeUndefined();
    expect((await readSessionState(home, SESSION_ID))?.toolWindows).toHaveLength(1);
  });

  test("the cap evicts the OLDEST window and counts the eviction", async () => {
    // Arrange: a session whose PreToolUse hooks outnumber their PostToolUse
    // ones — every denied or aborted edit leaves one entry — must
    // cost bounded memory.
    const home = await fixture("window-cap");
    const keys = Array.from({ length: MAX_TOOL_WINDOWS + 1 }, (_, index) =>
      keyOf(`toolu_01CAP${String(index)}`),
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
    const evicted = await allocateToolSeq(home, SESSION_ID, CLOSE_BLOCK, keys[0]!);
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
    const range = await allocateToolSeq(home, SESSION_ID, CLOSE_BLOCK, KEY);

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
 * PROVED OVER PAIRS, NOT ASSERTED. Every script below runs the real allocator,
 * and every answer the hub gives from the bracket it handed out is compared
 * with the answer the hub gives from the ORACLE bracket for the same call: the
 * floor that call's own open actually consumed (`openToolWindow`'s return
 * value), or no bracket when its open never happened or was evicted. The
 * oracle is sound by construction — its floor was taken before the edit and
 * its closing position after it — so "equal to the oracle, or a refusal" is
 * the definition of conservative, and it is checked for EVERY position the
 * session handed out rather than for one hand-picked question.
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
const editRow = (range: SeqRange, after: number | undefined): OrderedEvent => ({
  sessionId: "s",
  seqEpoch: EPOCH,
  seqN: range.from + range.count - 1,
  seqAfter: after ?? null,
  seqKind: seqKindFor("tool_edit", {
    epoch: EPOCH,
    n: range.from,
    ...(after === undefined ? {} : { after }),
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

/** What happened to a call's PreToolUse. */
type OpenFate = "opened" | "refused" | "evicted";

const FATES: readonly OpenFate[] = ["opened", "refused", "evicted"];

/** One step of a script: a call's open or close, or the explanation. */
type Step = "openA" | "openB" | "closeA" | "closeB" | "explain";

/**
 * Every order of the five steps in which each call opens before it closes —
 * thirty of them, the explanation landing everywhere it can.
 */
const interleavings = (): readonly (readonly Step[])[] => {
  const steps: readonly Step[] = ["openA", "openB", "closeA", "closeB", "explain"];
  const permute = (rest: readonly Step[]): readonly (readonly Step[])[] =>
    rest.length === 0
      ? [[]]
      : rest.flatMap((step, index) =>
          permute([...rest.slice(0, index), ...rest.slice(index + 1)]).map(
            (tail) => [step, ...tail],
          ),
        );
  return permute(steps).filter(
    (order) =>
      order.indexOf("openA") < order.indexOf("closeA") &&
      order.indexOf("openB") < order.indexOf("closeB"),
  );
};

interface Closed {
  /** The range the allocator handed this call's close, bracket included. */
  readonly range: SeqRange;
  /** The floor this call's own open consumed, or none. */
  readonly oracle: number | undefined;
}

interface Outcome {
  readonly script: string;
  readonly closed: readonly Closed[];
  /** Every position the session handed out, each asked as a point. */
  readonly highest: number;
  /** Entries the cap pushed out during the script — anybody's. */
  readonly evictions: number;
}

/**
 * ONE SCRIPT against the real allocator. `keys` says what the hooks would
 * derive for the two calls; `fates` what happened to each call's open. An
 * eviction is a real one: the call opens, then MAX_TOOL_WINDOWS other calls
 * open behind it and push it out before anything else happens.
 */
const runScript = async (
  order: readonly Step[],
  keys: { readonly A: string; readonly B: string },
  fates: { readonly A: OpenFate; readonly B: OpenFate },
): Promise<Outcome> => {
  const home = await makeHome("window-pairs");
  try {
    await writeSessionState(home, stateFor());
    const oracle: { A?: number; B?: number } = {};
    const closed: Closed[] = [];
    const open = async (call: "A" | "B"): Promise<void> => {
      if (fates[call] === "refused") {
        return;
      }
      const taken = await openToolWindow(home, SESSION_ID, keys[call]);
      if (taken === null) {
        throw new Error("the allocator refused with no lock contention");
      }
      if (fates[call] === "evicted") {
        for (let index = 0; index < MAX_TOOL_WINDOWS; index += 1) {
          await openToolWindow(home, SESSION_ID, keyOf(`toolu_01FILL${call}${String(index)}`));
        }
        return;
      }
      oracle[call] = taken;
    };
    const close = async (call: "A" | "B"): Promise<void> => {
      const range = await allocateToolSeq(home, SESSION_ID, CLOSE_BLOCK, keys[call]);
      if (range === null) {
        throw new Error("the allocator refused with no lock contention");
      }
      closed.push({ range, oracle: oracle[call] });
    };
    for (const step of order) {
      if (step === "openA") await open("A");
      if (step === "openB") await open("B");
      if (step === "closeA") await close("A");
      if (step === "closeB") await close("B");
      if (step === "explain") await allocateSeq(home, SESSION_ID, 1);
    }
    const state = await readSessionState(home, SESSION_ID);
    return {
      script: `${order.join(" ")} [A ${fates.A}, B ${fates.B}]`,
      closed,
      highest: state?.eventSeq ?? 0,
      evictions: state?.toolWindowEvictions ?? 0,
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

interface Divergence {
  readonly script: string;
  readonly question: number;
  readonly answer: number | null;
  readonly oracle: number | null;
}

/** Every question on which the allocator's answer is neither the oracle's nor a refusal. */
const divergences = (outcome: Outcome): readonly Divergence[] =>
  outcome.closed.flatMap((call) =>
    Array.from({ length: outcome.highest }, (_, index) => index + 1).flatMap(
      (question) => {
        const answer = compareEvents(
          USABLE_ORDER,
          pointRow(question),
          editRow(call.range, call.range.after),
        );
        const oracle = compareEvents(
          USABLE_ORDER,
          pointRow(question),
          editRow(call.range, call.oracle),
        );
        return answer === null || answer === oracle
          ? []
          : [{ script: outcome.script, question, answer, oracle }];
      },
    ),
  );

const everyScript = async (
  keys: { readonly A: string; readonly B: string },
  fates: readonly OpenFate[],
): Promise<readonly Outcome[]> => {
  const outcomes: Outcome[] = [];
  for (const order of interleavings()) {
    for (const A of fates) {
      for (const B of fates) {
        outcomes.push(await runScript(order, keys, { A, B }));
      }
    }
  }
  return outcomes;
};

describe("an ambiguous or unmatched close can only cost certainty", () => {
  test("one key per call: every close answers what the oracle answers, or refuses", async () => {
    // Arrange: two calls, two host ids — including two IDENTICAL calls, which
    // is what the ids are for. Each open succeeds, is refused, or is evicted,
    // in every order the two calls and the explanation can take.
    const keys = { A: keyOf("toolu_01PAIR_A"), B: keyOf("toolu_01PAIR_B") };

    // Act
    const outcomes = await everyScript(keys, FATES);

    // Assert, in three parts.
    // 1. The enumeration is what it says it is.
    expect(interleavings()).toHaveLength(30);
    expect(outcomes).toHaveLength(30 * FATES.length * FATES.length);
    // 2. THE PROPERTY, for every position of every script.
    expect(outcomes.flatMap(divergences)).toEqual([]);
    // 3. With a key that names one call the allocator is not merely safe but
    //    EXACT: a bracket it hands out is always the call's own floor, and
    //    where the cap evicted nothing it hands out every floor there is. (An
    //    eviction can push out a call that did open — a sibling's burst of
    //    opens reaches back past it — and then the call gets none, which the
    //    property above already allows.)
    for (const outcome of outcomes) {
      for (const call of outcome.closed) {
        if (call.range.after !== undefined || outcome.evictions === 0) {
          expect(call.range.after).toBe(call.oracle);
        }
      }
    }
    expect(outcomes.some((outcome) => outcome.evictions === 0)).toBe(true);
  });

  test("one call opened twice: both closes answer as its own floor would, or refuse", async () => {
    // Arrange: the one way a single key still holds two entries — a
    // double-wired install — in every place the explanation can land. The
    // oracle is the call's LATEST open, the narrowest floor that still
    // precedes its edit; the allocator hands out the oldest.
    const outcomes: Outcome[] = [];
    for (let at = 0; at <= 4; at += 1) {
      const home = await fixture(`window-twice-${String(at)}`);
      const steps = ["open", "open", "close", "close"];
      const script = [...steps.slice(0, at), "explain", ...steps.slice(at)];
      let latest: number | undefined;
      const closed: Closed[] = [];
      for (const step of script) {
        if (step === "explain") {
          await allocateSeq(home, SESSION_ID, 1);
        } else if (step === "open") {
          latest = (await openToolWindow(home, SESSION_ID, KEY)) ?? undefined;
        } else {
          const range = await allocateToolSeq(home, SESSION_ID, CLOSE_BLOCK, KEY);
          closed.push({ range: range!, oracle: latest });
        }
      }
      const state = await readSessionState(home, SESSION_ID);
      outcomes.push({
        script: script.join(" "),
        closed,
        highest: state?.eventSeq ?? 0,
        evictions: state?.toolWindowEvictions ?? 0,
      });
    }

    // Assert
    expect(outcomes.flatMap(divergences)).toEqual([]);
  });

  test("KNOWN LIMIT: a key shared by two calls answers where the oracle refused", async () => {
    // Arrange: the assumption the key rests on, written down as a test rather
    // than hoped for. If two DIFFERENT calls ever reached the allocator under
    // one key — a digest of name and input did exactly that for identical
    // calls, and a host reusing an id would — then a call whose own open was
    // refused finds its twin's entry and takes a floor from after its edit.
    // No close-time rule can repair that, because the close cannot see whose
    // entry it found. Both opens succeeding stays safe; a refusal does not.
    const shared = { A: KEY, B: KEY };

    // Act
    const bothOpened = await everyScript(shared, ["opened"]);
    const withRefusals = await everyScript(shared, ["opened", "refused"]);

    // Assert: safe while every call has its own entry...
    expect(bothOpened.flatMap(divergences)).toEqual([]);
    // ...and a stronger answer than the oracle's the moment one does not —
    // the exonerating one among them, which is the defect this key closes.
    const stronger = withRefusals.flatMap(divergences);
    expect(stronger.length).toBeGreaterThan(0);
    expect(stronger.every((entry) => entry.oracle === null)).toBe(true);
    expect(stronger.some((entry) => entry.answer === PRECEDES)).toBe(true);
    expect(
      stronger.every((entry) => entry.script.includes("refused")),
    ).toBe(true);
  });
});
