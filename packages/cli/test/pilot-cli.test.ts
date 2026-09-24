/**
 * `crosscheck pilot` end to end (1.0 spec 07 §5): the command driven through
 * `runCli`, a REAL git repository whose history holds the fix, and a hub that
 * answers with a fixed report — because proof 3 is decided HERE, on the
 * reader's clone, and the only way to see the diff score a real fix is to
 * hand the command a range that exists.
 *
 * (The hub's own half of the wire is pinned against a real hub in
 * connector-core/test/pilot-client.test.ts; this file is about what the
 * command does with an answer.)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import {
  EXIT_FAIL,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
} from "@crosscheck/connector-core/constants.ts";
import { runGit } from "@crosscheck/connector-core/git/git.ts";

import { runCli } from "../src/index.ts";
import {
  git,
  makeHome,
  makeRepo,
  writeRepoFile,
} from "../../connector-core/test/helpers.ts";

const NAMED = "src/workbench/usePlayback.ts";

let repo: string;
let home: string;
let brokenCommit: string;
let repairCommit: string;
let hub: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let requested: string[] = [];
let answer: () => unknown = () => ({});

const report = (): Record<string, unknown> => ({
  repo: "github.com/acme/api",
  enrolled: true,
  sinceIso: "2026-07-20T12:00:00.000Z",
  untilIso: "2026-09-14T12:00:00.000Z",
  days: 56,
  sessionSet: { used: 3, cap: 50, refused: 0, spanned: 3, restarted: 0, notRecorded: 0 },
  duplicateWork: {
    surfaced: 4,
    opened: 1,
    converged: 1,
    byChannel: { unknown: 0, briefing: 3, prompt_hint: 1, tripwire: 0, suspect: 0 },
    priorWork: [{ workContextId: "wc_1", title: "Fix playback", openedBySessions: 1 }],
    priorWorkBeyondList: 0,
    openedAnyway: 0,
  },
  collisions: {
    tripwireFlagged: { kind: "measured", value: 0 },
    ghostFlagged: { kind: "unavailable", reason: "ghost_lines_not_recorded" },
    bothLanded: { kind: "unavailable", reason: "nothing_flagged" },
    ciRegressed: { kind: "unavailable", reason: "no_ci_reporter" },
  },
  attribution: {
    answers: 1,
    attributions: 1,
    excluded: 0,
    repaired: [
      {
        pinId: "pin_broken",
        repairPinId: "pin_repair",
        brokenCommit,
        repairCommit,
        pinnedFiles: ["src/workbench/Player.tsx"],
        namedFiles: [NAMED],
      },
    ],
    repairedBeyondBound: 0,
    noRepairYet: 0,
    repairedWithoutBreakCommit: 0,
    supersededAnswers: 0,
    answersAfterRepair: 0,
  },
  precision: {
    sessions: 3,
    openedPer100: { kind: "measured", value: 33.3 },
    openedTargetPer100: 8,
    offTargetMarks: 0,
    offTargetPer100: { kind: "measured", value: 0 },
    offTargetCeilingPer100: 20,
    surfaceOkMarks: 0,
  },
  integrity: [{ surface: "api-suspect", counters: null }],
});

const run = (
  argv: readonly string[],
  hubOverride?: string,
): Promise<{ stdout: string; exitCode: number }> =>
  runCli(
    ["pilot", ...argv],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubOverride ?? hubUrl,
      CROSSCHECK_API_KEY: "pilot-cli-key",
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    repo,
  );

beforeAll(async () => {
  home = await makeHome("pilot-cli");
  repo = await makeRepo("pilot-cli", { remote: "git@github.com:acme/api.git" });
  await writeRepoFile(repo, NAMED, "export const play = 1;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "baseline"]);
  brokenCommit = (await runGit(["rev-parse", "HEAD"], repo)) ?? "";
  await writeRepoFile(repo, NAMED, "export const play = 2;\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "fix playback"]);
  repairCommit = (await runGit(["rev-parse", "HEAD"], repo)) ?? "";
  hub = Bun.serve({
    port: 0,
    fetch: (request) => {
      requested = [...requested, request.url];
      return Response.json({ ok: true, data: answer() });
    },
  });
  hubUrl = `http://127.0.0.1:${String(hub.port)}`;
});

afterAll(async () => {
  hub.stop(true);
  await Promise.all(
    [home, repo].map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("crosscheck pilot", () => {
  test("scores a repair against the fix in this clone's history", async () => {
    // Arrange
    answer = report;

    // Act
    const result = await run([]);

    // Assert — the fix changed the file the answer named: a hit.
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("hit 1 · miss 0");
    expect(result.stdout).toContain("«Fix playback» wc_1");
  });

  test("asks for this repo and the window it was given", async () => {
    // Arrange
    answer = report;
    requested = [];

    // Act
    await run(["--days", "14"]);

    // Assert
    const url = new URL(requested[0] ?? "http://x");
    expect(url.pathname).toBe("/api/pilot/report");
    expect(url.searchParams.get("repo")).toBe("github.com/acme/api");
    expect(url.searchParams.get("days")).toBe("14");
  });

  test("a window that is not a whole number of days is a usage error, and nothing is asked", async () => {
    // Arrange
    requested = [];

    // Act
    const result = await run(["--days", "two"]);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(requested).toHaveLength(0);
  });

  test("--json writes the same answer as data, with the diff's verdict beside each repair", async () => {
    // Arrange
    answer = report;

    // Act
    const result = await run(["--json"]);
    const parsed = JSON.parse(result.stdout) as {
      report: { repo: string };
      fixes: { pinId: string; repairPinId: string; outcome: string }[];
    };

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(parsed.report.repo).toBe("github.com/acme/api");
    expect(parsed.fixes).toEqual([
      { pinId: "pin_broken", repairPinId: "pin_repair", outcome: "hit" },
    ]);
  });

  test("--json cleans a teammate's text exactly as the text form does", async () => {
    // Arrange — a right-to-left override in a title. Raw JSON would hand it
    // to whatever agent ran the command through Bash, unframed.
    answer = () => {
      const base = report();
      const work = base.duplicateWork as Record<string, unknown>;
      return {
        ...base,
        duplicateWork: {
          ...work,
          priorWork: [
            { workContextId: "wc_1", title: "Fix ‮playback", openedBySessions: 1 },
          ],
        },
      };
    };

    // Act
    const result = await run(["--json"]);

    // Assert
    expect(result.stdout).not.toContain("‮");
    expect(result.stdout).not.toContain("\\u202e");
  });

  test("a hub that sends more repairs than the bound cannot make this machine diff them all", async () => {
    // Arrange — the hub bounds its own list; a hostile or broken one might not
    answer = () => {
      const base = report();
      const attribution = base.attribution as Record<string, unknown>;
      const one = (attribution.repaired as unknown[])[0];
      return {
        ...base,
        attribution: { ...attribution, repaired: Array.from({ length: 30 }, () => one) },
      };
    };

    // Act
    const result = await run(["--json"]);
    const parsed = JSON.parse(result.stdout) as { fixes: unknown[] };

    // Assert
    expect(parsed.fixes).toHaveLength(25);
  });

  test("--json never needs a backslash, and keys that clean alike keep both values", async () => {
    // Arrange — a hostile hub: a lone surrogate in a title, and two channel
    // keys that differ only by an invisible character (adversarial review)
    answer = () => {
      const base = report();
      const work = base.duplicateWork as Record<string, unknown>;
      return {
        ...base,
        duplicateWork: {
          ...work,
          byChannel: { ...(work.byChannel as Record<string, number>), briefing: 3, "briefing\u200b": 7 },
          priorWork: [{ workContextId: "wc_1", title: "Fix \ud800 playback", openedBySessions: 1 }],
        },
      };
    };

    // Act
    const result = await run(["--json"]);
    const parsed = JSON.parse(result.stdout) as {
      report: { duplicateWork: { byChannel: Record<string, number> } };
    };

    // Assert
    expect(result.stdout).not.toContain("\\");
    expect(Object.values(parsed.report.duplicateWork.byChannel)).toContain(7);
    expect(Object.values(parsed.report.duplicateWork.byChannel)).toContain(3);
  });

  test("--by-developer is refused by name, and nothing is asked", async () => {
    // Arrange — §8.4: a silent absence would invite someone to build one.
    requested = [];

    // Act
    const result = await run(["--by-developer"]);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("never per person");
    expect(requested).toHaveLength(0);
  });

  test("a report this client cannot read prints no figure at all", async () => {
    // Arrange — a count missing from the wire.
    answer = () => {
      const base = report();
      const { surfaced: _gone, ...work } = base.duplicateWork as Record<string, unknown>;
      return { ...base, duplicateWork: work };
    };

    // Act
    const result = await run([]);

    // Assert
    expect(result.exitCode).toBe(EXIT_FAIL);
    expect(result.stdout).toContain("could not be read");
    expect(result.stdout).not.toContain("surfaced");
  });

  test("an unreachable hub says UNKNOWN, never zero", async () => {
    // Arrange — a port nothing listens on.
    const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
    const deadUrl = `http://127.0.0.1:${String(dead.port)}`;
    dead.stop(true);

    // Act
    const result = await run([], deadUrl);

    // Assert
    expect(result.exitCode).toBe(EXIT_UNREACHABLE);
    expect(result.stdout).toContain("UNKNOWN, not zero");
  });
});
