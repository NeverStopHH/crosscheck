/**
 * A `SessionSpool` has to describe ONE file.
 *
 * `readSessionSpool` reports content, a cursor offset and an identity (inode,
 * first-line hash, size, mtime) as a single value, and its callers combine
 * fields that came from different reads: `reapSlug` computes
 * `isDelivered = size > 0 && offset >= size` from two of them, and unlinks the
 * file when it is true. If those two fields can come from two different files,
 * that arithmetic is meaningless and the unlink destroys undelivered records.
 *
 * The interleaving is `reap` unlinking a data file while an appender recreates
 * it at the same path. The readers that can be in the middle of it are `flush`
 * and `reap` themselves, plus three that take no lock at all
 * (hooks/session-end.ts, cli/status.ts and cli/doctor.ts through `spoolDepth`).
 *
 * This does not test WHETHER the swap happens. It tests that no swap, at any
 * point, can make one returned value contradict itself. Every contradiction
 * below is visible in the returned object alone — no knowledge of the race is
 * needed to see that the answer is wrong.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { repoKey } from "../src/index.ts";
import {
  spoolCursorPath,
  spoolDataPath,
  spoolDir,
} from "../src/config/paths.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import { readFileFacts } from "../src/spool/identity.ts";
import { byteLength } from "../src/spool/lines.ts";
import { makeHome } from "./helpers.ts";

const HUB_URL = "http://127.0.0.1:9";
const REPO_ID = "github.com/acme/api";
const KEY = repoKey(HUB_URL, REPO_ID);
const SLUG = "read-tear-session";

/**
 * Trial count, sized from the hit rate this test showed against the code as it
 * stood BEFORE the fix, rather than guessed.
 *
 * HISTORICAL — the figures below cannot be reproduced from this tree, because
 * the three-reads version of `readSessionSpool` they describe is gone. Against
 * it, this test counted 624 contradictions in 4000 trials on macOS (APFS) and
 * 16 in 4000 on Linux (overlayfs, 2 cpus). Eight thousand keeps the slower of
 * the two platforms roughly two orders of magnitude clear of a lucky zero, and
 * costs about a second.
 *
 * What IS re-runnable is the assertion, which must find none:
 * VERIFY: bun test test/spool-read-tear.test.ts 2>&1 | grep -c '^(fail)'
 * PRINTS: 0
 */
const TRIALS = 8000;

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
  homes.length = 0;
});

const record = (tag: string, index: number): string =>
  JSON.stringify({
    cx: "0.1",
    id: `env_${tag}_${index}`,
    ts: "2026-07-28T00:00:00.000Z",
    producer: {
      developerId: "unknown",
      agentKind: "claude-code",
      sessionId: "cc_old",
    },
    kind: "target",
    body: { workContextId: "wc_1", kind: "file", value: `src/${tag}-${index}.ts` },
  });

/** Two files of very different size, so a mismatch between them is unmistakable. */
const BIG = `${Array.from({ length: 60 }, (_, index) => record("big", index)).join("\n")}\n`;
const SMALL = `${record("small", 0)}\n`;

describe("readSessionSpool returns one file, not a blend of two", () => {
  test("no swap under a reader can make the spool it returns contradict itself", async () => {
    // Arrange: BIG on disk with a cursor that legitimately says every byte of
    // BIG has been delivered. That is the cursor `reap` reads as "safe to
    // unlink", and the whole question is which FILE it gets paired with.
    const path = await makeHome("read-tear");
    homes.push(path);
    const dataPath = spoolDataPath(path, KEY, SLUG);
    const cursorPath = spoolCursorPath(path, KEY, SLUG);
    await mkdir(spoolDir(path, KEY), { recursive: true });

    const plantBigAndItsCursor = async (): Promise<void> => {
      await writeFile(dataPath, BIG, "utf8");
      const facts = await readFileFacts(dataPath);
      if (facts === null) {
        return;
      }
      await writeFile(
        cursorPath,
        `${JSON.stringify({ ino: facts.ino, firstLine: facts.firstLine, offset: facts.size })}\n`,
        "utf8",
      );
    };

    await plantBigAndItsCursor();
    const bigFacts = await readFileFacts(dataPath);
    await writeFile(dataPath, SMALL, "utf8");
    const smallFacts = await readFileFacts(dataPath);
    await plantBigAndItsCursor();

    // The unlink-and-recreate that `reap` and a lock-free append produce between
    // them, run continuously so the reader below meets it at every phase.
    let running = true;
    const swapping = (async (): Promise<void> => {
      while (running) {
        await rm(dataPath, { force: true });
        await writeFile(dataPath, SMALL, "utf8");
        await rm(dataPath, { force: true });
        await plantBigAndItsCursor();
      }
    })();

    // Act
    let offsetExceedsSize = 0;
    let pendingExceedsSize = 0;
    let contentVsIdentity = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const spool = await readSessionSpool(path, KEY, SLUG);
      const first = spool.lines[0];
      const tag =
        first === undefined
          ? null
          : (JSON.parse(first) as { id: string }).id.split("_")[1];

      // An offset past the end of the file it is reported with. `reapSlug`
      // reads exactly this pair as "delivered in full".
      if (spool.size > 0 && spool.offset > spool.size) {
        offsetExceedsSize += 1;
      }
      // More bytes claimed as pending than the named file physically holds.
      if (spool.size > 0 && spool.offset + byteLength(spool.pending) > spool.size) {
        pendingExceedsSize += 1;
      }
      // The records reported are one file's, the identity reported is the other's.
      const identityIsBig = spool.firstLine === bigFacts?.firstLine;
      const identityIsSmall = spool.firstLine === smallFacts?.firstLine;
      if ((tag === "big" && identityIsSmall) || (tag === "small" && identityIsBig)) {
        contentVsIdentity += 1;
      }
    }
    running = false;
    await swapping;

    // Assert
    expect({
      offsetExceedsSize,
      pendingExceedsSize,
      contentVsIdentity,
    }).toEqual({
      offsetExceedsSize: 0,
      pendingExceedsSize: 0,
      contentVsIdentity: 0,
    });
  });
});
