/**
 * `--record`: the parsed-copy stream, appended as NDJSON — one entry per
 * observed wire line, direction and parse verdict included. It exists for
 * Block-4 capture development and per-agent capture-quality measurement
 * (design §6 open question 1), and for turning real transcripts into golden
 * fixtures (§4.2 layer 3).
 *
 * Same non-interference mechanics as the logger: serialized chain, pending
 * cap, failures become drop counts. One difference: the first failed write
 * DISABLES the recorder — a recording with a silent hole in the middle
 * would lie to the capture-quality measurement, so once integrity is gone,
 * everything after is counted instead of written.
 */
import { appendFile } from "node:fs/promises";

import { PRIVATE_FILE_MODE } from "@crosscheck/connector-core/constants.ts";

import { ACP_OBS_MAX_PENDING_BYTES } from "./constants.ts";
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
  const maxPending = limits.maxPendingBytes ?? ACP_OBS_MAX_PENDING_BYTES;
  const append = limits.append ?? defaultAppend;

  let chain: Promise<void> = Promise.resolve();
  let pendingBytes = 0;
  let drops = 0;
  let disabled = false;

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
      const data = `${JSON.stringify(entry)}\n`;
      if (pendingBytes + data.length > maxPending) {
        drops += 1;
        return;
      }
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
    },
    drops: () => drops,
    flush: () => chain.then(
      () => undefined,
      () => undefined,
    ),
  };
};
