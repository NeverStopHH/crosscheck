/**
 * WAS THE REASON WRITTEN BEFORE THE CHANGE? (spec 06 §3.5, §7.)
 *
 * THE ASYMMETRY THAT DECIDES EVERY CASE BELOW: a gap that produces an
 * ACCUSATION is reported by the person accused; a gap that produces an
 * EXONERATION is reported by nobody. So an error toward `predeclared` is the
 * worst outcome this function can have — worse than a refusal, worse than a
 * false `post_hoc` — and several of these tests exist only to pin that
 * direction.
 *
 *   INT-1  declared-before is distinguishable from declared-after
 *   INT-2  the answer never comes from a clock
 *   INT-3  an unorderable pair is never `predeclared`, and `absent` never
 *          travels without its reason
 *   INT-6  a derived non-goal is never evidence against its own session
 *   INT-10 a declared non-goal that was then edited is `post_hoc`, and `role`
 *          is actually read
 *
 * PLUS TWO CASES §3.5 DOES NOT CONTAIN, and they are the ones that would have
 * shipped the defect. The spec's step 4 drops a null `seq` and a mismatched
 * epoch and stops — two of the order gate's six conditions. An `observed`
 * position (every Stop-time git-lane edit, every unbracketed tool-lane edit)
 * and a pair of OVERLAPPING WINDOWS both pass that step and then answer
 * `predeclared` from bare integers, which `session-order.ts` measured as a
 * coin flip that inverted 10 trials out of 10.
 */
import { describe, expect, test } from "bun:test";

import { explanationTimingFor } from "../src/services/intent-ledger.ts";
import type { IntentLedgerEntry } from "../src/services/intent-ledger.ts";
import type { SessionCausalOrder } from "../src/services/session-order.ts";
import type { OrderedEdit } from "../src/services/session-events.ts";

const SESSION = "cc_sess_01";
const OTHER_SESSION = "cc_sess_02";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_EPOCH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PATH = "packages/b.ts";
const LATE = new Date("2026-07-24T23:00:00.000Z");
const EARLY = new Date("2026-07-24T01:00:00.000Z");

const USABLE: SessionCausalOrder = {
  sessionId: SESSION,
  state: "usable",
  reason: "sequenced",
  epochs: 1,
};

interface IntentFixture {
  readonly version?: number;
  readonly seq?: number | null;
  readonly epoch?: string | null;
  readonly provenance?: "declared" | "derived";
  readonly sessionId?: string | null;
  readonly expected?: readonly string[];
  readonly nonGoals?: readonly string[];
  readonly capturedAt?: Date;
  readonly seqReason?: "sequenced" | "allocation_failed";
}

const intent = (fixture: IntentFixture = {}): IntentLedgerEntry => {
  const seq = fixture.seq === undefined ? 5 : fixture.seq;
  const epoch = fixture.epoch === undefined ? (seq === null ? null : EPOCH) : fixture.epoch;
  const version = fixture.version ?? 1;
  return {
    id: `iv_${version}`,
    workContextId: "wc_01",
    version,
    amendsVersion: version === 1 ? null : version - 1,
    authorSessionId: fixture.sessionId === undefined ? SESSION : fixture.sessionId,
    provenance: fixture.provenance ?? "declared",
    summary: `version ${version}`,
    reason: version === 1 ? null : "the provider's id changed",
    seqEpoch: epoch,
    seq,
    // A `set_intent` call is a POINT emitter: it publishes at the position it
    // took, so the window is [n, n] and `seq_after` is null.
    seqAfter: null,
    seqKind: (fixture.provenance ?? "declared") === "derived" ? "observed" : "emitted",
    // Defaulted from the position, and OVERRIDABLE: a row whose reason
    // disagrees with its own position is the shape case (a2) is about, and a
    // fixture that cannot express it cannot guard against it.
    seqReason: fixture.seqReason ?? (seq === null ? "allocation_failed" : "sequenced"),
    capturedAt: fixture.capturedAt ?? LATE,
    receivedAt: fixture.capturedAt ?? LATE,
    wire: {},
    scope: [
      ...(fixture.expected ?? []).map((value) => ({
        role: "expected" as const,
        kind: "file",
        value,
      })),
      ...(fixture.nonGoals ?? []).map((value) => ({
        role: "non_goal" as const,
        kind: "file",
        value,
      })),
    ],
  };
};

