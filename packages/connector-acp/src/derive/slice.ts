/**
 * THE TIER-1 TURN SLICE, ACCUMULATED IN MEMORY AND NEVER WRITTEN DOWN.
 *
 * Claude reads a JSONL transcript by byte range; Cursor reads a file whose
 * format it does not document. The ACP proxy has neither and needs neither:
 * it is a LONG-LIVED process sitting beside the wire, so it can keep the
 * current turn's text in memory and hand it to a spawned worker on stdin.
 * That is strictly stronger than both siblings — no transcript file is read,
 * and no slice artifact is ever created on disk.
 *
 * WHAT GOES IN, and why exactly this. Everything here comes from the parse
 * COPY the observer hands the capture engine, never from the forward path:
 *
 *   1. `agent_message_chunk` text — what the agent said this turn;
 *   2. the failure text of a FAILED tool call's `rawOutput` — the same
 *      extractor the fingerprint row uses, so a slice and a fingerprint
 *      never disagree about what the failure was;
 *   3. terminal output tails — what actually ran.
 *
 * WHAT IS NOT IN IT, and why that makes the rung REDUCED rather than full:
 * terminal COMMAND text, diff bodies and fs write content are modelled by no
 * schema in wire/v1.ts, so the slice cannot contain them even by accident.
 * The visible consequence is exact and worth stating rather than discovering:
 * the conclusion gate's `hasCommitBoundary` anchor looks for `git commit` as
 * a command, and on this host it can only ever match if the agent SAYS it in
 * prose. An agent that does its tool I/O outside ACP's `terminal/*` methods
 * gives a prose-only slice. That is a real precision loss and `acp-report`
 * prints which of the three sources a recorded agent actually emits.
 *
 * BOUNDED, AND THE BOUND DROPS RATHER THAN GROWS. A hostile or merely chatty
 * agent streaming message chunks is a flood surface, and this is the
 * fitSessions lesson in a new place: past ACP_TURN_SLICE_MAX_CHARS the
 * accumulator keeps what it has, counts the dropped characters, and stops
 * growing. The dropped count is not decorative — the gate reads the slice it
 * was given, so a turn whose conclusion arrived after the cap is a MISS, and
 * the number is what makes that explainable instead of mysterious.
 */
import {
  ACP_MAX_SLICE_SESSIONS,
  ACP_TURN_SLICE_MAX_CHARS,
} from "../constants.ts";

export interface TurnSlice {
  /** Append one source's text; over the cap it is dropped and counted. */
  add(text: string): void;
  /** The slice as the gate and the worker see it. */
  text(): string;
  /** Characters this turn's accumulator refused to hold. */
  dropped(): number;
}

const createTurnSlice = (): TurnSlice => {
  const parts: string[] = [];
  let length = 0;
  let droppedChars = 0;
  return {
    add(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }
      // THE SEPARATOR COUNTS. `text()` joins the parts with a newline, so a
      // budget that tracked only the pieces was not a budget on the string
      // this actually produces: an agent streaming ONE CHARACTER per message
      // chunk filled 47,999 characters against a 24,000 cap (measured), the
      // separators doubling it exactly. Charging the newline at append time
      // makes `text().length` equal `length`, so the cap is a cap whatever
      // shape the wire arrives in.
      const separator = parts.length === 0 ? 0 : 1;
      const room = ACP_TURN_SLICE_MAX_CHARS - length - separator;
      if (room <= 0) {
        droppedChars += trimmed.length;
        return;
      }
      if (trimmed.length > room) {
        // Keep the HEAD of the overflowing piece rather than nothing: a
        // partial source is still evidence, and the count says how much was
        // refused. Never a slice bigger than the cap, whatever arrives.
        parts.push(trimmed.slice(0, room));
        length = ACP_TURN_SLICE_MAX_CHARS;
        droppedChars += trimmed.length - room;
        return;
      }
      parts.push(trimmed);
      length += trimmed.length + separator;
    },
    text() {
      return parts.join("\n");
    },
    dropped() {
      return droppedChars;
    },
  };
};

/**
 * One accumulator per live session, bounded FIFO — the terminal map's shape.
 * A client opening sessions without bound costs capture accuracy on the
 * oldest ones, never memory.
 */
export interface TurnSliceStore {
  /** The session's slice, created on first use. */
  for(sessionId: string): TurnSlice;
  /** A new turn starts: whatever the last one accumulated is gone. */
  reset(sessionId: string): void;
  /** The session ended: drop its accumulator outright. */
  forget(sessionId: string): void;
}

export const createTurnSliceStore = (): TurnSliceStore => {
  const slices = new Map<string, TurnSlice>();
  const evictOldest = (): void => {
    while (slices.size >= ACP_MAX_SLICE_SESSIONS) {
      const oldest = slices.keys().next();
      if (oldest.done) {
        return;
      }
      slices.delete(oldest.value);
    }
  };
  /**
   * Replace one session's accumulator, evicting ONLY to make room for a key
   * the map does not already hold.
   *
   * The eviction guard is not defensive noise. Resetting unconditionally
   * evicts on every turn boundary once the map is full — and the victim is
   * the OLDEST entry, which is some other live session, not this one. On a
   * busy proxy that silently threw away a neighbour's accumulated turn every
   * time anybody started a prompt, costing capture accuracy with nothing
   * counted anywhere. Replacing an existing key changes the map's size by
   * zero and must therefore evict nothing.
   */
  const put = (sessionId: string): TurnSlice => {
    if (!slices.has(sessionId)) {
      evictOldest();
    }
    const fresh = createTurnSlice();
    slices.set(sessionId, fresh);
    return fresh;
  };
  return {
    for(sessionId) {
      return slices.get(sessionId) ?? put(sessionId);
    },
    reset(sessionId) {
      put(sessionId);
    },
    forget(sessionId) {
      slices.delete(sessionId);
    },
  };
};
