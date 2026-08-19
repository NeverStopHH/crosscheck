/**
 * The byte pump — the forward path, and the structural home of Block 3's
 * prime directive (design verdict 2): the proxy must NEVER be able to kill a
 * session. Enforced by shape, not by care:
 *
 *   1. The sink gets the ORIGINAL buffer, first, before anything else looks
 *      at the chunk (§2.3 rules 1 + 2). No re-serialization exists here.
 *   2. The observer gets a COPY, after, inside a catch-all — a throwing
 *      observer is a counter, never a broken pipe, and a mutating observer
 *      corrupts only its own copy. The copy lives in ONE reused scratch
 *      buffer: a flood must not become a garbage-collection bill, so the
 *      observer's contract is that its view is valid only until it returns.
 *   3. Awaiting the sink's write before the next read is the whole
 *      backpressure story: the pump holds at most one chunk in flight, so a
 *      slow reader stalls the writer instead of growing the proxy
 *      (test/backpressure.test.ts measures exactly that on the spawned
 *      binary).
 *
 * THE CHUNK CONTRACT both sides obey: a source may reuse its buffer once
 * the sink's write has resolved (fd-io.ts does), so a sink must have
 * consumed or copied the chunk BY resolution (kernel writes and
 * synchronous copies do; anything that queues a reference must copy).
 *
 * Failures are RETURNED, never thrown: the proxy decides what a dead peer
 * means; the pump only reports it.
 */

export interface ByteSink {
  /**
   * Returns a promise while the sink is applying backpressure. The chunk
   * is only guaranteed valid until that promise resolves.
   */
  write(chunk: Uint8Array): void | Promise<void>;
}

/** The copy handed here is valid for the duration of the call only. */
export type ChunkObserver = (copy: Uint8Array) => void;

export interface PumpOutcome {
  readonly bytesForwarded: number;
  /** Observer throws, swallowed on the copy path — the prime directive. */
  readonly observerErrors: number;
  /** Set when the sink refused a chunk (peer hangup); the pump stopped there. */
  readonly writeError: unknown;
  /** Set when the source stream itself failed (rare; EOF is not an error). */
  readonly sourceError: unknown;
}

interface MutableCounters {
  bytesForwarded: number;
  observerErrors: number;
}

/** No observer failure may reach the forward path — count it, move on. */
const observeSafely = (
  observe: ChunkObserver,
  copy: Uint8Array,
  counters: MutableCounters,
): void => {
  try {
    observe(copy);
  } catch {
    counters.observerErrors += 1;
  }
};

export const pumpBytes = async (
  source: AsyncIterable<Uint8Array>,
  sink: ByteSink,
  observe?: ChunkObserver,
): Promise<PumpOutcome> => {
  const counters: MutableCounters = { bytesForwarded: 0, observerErrors: 0 };
  let scratch = new Uint8Array(0);
  let writeError: unknown;
  let sourceError: unknown;
  try {
    for await (const chunk of source) {
      let started: void | Promise<void>;
      try {
        started = sink.write(chunk); // forward FIRST, the ORIGINAL bytes
      } catch (error) {
        writeError = error;
        break;
      }
      if (observe !== undefined) {
        // The parse layer's COPY, synchronous while the chunk is valid.
        // Deliberately not `chunk.slice()`: Buffer overrides slice() to
        // return a VIEW, and the real wire carries Buffers.
        if (scratch.byteLength < chunk.byteLength) {
          scratch = new Uint8Array(chunk.byteLength);
        }
        const copy = scratch.subarray(0, chunk.byteLength);
        copy.set(chunk);
        observeSafely(observe, copy, counters);
      }
      if (started instanceof Promise) {
        try {
          await started; // backpressure: one chunk in flight, never more
        } catch (error) {
          writeError = error;
          break;
        }
      }
      counters.bytesForwarded += chunk.byteLength;
    }
  } catch (error) {
    sourceError = error;
  }
  return {
    bytesForwarded: counters.bytesForwarded,
    observerErrors: counters.observerErrors,
    writeError,
    sourceError,
  };
};