interface EditFixture {
  readonly seq?: number | null;
  readonly after?: number | null;
  readonly epoch?: string | null;
  readonly kind?: "emitted" | "observed";
  readonly sessionId?: string;
  readonly capturedAt?: Date;
}

const edit = (fixture: EditFixture = {}): OrderedEdit => {
  const seq = fixture.seq === undefined ? 7 : fixture.seq;
  return {
    event: {
      sessionId: fixture.sessionId ?? SESSION,
      seqEpoch: fixture.epoch === undefined ? (seq === null ? null : EPOCH) : fixture.epoch,
      seqN: seq,
      seqAfter: fixture.after === undefined ? 6 : fixture.after,
      seqKind: fixture.kind ?? "emitted",
      seqReason: seq === null ? "allocation_failed" : "sequenced",
      observedAt: fixture.capturedAt ?? EARLY,
    },
    kind: "file",
    value: PATH,
  };
};

describe("INT-1 — declared-before is distinguishable from declared-after", () => {
  test("an amendment at 5 against an edit at 7 is predeclared", () => {
    // Arrange / Act
    const answer = explanationTimingFor(
      USABLE,
      [intent({ version: 2, seq: 5, expected: [PATH] })],
      edit({ seq: 7, after: 6 }),
    );

    // Assert
    expect(answer.timing).toBe("predeclared");
    expect(answer.reason).toBe("declared_before");
    expect(answer.version).toBe(2);
  });

  test("the same amendment at 9 against the same edit is post_hoc", () => {
    // Arrange / Act
    const answer = explanationTimingFor(
      USABLE,
      [intent({ version: 2, seq: 9, expected: [PATH] })],
      edit({ seq: 7, after: 6 }),
    );

    // Assert: the two fixtures differ in ONE integer and must not agree.
    expect(answer.timing).toBe("post_hoc");
    expect(answer.reason).toBe("declared_after");
    expect(answer.version).toBe(2);
  });
});

describe("INT-2 — the answer never comes from a clock", () => {
  test("a wall clock that says `before` loses to a position that says `after`", () => {
    // Arrange: the amendment's wall clock is EARLIER than the edit's and its
    // position is LATER — a spool flushed by a successor session. A clock
    // comparison answers `predeclared` here; the only honest answer is
    // `post_hoc`.
    const answer = explanationTimingFor(
      USABLE,
      [intent({ version: 2, seq: 9, expected: [PATH], capturedAt: EARLY })],
      edit({ seq: 7, after: 6, capturedAt: LATE }),
    );

    // Assert
    expect(answer.timing).toBe("post_hoc");
    expect(answer.reason).toBe("declared_after");
  });
});

