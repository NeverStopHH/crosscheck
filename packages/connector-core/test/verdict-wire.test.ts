/**
 * The verdict as it crosses the wire (04 §5).
 *
 * THE DIRECTION THAT MATTERS is the one an OLD hub takes — no `verdict` key at
 * all — and the rule inverts this tree's usual tolerant parse for coverage's
 * reason, stated one level up in http/verdict.ts: a ranking printed with no
 * verdict beside it reads as a fully qualified answer, and silence there would
 * leave the pre-04 behaviour standing while looking like the post-04 one.
 *
 * `null` is the honest reading, and the renderer is required to SAY it. What
 * this client must never do is manufacture an `INDETERMINATE` of its own: a
 * verdict invented here is indistinguishable, downstream, from one the hub
 * computed, and that is how a client's default becomes the hub's authority.
 */
import { afterAll, describe, expect, test } from "bun:test";

import {
  ATTRIBUTIONS,
  BEHAVIOR_DELTAS,
  PROTECTIONS,
  VERDICT_BASES,
  VERDICT_FALSIFIERS,
  parseVerdict,
} from "../src/http/verdict.ts";
import { getSuspect } from "../src/http/hub.ts";
import type { HubContext } from "../src/http/client.ts";
import * as hub from "@crosscheck/server";

const REPO = "github.com/acme/api";

const SUSPECT_BODY = {
  outcome: "ranked",
  falsifier: { kind: "recorded_break", at: null, check: null },
  scope: {
    kind: "pin",
    pinId: "pin_fence",
    surface: "the refresh path keeps working",
    files: ["src/auth.ts"],
    missingFiles: [],
    rewrittenPaths: 0,
    rewrittenAt: null,
  },
  totals: { sessionsTouching: 1, sessionsScored: 1, windowDays: 14 },
  attribution: "sessions",
  candidates: [],
};

const A_VERDICT = {
  attribution: "INDETERMINATE",
  protection: "PROTECTED_CONFLICT",
  basis: "coverage_gap",
  falsifier: "recorded_break",
  behaviorDelta: "unconfirmed",
  deltaLane: "pin",
  deltaReason: "human_recheck_unrepeated",
  explanationTiming: "absent",
  timingReason: "no_intent",
  invariant: { pinId: "pin_fence", version: 1 },
  waiver: null,
  computedAt: "2026-07-24T09:00:00.000Z",
};

let body: unknown = SUSPECT_BODY;

const server = Bun.serve({
  port: 0,
  fetch: () => Response.json({ ok: true, data: body }),
});

afterAll(() => {
  server.stop(true);
});

const ctx = (): HubContext => ({
  hubUrl: `http://127.0.0.1:${String(server.port)}`,
  apiKey: "key",
  timeoutMs: 2000,
  home: "/tmp/does-not-exist",
  repoKey: "",
  now: () => new Date("2026-07-24T09:00:00.000Z"),
});

describe("a response with no verdict block", () => {
  test("reads as null — not as an invented INDETERMINATE", async () => {
    // Arrange: an un-upgraded 1.0 hub — a ranking, no verdict key at all
    body = SUSPECT_BODY;

    // Act
    const result = await getSuspect(ctx(), { repo: REPO });

    // Assert
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.verdict).toBeNull();
    // The rest of the answer survives: an absent verdict costs the
    // qualification, never the rows.
    expect(result.data.outcome).toBe("ranked");
  });

  test("a hub that DOES report is read as reported", async () => {
    // Arrange
    body = { ...SUSPECT_BODY, verdict: A_VERDICT };

    // Act
    const result = await getSuspect(ctx(), { repo: REPO });

    // Assert
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.verdict?.attribution).toBe("INDETERMINATE");
    expect(result.data.verdict?.basis).toBe("coverage_gap");
    expect(result.data.verdict?.invariant?.version).toBe(1);
  });
});

describe("parseVerdict fails to null, never to a fabricated verdict", () => {
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "ATTRIBUTED"],
    ["a number", 7],
    ["an empty object", {}],
  ] as const)("%s is null", (_label, raw) => {
    // Act & Assert
    expect(parseVerdict(raw)).toBeNull();
  });

  test("a block missing ONE of the four required words is null", () => {
    // Arrange — a verdict that cannot say what its basis is is not a partial
    // verdict, it is a different message. Reading it as one with blanks would
    // put this client's defaults on the hub's authority.
    const { basis: _dropped, ...withoutBasis } = A_VERDICT;

    // Act & Assert
    expect(parseVerdict(withoutBasis)).toBeNull();
  });

  test("a word this build has never heard of is KEPT, not rejected", () => {
    // Arrange — a hub newer than this binary. The renderer prints the word and
    // says it has no sentence for it; dropping the whole verdict would cost a
    // qualification the hub took the trouble to compute.
    const parsed = parseVerdict({ ...A_VERDICT, basis: "quantum_entangled" });

    // Assert
    expect(parsed?.basis).toBe("quantum_entangled");
  });

  test("a waiver with no reason keeps the waiver", () => {
    // Arrange — the fence is OPEN whether or not its sentence came along, and
    // dropping the waiver over a missing reason would report an open fence as
    // a closed one. That is the unsafe direction.
    const parsed = parseVerdict({
      ...A_VERDICT,
      protection: "protected_ok",
      waiver: {
        id: "fw_1",
        pinVersion: 1,
        expiresAt: "2026-07-25T09:00:00.000Z",
      },
    });

    // Assert
    expect(parsed?.waiver?.id).toBe("fw_1");
    expect(parsed?.waiver?.reason).toBe("");
  });
});

/**
 * ONE VOCABULARY, TWO PACKAGES — coverage-wire.test.ts's closing block, for
 * the same reason. The connector cannot import the hub, so these five enums
 * are declared twice, and that is exactly the drift 00 §9.6 forbids unless
 * something checks it. This is the something.
 */
describe("the wire vocabulary matches the hub's own", () => {
  test("all five verdict enums are identical to the hub's", () => {
    expect([...ATTRIBUTIONS]).toEqual([...hub.ATTRIBUTIONS]);
    expect([...PROTECTIONS]).toEqual([...hub.PROTECTIONS]);
    expect([...BEHAVIOR_DELTAS]).toEqual([...hub.BEHAVIOR_DELTAS]);
    expect([...VERDICT_FALSIFIERS]).toEqual([...hub.VERDICT_FALSIFIERS]);
    expect([...VERDICT_BASES]).toEqual([...hub.VERDICT_BASES]);
  });
});
