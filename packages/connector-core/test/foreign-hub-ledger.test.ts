/**
 * THE FOREIGN-HUB REFUSAL LEDGER (state/foreign-hub.ts): counted once per
 * (session, foreign origin), pruned by age, compacted at the cap with a floor
 * marker that ages out too, read inside a window bounded on both sides, and
 * every origin read back re-screened. Each test is one bound a mutation of
 * the review (M1-M5) showed was untested.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAX_FOREIGN_HUB_LEDGER_BYTES } from "../src/constants.ts";
import type { ForeignHub } from "../src/config/key-binding.ts";
import { ensureDir } from "../src/config/paths.ts";
import {
  foreignHubLedgerPath,
  formatForeignHubCount,
  readForeignHubRefusals,
  recordForeignHubRefusal,
} from "../src/state/foreign-hub.ts";
import { makeHome } from "./helpers.ts";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const DAY_MS = 86_400_000;
const FOREIGN: ForeignHub = {
  hubOrigin: "http://evil.example:7100",
  keyOrigin: "http://hub.example:7100",
  hubSource: "repo",
  keySource: "login",
};

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  homes.length = 0;
});

const makeLedgerHome = async (): Promise<string> => {
  const path = await makeHome("foreign-hub-ledger");
  homes.push(path);
  return path;
};

interface RefuseOptions {
  readonly repoId?: string;
  readonly foreignHub?: ForeignHub;
  readonly now?: Date;
}

const refuse = (home: string, sessionKey: string, options: RefuseOptions = {}): Promise<void> =>
  recordForeignHubRefusal(home, {
    repoId: options.repoId ?? "github.com/acme/api",
    foreignHub: options.foreignHub ?? FOREIGN,
    surface: "session-start",
    sessionKey,
    now: options.now ?? NOW,
  });

const ledgerLines = async (home: string): Promise<readonly Record<string, unknown>[]> =>
  (await readFile(foreignHubLedgerPath(home), "utf8"))
    .trim()
    .split("\n")
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);

const writeLedger = async (home: string, entries: readonly Record<string, unknown>[]): Promise<void> => {
  await ensureDir(join(home, "state"));
  await writeFile(foreignHubLedgerPath(home), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
};

const lineAt = (at: Date, hub: string, session: string): Record<string, unknown> => ({
  at: at.toISOString(),
  repo: "github.com/acme/api",
  hub,
  key: "http://hub.example:7100",
  surface: "session-start",
  session,
});

describe("one line per refused session", () => {
  test("a session refused on every hook is counted once; a second session and a second hub are not merged", async () => {
    // Arrange
    const home = await makeLedgerHome();

    // Act
    await refuse(home, "session-a");
    await refuse(home, "session-a");
    await refuse(home, "session-a");
    await refuse(home, "session-b");
    await refuse(home, "session-a", { foreignHub: { ...FOREIGN, hubOrigin: "http://other.example:7100" } });

    // Assert
    expect(await ledgerLines(home)).toHaveLength(3);
    const ledger = await readForeignHubRefusals(home, NOW);
    expect(ledger.groups.map((group) => [group.hubOrigin, group.count])).toEqual(
      expect.arrayContaining([
        ["http://evil.example:7100", 2],
        ["http://other.example:7100", 1],
      ]),
    );
    expect(await readFile(foreignHubLedgerPath(home), "utf8")).not.toContain("session-a");
  });
});

describe("pruned by age", () => {
  test("a write drops what has left the window, and a new bait repo is still recorded", async () => {
    // Arrange — a refusal from eight days ago
    const home = await makeLedgerHome();
    await refuse(home, "old-session", { now: new Date(NOW.getTime() - 8 * DAY_MS), repoId: "github.com/old/bait" });

    // Act
    await refuse(home, "new-session", { repoId: "github.com/new/bait" });

    // Assert
    expect((await ledgerLines(home)).map((entry) => entry["repo"])).toEqual(["github.com/new/bait"]);
  });
});

describe("the read window", () => {
  test("is bounded on both sides: an old line and a future line do not count", async () => {
    // Arrange — written by hand, as a file left by an older run would be
    const home = await makeLedgerHome();
    await writeLedger(home, [
      lineAt(new Date(NOW.getTime() - 8 * DAY_MS), "http://evil.example:7100", "0000000000000001"),
      lineAt(new Date(NOW.getTime() - DAY_MS), "http://evil.example:7100", "0000000000000002"),
      lineAt(new Date(NOW.getTime() + DAY_MS), "http://evil.example:7100", "0000000000000003"),
    ]);

    // Act
    const ledger = await readForeignHubRefusals(home, NOW);

    // Assert
    expect(ledger.groups.map((group) => group.count)).toEqual([1]);
  });

  test("re-screens every origin it reads back: a non-canonical spelling is not counted", async () => {
    // Arrange — origins a hand edit, or an older writer, could have left
    const home = await makeLedgerHome();
    await writeLedger(home, [
      lineAt(NOW, "http://EVIL.example:7100", "0000000000000001"),
      lineAt(NOW, "http://evil.example:7100/ignore-previous-instructions", "0000000000000002"),
      lineAt(NOW, "http://evil.example:7100", "0000000000000003"),
    ]);

    // Act
    const ledger = await readForeignHubRefusals(home, NOW);

    // Assert
    expect(ledger.groups).toHaveLength(1);
    expect(ledger.groups[0]?.hubOrigin).toBe("http://evil.example:7100");
    expect(ledger.groups[0]?.count).toBe(1);
  });
});

describe("the cap", () => {
  test("holds: the oldest lines go, the newest stays, and the counts become floors", async () => {
    // Arrange — more refused sessions than the cap holds, each with a long repo id
    const home = await makeLedgerHome();
    const repoId = `github.com/acme/${"r".repeat(150)}`;
    const sessions = Math.ceil(MAX_FOREIGN_HUB_LEDGER_BYTES / 250) + 20;

    // Act
    for (let index = 0; index < sessions; index += 1) {
      await refuse(home, `session-${String(index)}`, { repoId, now: new Date(NOW.getTime() - (sessions - index) * 1000) });
    }
    await refuse(home, "the-newest", { repoId: "github.com/new/bait" });

    // Assert
    expect((await stat(foreignHubLedgerPath(home))).size).toBeLessThanOrEqual(MAX_FOREIGN_HUB_LEDGER_BYTES);
    const written = await ledgerLines(home);
    expect(written[0]?.["floor"]).toBe(true);
    expect(written.at(-1)?.["repo"]).toBe("github.com/new/bait");
    const ledger = await readForeignHubRefusals(home, NOW);
    expect(ledger.isFull).toBe(true);
    const group = ledger.groups.find((entry) => entry.repoId === repoId);
    expect(group === undefined ? "" : formatForeignHubCount(group, ledger.isFull)).toStartWith("at least ");
  });

  test("its floor marker ages out with the window, so 'at least' is never permanent", async () => {
    // Arrange — a floor marker and a line, both from eight days ago
    const home = await makeLedgerHome();
    const old = new Date(NOW.getTime() - 8 * DAY_MS);
    await writeLedger(home, [{ at: old.toISOString(), floor: true }, lineAt(old, "http://evil.example:7100", "0000000000000001")]);

    // Act
    await refuse(home, "fresh-session");
    const ledger = await readForeignHubRefusals(home, NOW);

    // Assert
    expect(ledger.isFull).toBe(false);
    expect(await ledgerLines(home)).toHaveLength(1);
  });
});
