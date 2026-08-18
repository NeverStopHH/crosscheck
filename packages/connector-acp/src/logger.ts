/**
 * The per-proxy log file: `<home>/logs/acp-<pid>.log` (§2.2 — proxy logging
 * goes HERE, never to the stdio the protocol owns). Observability that can
 * never interfere, mechanically:
 *
 *   - writes ride a serialized promise chain off the hot path — `line()`
 *     itself never awaits and never throws;
 *   - a stuck disk is bounded by the pending-bytes cap: past it, lines are
 *     dropped and counted;
 *   - any write failure is a counter, and `flush()` swallows the chain's
 *     rejection — the caller can always await it;
 *   - size is bounded by one rotation to `<log>.1`, age by a startup sweep
 *     of dead proxies' logs.
 */
import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  HOME_DIR_MODE,
  MS_PER_DAY,
  PRIVATE_FILE_MODE,
} from "@crosscheck/connector-core/constants.ts";

import {
  ACP_LOG_DIR_NAME,
  ACP_LOG_MAX_AGE_DAYS,
  ACP_LOG_MAX_BYTES,
  ACP_OBS_MAX_PENDING_BYTES,
} from "./constants.ts";

export type AppendImpl = (path: string, data: string) => Promise<void>;

export interface AcpLoggerLimits {
  readonly maxBytes?: number;
  readonly maxAgeDays?: number;
  readonly maxPendingBytes?: number;
  /** Test seam: a stuck or failing disk, injected deterministically. */
  readonly append?: AppendImpl;
}

export interface AcpLogger {
  readonly path: string;
  line(text: string): void;
  writeFailures(): number;
  droppedLines(): number;
  flush(): Promise<void>;
}

/** `acp-<pid>.log` and its one rotated generation. */
const LOG_FILE_PATTERN = /^acp-\d+\.log(\.1)?$/;

const sweepOldLogs = async (
  dir: string,
  maxAgeDays: number,
  now: number,
): Promise<void> => {
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch {
    return; // fail open — a log dir we cannot list is a log we do without
  }
  for (const name of names) {
    if (!LOG_FILE_PATTERN.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > maxAgeDays * MS_PER_DAY) {
        await unlink(path);
      }
    } catch {
      // fail open — racing another proxy's sweep is fine
    }
  }
};

const defaultAppend: AppendImpl = (path, data) =>
  appendFile(path, data, { mode: PRIVATE_FILE_MODE });

export const createAcpLogger = async (
  home: string,
  pid: number,
  limits: AcpLoggerLimits = {},
): Promise<AcpLogger> => {
  const maxBytes = limits.maxBytes ?? ACP_LOG_MAX_BYTES;
  const maxPending = limits.maxPendingBytes ?? ACP_OBS_MAX_PENDING_BYTES;
  const append = limits.append ?? defaultAppend;
  const dir = join(home, ACP_LOG_DIR_NAME);
  const path = join(dir, `acp-${pid}.log`);

  let usable = true;
  try {
    await mkdir(dir, { recursive: true, mode: HOME_DIR_MODE });
  } catch {
    usable = false; // every line() becomes a counted failure, never a throw
  }
  if (usable) {
    await sweepOldLogs(dir, limits.maxAgeDays ?? ACP_LOG_MAX_AGE_DAYS, Date.now());
    try {
      // Pids recycle well inside the sweep window: park a dead proxy's
      // same-pid log as `.1` so this proxy neither interleaves with it nor
      // starts its size baseline against a file it never measured.
      await rename(path, `${path}.1`);
    } catch {
      // no pre-existing log — the common case
    }
  }

  let chain: Promise<void> = Promise.resolve();
  let pendingBytes = 0;
  let size = 0;
  let failures = 0;
  let dropped = 0;

  return {
    path,
    line(text) {
      if (!usable) {
        failures += 1;
        return;
      }
      const entry = `${new Date().toISOString()} ${text}\n`;
      if (pendingBytes + entry.length > maxPending) {
        dropped += 1;
        return;
      }
      pendingBytes += entry.length;
      chain = chain
        .then(async () => {
          if (size + entry.length > maxBytes) {
            try {
              await rename(path, `${path}.1`);
            } catch {
              // nothing to rotate — the append below starts a fresh file
            }
            size = 0;
          }
          await append(path, entry);
          size += entry.length;
        })
        .catch(() => {
          failures += 1;
        })
        .finally(() => {
          pendingBytes -= entry.length;
        });
    },
    writeFailures: () => failures,
    droppedLines: () => dropped,
    flush: () => chain.then(
      () => undefined,
      () => undefined,
    ),
  };
};
