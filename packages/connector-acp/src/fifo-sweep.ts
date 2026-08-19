/**
 * Startup reaper for FIFO temp dirs leaked by ABNORMALLY dead proxies.
 * cleanupFifos (proxy.ts) removes the dir on every in-process exit path,
 * but nothing in-process survives SIGKILL, OOM-kill or power loss — each
 * such death leaks one `crosscheck-acp-fifo-*` dir holding two named
 * pipes, forever, on any /tmp the OS does not reap. So each proxy start
 * sweeps aged remains, exactly as the logger sweeps dead proxies' logs
 * (logger.ts sweepOldLogs).
 *
 * Three gates keep it structurally harmless:
 *   - prefix (ACP_FIFO_DIR_PREFIX is used by nothing else — the sweep
 *     cannot name any other family's temp artifacts);
 *   - age (a live editor session legitimately holds its dir for days;
 *     and even sweeping a LIVE aged dir cannot break its wire — both FIFO
 *     ends were opened at startup and open fds survive the unlink);
 *   - dirs only.
 * Every step fails open: a sweep that cannot run costs tmp cleanliness,
 * never the session.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { MS_PER_DAY } from "@crosscheck/connector-core/constants.ts";

import { ACP_FIFO_DIR_PREFIX } from "./constants.ts";

export const sweepStaleFifoDirs = async (
  tmpRoot: string,
  maxAgeDays: number,
  now: number,
): Promise<void> => {
  let names: readonly string[];
  try {
    names = await readdir(tmpRoot);
  } catch {
    return; // fail open — a tmp root we cannot list is a sweep we do without
  }
  for (const name of names) {
    if (!name.startsWith(ACP_FIFO_DIR_PREFIX)) continue;
    const path = join(tmpRoot, name);
    try {
      const info = await stat(path);
      if (!info.isDirectory()) continue;
      if (now - info.mtimeMs > maxAgeDays * MS_PER_DAY) {
        await rm(path, { recursive: true, force: true });
      }
    } catch {
      // fail open — racing another proxy's sweep is fine
    }
  }
};
