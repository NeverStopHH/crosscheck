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
  readonly seqKind?: "emitted" | "observed";
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
    // DEFAULTED FROM PROVENANCE, AND OVERRIDABLE. The two are coupled in the
    // hub because `provenance` is the only signal it has, but the coupling is
    // a DEFAULT rather than an invariant: the body chooses `provenance`, the
    // spec's own column table concedes it is unverifiable, and a fixture that
    // could not express the two apart could not test the ladder against a
    // `declared` row carrying an `observed` position at all.
    seqKind:
      fixture.seqKind ??
      ((fixture.provenance ?? "declared") === "derived" ? "observed" : "emitted"),
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

describe("an upper bound refuses whatever the row calls itself", () => {
  test("a declared row carrying an observed position is still refused", async () => {
    // THE COMBINATION NO TEST EXERCISED. The fixture used to derive `seqKind`
    // from `provenance` with no override, exactly as the hub does, so the two
    // could never be pulled apart — and the hub's coupling rests on a body
    // field the spec's own table calls unverifiable.
    //
    // What this pins is the half that still holds when the label lies: an
    // `observed` position is an UPPER BOUND, and the gate refuses it no
    // matter what the row says about its own lane. The refusal names its own
    // reason, so a reader is sent to the right remedy.
    const answer = explanationTimingFor(
      USABLE,
      [intent({ seq: 5, provenance: "declared", seqKind: "observed", expected: [PATH] })],
      edit({ seq: 7 }),
    );

    expect(answer.timing).toBe("absent");
    expect(answer.reason).toBe("not_comparable");
    expect(answer.indeterminacy).toBe("upper_bound_only");
  });

  test("the same row with an emitted position answers", () => {
    // The control, and the measurement the finding reported: two rows
    // identical but for the lane label answer predeclared vs a refusal. That
    // asymmetry is exactly why the label matters and why the comment claiming
    // the hub derives it was worth correcting.
    const answer = explanationTimingFor(
      USABLE,
      [intent({ seq: 5, provenance: "declared", seqKind: "emitted", expected: [PATH] })],
      edit({ seq: 7 }),
    );

    expect(answer.timing).toBe("predeclared");
    expect(answer.reason).toBe("declared_before");
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
  test("a comparable entry that names nothing answers `scope_not_named`", () => {
    // ITS NAME AND ITS COMMENT BOTH OVERCLAIMED, and an independent refuter
    // said so: the fixture holds ONE entry, so there is no "naming entry" for
    // anything to borrow from, and the 4-against-5 swap left it green. What
    // it really pins is the one thing a single comparable unnamed row can
    // pin — that the answer is `scope_not_named` rather than a refusal about
    // comparability. That is worth keeping; the ordering claim was not its to
    // make, and the accusation block below carries it.
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

describe("an accusation nobody could order does not become an exoneration", () => {
  /**
   * THE WORST THING THIS MODULE CAN DO, and it did it until an independent
   * refuter constructed these five inputs.
   *
   * A session declares `b.ts` a NON-GOAL and edits it anyway. That is the most
   * post-hoc thing a session can do, and step 6 answers
   * `post_hoc / declared_non_goal_edited`. But step 4 first drops every row it
   * cannot order — and when the dropped row was the accusing one, step 6
   * answered from whatever survived: `predeclared / declared_before`, with
   * `indeterminacy: null`, so no reader could see that anything had been
   * dropped at all.
   *
   * Every case below differs from the control in exactly ONE way: whether the
   * non-goal row's POSITION was usable. The session did the same thing in all
   * six.
   */
  const control = { seq: 3, version: 1, nonGoals: [PATH] };
  const excuse = { seq: 5, version: 2, expected: [PATH] };

  test("the control accuses, so the cases below have something to lose", () => {
    const result = explanationTimingFor(
      USABLE,
      [intent(control), intent(excuse)],
      edit({ seq: 7 }),
    );

    expect(result.timing).toBe("post_hoc");
    expect(result.reason).toBe("declared_non_goal_edited");
  });

  test.each([
    ["a position that was never allocated", { ...control, seq: null }],
    ["an observed position, which is an upper bound", { ...control, seqKind: "observed" as const }],
    ["a position from another epoch", { ...control, epoch: "epoch-other" }],
  ])("a non-goal with %s is refused, never excused", (_label, nonGoal) => {
    // THE ANCHOR. Let step 4 drop the accusing row silently and this answers
    // `predeclared / declared_before` — an exoneration assembled out of the
    // row that survived, about a session that declared the path a non-goal
    // and edited it.
    const result = explanationTimingFor(
      USABLE,
      [intent(nonGoal), intent(excuse)],
      edit({ seq: 7 }),
    );

    expect(result.timing).not.toBe("predeclared");
    expect(result.timing).toBe("absent");
    expect(result.reason).toBe("not_comparable");
    // AND THE READER IS TOLD WHY. `indeterminacy: null` beside a refusal is
    // the silence that made this invisible: a reader cannot ask about a row
    // they were never told was dropped.
    expect(result.indeterminacy).not.toBeNull();
  });

  test("a refused EXPECTED row is not reported as a path nobody declared", () => {
    // The other direction, and it is a false statement rather than an
    // inversion: `scope_not_named` says "this session never declared that
    // path" about a session that did — the hub just could not order it.
    //
    // THE SECOND ROW IS WHAT MAKES THIS A TEST. With the refused row alone,
    // step 4's own `comparable.length === 0` branch already answers
    // `not_comparable` — so the fixture passed with the new rung removed and
    // proved nothing. A comparable row that names a DIFFERENT path carries
    // the ladder past step 4 and into the case this test is named for.
    const result = explanationTimingFor(
      USABLE,
      [
        intent({ seq: null, version: 1, expected: [PATH] }),
        intent({ seq: 5, version: 2, expected: ["packages/elsewhere.ts"] }),
      ],
      edit({ seq: 7 }),
    );

    expect(result.reason).not.toBe("scope_not_named");
    expect(result.reason).toBe("not_comparable");
    expect(result.indeterminacy).not.toBeNull();
  });

  test("a refused row that names NOTHING changes no answer", () => {
    // The control for the correction itself. Only rows naming the edited path
    // can change what step 6 says, so only those may override it — otherwise
    // any unorderable row anywhere in the chain would silence every answer,
    // which is a refusal that costs a reader everything and protects nothing.
    const result = explanationTimingFor(
      USABLE,
      [
        intent({ seq: null, version: 1, expected: ["packages/elsewhere.ts"] }),
        intent(excuse),
      ],
      edit({ seq: 7 }),
    );

    expect(result.timing).toBe("predeclared");
    expect(result.reason).toBe("declared_before");
  });
});

describe("the order of the rungs is the contract, and these are the swaps that prove it", () => {
  /**
   * A REFUTER GENERATED ALL FIVE ADJACENT SWAPS AND RAN THE WHOLE 645-TEST
   * SERVER SUITE ON EACH. Three were caught. Two — 2 against 3, and 4 against
   * 5 — changed the answer on constructed inputs while every test in the
   * repository stayed green.
   *
   * A contract nothing enforces is a comment. These two cases are the
   * enforcement: each builds a chain where the two rungs disagree, and each
   * asserts the reason the CURRENT order produces. Swap the rungs in
   * `intent-ledger.ts` and the reason changes, so the test goes red.
   *
   * Both answers are refusals, and that is the point rather than a weakness:
   * the reason is what a reader acts on. "Your subagent's guess does not count
   * against you" and "there is no order across two sessions" send somebody to
   * different places.
   */
  test("2 before 3: a derived row of THIS session is excluded before session scope is asked", () => {
    // The chain holds exactly two rows and each survives only one of the two
    // rungs: a DERIVED row from this session, and a DECLARED row from
    // another. Rung 2 (provenance) leaves the foreign-session row and rung 3
    // answers `different_session`. Reverse them and rung 3 leaves the derived
    // row, so rung 2 answers `derived_excluded`.
    const result = explanationTimingFor(
      USABLE,
      [
        intent({ version: 1, seq: 3, provenance: "derived", expected: [PATH] }),
        intent({
          version: 2,
          seq: 5,
          provenance: "declared",
          sessionId: "cc_other_session",
          expected: [PATH],
        }),
      ],
      edit({ seq: 7 }),
    );

    expect(result.timing).toBe("absent");
    expect(result.reason).toBe("different_session");
  });

  test("4 before 5 is carried by the accusation cases above, not by a case of its own", () => {
    // I WROTE A DEDICATED FIXTURE HERE AND IT PROVED NOTHING. A comparable row
    // naming another path plus an unorderable row naming this one answers
    // `not_comparable` under BOTH orderings — step 4a refuses it one way, an
    // empty `named` set refuses it the other. Same word, same indeterminacy.
    //
    // Only one shape separates the two orders: an unorderable NON-GOAL naming
    // the path beside a comparable EXPECTED one naming it too. Ask
    // comparability first and step 4a refuses; ask naming first and both rows
    // survive step 5, the non-goal falls out of step 4, and step 6 answers
    // `predeclared`. That shape is the describe block above, and swapping the
    // two rungs turns three of its cases red — which is the enforcement.
    //
    // So this test asserts the one thing it can: that the ordering is pinned
    // SOMEWHERE. Deleting the block above without replacing its guarantee
    // leaves the rungs free to move.
    const chain = [
      intent({ version: 1, seq: 3, nonGoals: [PATH] }),
      intent({ version: 2, seq: 5, expected: [PATH] }),
    ];
    const orderable = explanationTimingFor(USABLE, chain, edit({ seq: 7 }));

    // A usable non-goal accuses — the state the swap would have to destroy.
    expect(orderable.reason).toBe("declared_non_goal_edited");
  });
});
