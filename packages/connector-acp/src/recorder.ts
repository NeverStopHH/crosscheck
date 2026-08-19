/**
 * `--record`: the parsed-copy stream, appended as NDJSON — one entry per
 * observed wire line, direction and parse verdict included. It exists for
 * Block-4 capture development and per-agent capture-quality measurement
 * (design §6 open question 1), and for turning real transcripts into golden
 * fixtures (§4.2 layer 3).
 *
 * Same non-interference mechanics as the logger: serialized chain, pending
 * cap, failures become drop counts. Two differences, both for the same
 * reason — a recording with a SILENT hole in the middle would lie to the
 * capture-quality measurement:
 *
 *   - the first failed WRITE disables the recorder: once integrity is
 *     gone, everything after is counted instead of written (the file ends
 *     in a clean truncation, never a scattered hole);
 *   - a PENDING-CAP drop (stuck/slow disk during a burst) is marked
 *     in-band: the next write is preceded by a `{t, gap: <n>}` entry, and
 *     flush() appends a trailing marker for drops still unmarked — the
 *     transcript always says where and how many lines are missing, and the
 *     log's record-drops counter carries the same total.
 *
 * The pending cap is ACP_RECORD_MAX_PENDING_BYTES — larger than the
 * logger's on purpose (see the constant: worst-case JSON escaping is 6x
 * the wire line, and a line the observer can emit must fit on an idle
 * disk).
 */
import { appendFile } from "node:fs/promises";

import { PRIVATE_FILE_MODE } from "@crosscheck/connector-core/constants.ts";

import { ACP_RECORD_MAX_PENDING_BYTES } from "./constants.ts";
import type { ObservedLine } from "./observer.ts";
import type { AppendImpl } from "./logger.ts";

export type RecordDirection = "c2a" | "a2c";

export interface AcpRecorderLimits {
  readonly maxPendingBytes?: number;
  /** Test seam: a stuck or failing disk, injected deterministically. */
  readonly append?: AppendImpl;
}

export interface AcpRecorder {
  readonly path: string;
  record(direction: RecordDirection, event: ObservedLine, at: number): void;
  drops(): number;
  flush(): Promise<void>;
}

const defaultAppend: AppendImpl = (path, data) =>
  appendFile(path, data, { mode: PRIVATE_FILE_MODE });

export const createAcpRecorder = (
  path: string,
  limits: AcpRecorderLimits = {},
): AcpRecorder => {
  const maxPending = limits.maxPendingBytes ?? ACP_RECORD_MAX_PENDING_BYTES;
  const append = limits.append ?? defaultAppend;

  let chain: Promise<void> = Promise.resolve();
  let pendingBytes = 0;
  let drops = 0;
  /** Pending-cap drops since the last enqueued write — owed a gap marker. */
  let unmarkedGap = 0;
  let disabled = false;

  const enqueue = (data: string): void => {
    pendingBytes += data.length;
    chain = chain
      .then(() => append(path, data))
      .catch(() => {
        drops += 1;
        disabled = true;
      })
      .finally(() => {
        pendingBytes -= data.length;
      });
  };

  return {
    path,
    record(direction, event, at) {
      if (disabled) {
        drops += 1;
        return;
      }
      const entry =
        event.kind === "oversized"
          ? { t: at, dir: direction, oversized: event.bytes }
          : {
              t: at,
              dir: direction,
              line: event.text,
              parsed: event.parsedOk,
              ...(event.atEof ? { eof: true } : {}),
            };
      const gapMarker =
        unmarkedGap > 0 ? `${JSON.stringify({ t: at, gap: unmarkedGap })}\n` : "";
      const data = `${gapMarker}${JSON.stringify(entry)}\n`;
      if (pendingBytes + data.length > maxPending) {
        drops += 1;
        unmarkedGap += 1;
        return;
      }
      unmarkedGap = 0;
      enqueue(data);
    },
    drops: () => drops,
    flush: () => {
      if (unmarkedGap > 0 && !disabled) {
        // Trailing drops would otherwise leave the recording's END silent.
        enqueue(`${JSON.stringify({ t: Date.now(), gap: unmarkedGap })}\n`);
        unmarkedGap = 0;
      }
      return chain.then(
        () => undefined,
        () => undefined,
      );
    },
  };
};
