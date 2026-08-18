/**
 * The proxy log: observability that can never interfere. Every failure mode
 * here — unwritable home, stuck disk, oversized backlog — degrades to a
 * counter, never to a throw on the pump's path.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACP_LOG_DIR_NAME } from "../src/constants.ts";
import { createAcpLogger } from "../src/logger.ts";

const makeHome = (): Promise<string> => mkdtemp(join(tmpdir(), "acp-logger-"));

const FAKE_PID = 4242;

describe("log file lifecycle", () => {
  test("writes timestamped lines under <home>/logs/acp-<pid>.log", async () => {
    // Arrange
    const home = await makeHome();
    const logger = await createAcpLogger(home, FAKE_PID);

    // Act
    logger.line("start agent=[\"fake\"]");
    logger.line("exit code=0");
    await logger.flush();

    // Assert
    const content = await readFile(
      join(home, ACP_LOG_DIR_NAME, `acp-${FAKE_PID}.log`),
      "utf8",
    );
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("start agent=");
    expect(lines[1]).toContain("exit code=0");
    // ISO-8601 stamp leads every line.
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    expect(logger.writeFailures()).toBe(0);
  });

  test("rotates once past the size cap and keeps writing", async () => {
    // Arrange: a cap that holds the first two entries (~86 bytes each with
    // their timestamps) and rotates on the third.
    const home = await makeHome();
    const logger = await createAcpLogger(home, FAKE_PID, { maxBytes: 200 });

    // Act
    logger.line("a".repeat(60));
    logger.line("b".repeat(60));
    logger.line("after rotation");
    await logger.flush();

    // Assert: previous generation parked at .1, fresh log carries on.
    const dir = join(home, ACP_LOG_DIR_NAME);
    const names = await readdir(dir);
    expect(names).toContain(`acp-${FAKE_PID}.log`);
    expect(names).toContain(`acp-${FAKE_PID}.log.1`);
    const fresh = await readFile(join(dir, `acp-${FAKE_PID}.log`), "utf8");
    expect(fresh).toContain("after rotation");
    const rotated = await readFile(join(dir, `acp-${FAKE_PID}.log.1`), "utf8");
    expect(rotated).toContain("a".repeat(60));
  });

  test("a recycled pid's pre-existing log rotates aside instead of interleaving", async () => {
    // Arrange: a dead proxy's log under the SAME pid (pids recycle well
    // inside the 7-day sweep window).
    const home = await makeHome();
    const dir = join(home, ACP_LOG_DIR_NAME);
    const dead = await createAcpLogger(home, FAKE_PID);
    dead.line("dead proxy line");
    await dead.flush();

    // Act: the recycled pid's proxy starts a logger of its own.
    const logger = await createAcpLogger(home, FAKE_PID);
    logger.line("fresh proxy line");
    await logger.flush();

    // Assert: fresh file starts empty (size baseline intact), dead log kept.
    const fresh = await readFile(join(dir, `acp-${FAKE_PID}.log`), "utf8");
    expect(fresh).not.toContain("dead proxy line");
    expect(fresh).toContain("fresh proxy line");
    const parked = await readFile(join(dir, `acp-${FAKE_PID}.log.1`), "utf8");
    expect(parked).toContain("dead proxy line");
  });

  test("sweeps logs from dead proxies past the age cap, keeps young ones", async () => {
    // Arrange: one ancient log, one fresh log, one non-log bystander.
    const home = await makeHome();
    const dir = join(home, ACP_LOG_DIR_NAME);
    const logger0 = await createAcpLogger(home, 1);
    logger0.line("seed the dir");
    await logger0.flush();
    await writeFile(join(dir, "acp-999.log"), "ancient\n", "utf8");
    await writeFile(join(dir, "keep.txt"), "not a proxy log\n", "utf8");
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(join(dir, "acp-999.log"), ancient, ancient);

    // Act: a new proxy's logger construction runs the sweep.
    await createAcpLogger(home, FAKE_PID);

    // Assert
    const names = await readdir(dir);
    expect(names).not.toContain("acp-999.log");
    expect(names).toContain("keep.txt");
    expect(names).toContain("acp-1.log");
  });
});

describe("failure degrades to counters — never to a throw", () => {
  test("an unwritable home counts write failures and stays silent", async () => {
    // Arrange: a FILE where the logs directory should be.
    const home = await makeHome();
    await writeFile(join(home, ACP_LOG_DIR_NAME), "i am a file\n", "utf8");

    // Act
    const logger = await createAcpLogger(home, FAKE_PID);
    expect(() => {
      logger.line("this has nowhere to go");
    }).not.toThrow();
    await logger.flush();

    // Assert
    expect(logger.writeFailures()).toBeGreaterThan(0);
    expect((await stat(join(home, ACP_LOG_DIR_NAME))).isFile()).toBe(true);
  });

  test("a stuck append drops lines past the pending cap instead of buffering forever", async () => {
    // Arrange: an append that never resolves, and room for ~2 lines.
    const home = await makeHome();
    const logger = await createAcpLogger(home, FAKE_PID, {
      maxPendingBytes: 100,
      append: () => new Promise<void>(() => {}),
    });

    // Act
    logger.line("x".repeat(30));
    logger.line("y".repeat(30));
    logger.line("z".repeat(30));

    // Assert
    expect(logger.droppedLines()).toBeGreaterThan(0);
  });
});