describe("INT-3 — an unorderable pair is never predeclared", () => {
  test("(a) an intent with no position answers absent / not_comparable", () => {
    // Arrange / Act
    const answer = explanationTimingFor(
      USABLE,
      [intent({ seq: null, expected: [PATH] })],
      edit({ seq: 7 }),
    );

    // Assert
    expect(answer.timing).toBe("absent");
    expect(answer.reason).toBe("not_comparable");
    expect(answer.indeterminacy).toBe("position_indeterminate");
  });

  test("(a2) a missing position does not become position zero, whatever the row's reason says", () => {
    // Arrange: the case (a) does NOT reach. Its fixture ties `seq: null` to
    // `seq_reason: "allocation_failed"`, so the gate refuses on the REASON and
    // the number is never read — which leaves the number itself unguarded. A
    // half-written row, or a connector that stamped the reason from the wrong
    // branch, carries a null position beside a reason claiming it was
    // sequenced. Read as zero, that row precedes every edit in the session.
    //
    // This is principle 5 in its sharpest form: missing evidence may weaken a
    // conclusion, never strengthen one. Measured against this very fixture,
    // `seqN: entry.seq ?? 0` answers `predeclared / declared_before` — the
    // value that EXONERATES — for a sentence whose position nobody knows.
    const answer = explanationTimingFor(
      USABLE,
      [intent({ seq: null, epoch: EPOCH, seqReason: "sequenced", expected: [PATH] })],
      edit({ seq: 7 }),
    );

    // Assert
    expect(answer.timing).toBe("absent");
    expect(answer.timing).not.toBe("predeclared");
    expect(answer.reason).toBe("not_comparable");
  });

  test("(b) an entry from another session answers different_session, whatever the numbers", () => {
    // Arrange: the numbers are the ones that would read `predeclared`.
    const answer = explanationTimingFor(
      USABLE,
      [intent({ seq: 1, sessionId: OTHER_SESSION, expected: [PATH] })],
      edit({ seq: 7 }),
    );

    // Assert
    expect(answer.timing).toBe("absent");
    expect(answer.reason).toBe("different_session");
  });

  test("(c) two positions in different epochs are never compared", () => {
    // Arrange: 5 < 7 across two counters is two unrelated integers. A
    // SessionStart re-fire, a busy-lock fallback and two homes on one host key
    // all restart the sequence.
    const answer = explanationTimingFor(
      USABLE,
      [intent({ seq: 5, epoch: OTHER_EPOCH, expected: [PATH] })],
      edit({ seq: 7, epoch: EPOCH }),
    );

    // Assert
    expect(answer.timing).toBe("absent");
    expect(answer.reason).toBe("not_comparable");
    expect(answer.indeterminacy).toBe("epoch_mismatch");
  });

  test("a session whose own order is broken answers before anything else is asked", () => {
    // Arrange
    const answer = explanationTimingFor(
      { sessionId: SESSION, state: "broken", reason: "epoch_split", epochs: 2 },
      [intent({ seq: 5, expected: [PATH] })],
      edit({ seq: 7 }),
    );

    // Assert
    expect(answer.timing).toBe("absent");
    expect(answer.indeterminacy).toBe("session_order_unusable");
  });

  test("every absent answer carries a reason; no answer is the bare word", () => {
    // Arrange: `absent` alone asserts that no explanation exists, which
    // accuses a developer. "We cannot tell when it was written" excuses one.
    const cases = [
      explanationTimingFor(USABLE, [], edit()),
      explanationTimingFor(USABLE, [intent({ provenance: "derived", expected: [PATH] })], edit()),
      explanationTimingFor(USABLE, [intent({ sessionId: OTHER_SESSION, expected: [PATH] })], edit()),
      explanationTimingFor(USABLE, [intent({ seq: null, expected: [PATH] })], edit()),
      explanationTimingFor(USABLE, [intent({ expected: ["packages/other.ts"] })], edit()),
    ];

    // Assert
    expect(cases.map((answer) => answer.reason)).toEqual([
      "no_intent",
      "derived_excluded",
      "different_session",
      "not_comparable",
      "scope_not_named",
    ]);
    for (const answer of cases) {
      expect(answer.timing).toBe("absent");
      expect(answer.reason).not.toBe("");
    }
  });
});

describe("an upper bound is never turned into a happens-before", () => {
  test("an emitted intent at 5 against an OBSERVED edit at 7 is not predeclared", () => {
    // Arrange: `git_diff` is always observed — the Stop-time lane sees a
    // working tree at the END of a turn and cannot say when inside it the file
    // was touched — and an unbracketed tool-lane edit is stored observed too.
    // The bare integers say 5 < 7. They are not evidence of anything: the ACP
    // engine positions an edit on the wire row that ANNOUNCES it, before the
    // edit exists, so an observed position is not even a sound upper bound.
    const answer = explanationTimingFor(
      USABLE,
      [intent({ seq: 5, expected: [PATH] })],
      edit({ seq: 7, after: null, kind: "observed" }),
    );

    // Assert
    expect(answer.timing).not.toBe("predeclared");
    expect(answer.timing).toBe("absent");
    expect(answer.reason).toBe("not_comparable");
    expect(answer.indeterminacy).toBe("upper_bound_only");
  });

  test("two events whose windows overlap are concurrent, not ordered", () => {
    // Arrange: the intent published at 5; the edit's hook took its position at
    // 7 having started before 4. The edit happened SOMEWHERE in (4, 7], which
    // includes 5. Concurrent is not an order, and answering anyway is how the
    // exonerating lane answers for a change that came first.
    const answer = explanationTimingFor(
      USABLE,
      [intent({ seq: 5, expected: [PATH] })],
      edit({ seq: 7, after: 4 }),
    );

    // Assert
    expect(answer.timing).not.toBe("predeclared");
    expect(answer.reason).toBe("not_comparable");
    expect(answer.indeterminacy).toBe("concurrent");
  });
});

