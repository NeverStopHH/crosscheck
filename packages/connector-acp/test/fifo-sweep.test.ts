/**
 * The FIFO-dir reaper: cleanupFifos covers every in-process exit path, but
 * nothing in-process survives SIGKILL/OOM/power loss — each abnormal death
 * leaks one temp dir holding two named pipes, forever, on any /tmp the OS
 * does not reap. So proxy startup sweeps aged remains, exactly as the
 * logger sweeps dead proxies' logs. Prefix-gated AND age-gated AND
 * dirs-only: the sweep must never touch a live proxy's fresh dir, another
 * family's temp files, or anything that merely shares the tmpdir.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACP_FIFO_DIR_PREFIX, ACP_LOG_MAX_AGE_DAYS } from "../src/constants.ts";
import { sweepStaleFifoDirs } from "../src/fifo-sweep.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_AGE_DAYS = ACP_LOG_MAX_AGE_DAYS + 1;

const makeRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "acp-fifo-sweep-"));

const ageInPlace = async (path: string, days: number): Promise<void> => {
  const then = new Date(Date.now() - days * MS_PER_DAY);
  await utimes(path, then, then);
};

describe("stale FIFO dir sweep", () => {
  test("removes aged prefix-matching dirs, keeps fresh ones and bystanders", async () => {
    // Arrange: one stale leak, one live proxy's fresh dir, one aged dir of
    // another family, one aged FILE that happens to share the prefix.
    const root = await makeRoot();
    const stale = join(root, `${ACP_FIFO_DIR_PREFIX}stale`);
    const fresh = join(root, `${ACP_FIFO_DIR_PREFIX}fresh`);
    const bystander = join(root, "crosscheck-acp-temphome");
    const prefixedFile = join(root, `${ACP_FIFO_DIR_PREFIX}file`);
    await mkdir(stale);
    await mkdir(fresh);
    await mkdir(bystander);
    await writeFile(prefixedFile, "not a dir\n", "utf8");
    await ageInPlace(stale, STALE_AGE_DAYS);
    await ageInPlace(bystander, STALE_AGE_DAYS);
    await ageInPlace(prefixedFile, STALE_AGE_DAYS);

    // Act
    await sweepStaleFifoDirs(root, ACP_LOG_MAX_AGE_DAYS, Date.now());

    // Assert
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(bystander)).toBe(true);
    expect(existsSync(prefixedFile)).toBe(true);
  });

  test("an unlistable root is a no-op, never a throw", async () => {
    await expect(
      sweepStaleFifoDirs(join(await makeRoot(), "does-not-exist"), ACP_LOG_MAX_AGE_DAYS, Date.now()),
    ).resolves.toBeUndefined();
  });
});
