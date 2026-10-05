/**
 * §4.4: the `teammates:` block of `crosscheck status` holds its class against
 * every payload in every slot a teammate controls — display name, branch,
 * status and the session intent — in BOTH of its shapes: a single-topic
 * teammate's one line, and a multi-topic entry's head line, topic lines and
 * "… and N more topics" tail (connector-core briefing/topic-group.ts).
 *
 * The block is BARE class plus one framed fragment: name, branch and status
 * go through bareUntrusted, so none of them can mint a ` · ` field, and the
 * intent is the one « » pair a line may carry. Every line must be one of the
 * shapes the renderer means to emit — a payload never becomes a line of its
 * own.
 */
import { describe, expect, test } from "bun:test";

import type { PresenceEntry } from "@crosscheck/connector-core/http/hub.ts";

import { teammateLines } from "../src/cli/status.ts";
import { INJECTION_CORPUS } from "../../connector-core/test/fixtures/injection-corpus.ts";
import { assertUntrustedCharacters } from "../../connector-core/test/fixtures/untrusted-invariants.ts";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const secondsAgo = (seconds: number): string =>
  new Date(NOW.getTime() - seconds * 1000).toISOString();

type Slot = "name" | "branch" | "status" | "intent";
const SLOTS: readonly Slot[] = ["name", "branch", "status", "intent"];

/** One live session with the payload in `slot` and clean text everywhere else. */
const session = (
  slot: Slot,
  payload: string,
  index: number,
  developer: string,
  branch: string,
): PresenceEntry => ({
  sessionId: `cc_${developer}_${String(index)}`,
  developerId: `dev_${developer}`,
  developerName: slot === "name" ? payload : developer,
  branch: slot === "branch" ? payload : branch,
  status: slot === "status" ? payload : "implementing",
  lastHeartbeatAt: secondsAgo(5 + index),
  isSelf: false,
  intent: {
    summary: slot === "intent" ? payload : "Stop the rate limiter dropping bursts",
    provenance: "derived",
    confidence: 0.4,
    capturedAt: secondsAgo(5),
  },
});

/**
 * Robin: the payload on two sessions of one topic plus four clean branches —
 * more than an entry names, so the head line, the topic lines and the tail
 * all render even when the payload sanitizes to nothing. Mara: the payload on
 * her one session, the single-line shape.
 */
const render = (slot: Slot, payload: string): readonly string[] =>
  teammateLines(
    [
      session(slot, payload, 0, "robin", "feat/payload"),
      session(slot, payload, 1, "robin", "feat/payload"),
      ...["feat/a", "feat/b", "feat/c", "feat/d"].map((branch, index) =>
        session("intent", "clean", index + 2, "robin", branch),
      ),
      session(slot, payload, 9, "mara", "feat/mara"),
    ],
    NOW,
  );

/** The four shapes the block emits. Bare fields carry no `·`, `«` or `»`. */
const SINGLE_LINE =
  /^  - [^·«»]+(?: · [^·«»]*){2}(?: · \d+ sessions)?(?: · intent(?: \(derived\))?: «[^«»]*»)?$/;
const HEAD_LINE = /^  - [^·«»]+ · \d+ topics?, \d+ sessions?$/;
const TOPIC_LINE =
  /^    [^·«»]*(?: · [^·«»]*)(?: · \d+ sessions)?(?: · intent(?: \(derived\))?: «[^«»]*»)?$/;
const TAIL_LINE = /^    … and \d+ more topics?$/;

describe("§4.4: the status teammates block holds its class against every payload", () => {
  test("there are payloads to run — the corpus cannot be hollowed out", () => {
    expect(INJECTION_CORPUS.length).toBeGreaterThanOrEqual(60);
  });

  test.each(
    INJECTION_CORPUS.flatMap((entry) =>
      SLOTS.map((slot) => [`${entry.id}/${slot}`, slot, entry.payload] as const),
    ),
  )("%s is printed in the block's own shapes", (where, slot, payload) => {
    const lines = render(slot, payload);

    // The multi-topic shape really rendered — a walker that never met it
    // would pass vacuously.
    expect(lines.some((line) => HEAD_LINE.test(line)), where).toBe(true);
    expect(lines.some((line) => TAIL_LINE.test(line)), where).toBe(true);
    for (const line of lines) {
      assertUntrustedCharacters(line, where);
      expect(
        SINGLE_LINE.test(line) ||
          HEAD_LINE.test(line) ||
          TOPIC_LINE.test(line) ||
          TAIL_LINE.test(line),
        `${where}: ${JSON.stringify(line)}`,
      ).toBe(true);
    }
  });
});