describe("INT-6 — a derived non-goal is never evidence against its own session", () => {
  test("a chain whose only naming entry is derived answers derived_excluded", () => {
    // Arrange / Act
    const answer = explanationTimingFor(
      USABLE,
      [intent({ provenance: "derived", seq: 5, nonGoals: [PATH] })],
      edit({ seq: 7 }),
    );

    // Assert
    expect(answer.timing).toBe("absent");
    expect(answer.reason).toBe("derived_excluded");
  });
});

describe("INT-10 — a declared non-goal that was then edited is post_hoc", () => {
  test("`non_goal` at 5 and an edit at 7 is post_hoc, not predeclared", () => {
    // Arrange / Act
    const answer = explanationTimingFor(
      USABLE,
      [intent({ version: 2, seq: 5, nonGoals: [PATH] })],
      edit({ seq: 7, after: 6 }),
    );

    // Assert: the session said "do not touch b.ts" and touched it. Reporting
    // that as a reason declared BEFORE the change is principle 3 answered
    // backwards on the one input this ledger exists to capture.
    expect(answer.timing).toBe("post_hoc");
    expect(answer.reason).toBe("declared_non_goal_edited");
    expect(answer.version).toBe(2);
  });

  test("the same path as `expected` at 5 IS predeclared — the two roles differ", () => {
    // Arrange / Act
    const answer = explanationTimingFor(
      USABLE,
      [intent({ version: 2, seq: 5, expected: [PATH] })],
      edit({ seq: 7, after: 6 }),
    );

    // Assert
    expect(answer.timing).toBe("predeclared");
    expect(answer.reason).toBe("declared_before");
  });

  test("where both roles name the path, the non-goal wins", () => {
    // Arrange: v1 forbade the path, v2 widened past it. The widening IS the
    // event AT-4 asks about, so the stronger signal answers.
    const answer = explanationTimingFor(
      USABLE,
      [
        intent({ version: 1, seq: 3, nonGoals: [PATH] }),
        intent({ version: 2, seq: 5, expected: [PATH] }),
      ],
      edit({ seq: 7, after: 6 }),
    );

    // Assert
    expect(answer.timing).toBe("post_hoc");
    expect(answer.reason).toBe("declared_non_goal_edited");
    expect(answer.version).toBe(1);
  });
});

describe("the ladder's order is the contract", () => {
  test("a comparable entry that names nothing does not borrow a naming entry's answer", () => {
    // Arrange: step 5 runs AFTER step 4, so an entry that names the path but
    // cannot be compared does not rescue one that can be compared and names
    // nothing.
    const answer = explanationTimingFor(
      USABLE,
      [intent({ version: 1, seq: 3, expected: ["packages/other.ts"] })],
      edit({ seq: 7, after: 6 }),
    );

    // Assert
    expect(answer.reason).toBe("scope_not_named");
  });

  test("an empty chain is `no_intent`, never `not_comparable`", () => {
    // Arrange: "nothing was ever written" and "we cannot tell when it was
    // written" are different sentences, and only the first accuses anyone.
    const answer = explanationTimingFor(USABLE, [], edit());

    // Assert
    expect(answer.reason).toBe("no_intent");
    expect(answer.version).toBeNull();
  });
});
