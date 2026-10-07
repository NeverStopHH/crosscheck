/**
 * The operator's repair for stamps the base-ancestry rule should never have
 * made (pilot finding, 2026-10-05): scripts/unland-false-landed.ts over
 * services/landed-repair.ts, on a SEEDED in-memory hub — never a real data
 * dir, never a real clone outside the OS temp dir.
 *
 * Every landed context on a pre-fix hub was stamped by base ancestry alone
 * (it is the only writer of landed_at). The repair un-lands the ones whose
 * base was already on the default branch when their session registered, by
 * the evidence there is: the connector said so, the session is detached, the
 * operator named the commit, or a clone dates the base long before its work
 * context opened. Dry run by default, and it prints counts — never an id, a
 * title, a branch or a sha.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, isNotNull } from "drizzle-orm";

import { agentSessions, workContexts } from "../src/db/schema.ts";
import {
  isGitRepository,
  readCommitDates,
  runUnlandFalseLanded,
} from "../scripts/unland-false-landed.ts";
import type { Db } from "../src/db/client.ts";
import {
  createTestDeveloper,
  createTestHarness,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const DETACHED_BASE = "51eae4d8f0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5";
const FLAGGED_BASE = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";
const OLD_BASE = "0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d";
const FRESH_BASE = "f4e5f4e5f4e5f4e5f4e5f4e5f4e5f4e5f4e5f4e5";
const NEW_WORK_BASE = "9999888877776666555544443333222211110000";
const NAMED_BASE = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const OPEN_BASE = "1234123412341234123412341234123412341234";
const MAIN_BASE = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";

/**
 * Six weeks and one hour before the contexts open (TEST_START_ISO). The
 * session that said "not on main" has an old base too: its word outranks a
 * date, so it keeps its stamp.
 */
const BASE_DATES: ReadonlyMap<string, Date> = new Map([
  [OLD_BASE, new Date("2026-06-12T09:00:00.000Z")],
  [FRESH_BASE, new Date("2026-07-24T08:00:00.000Z")],
  [NEW_WORK_BASE, new Date("2026-06-12T09:00:00.000Z")],
]);

/** Every spelling of content the output must never carry. */
interface Seeded {
  readonly harness: TestHarness;
  readonly secrets: readonly string[];
}

const SESSIONS: readonly {
  readonly id: string;
  readonly context: string;
  readonly branch: string;
  readonly base: string;
  readonly baseOnDefault?: boolean;
  readonly landed: boolean;
  /** The session ended — out of `--scope open`. */
  readonly ended?: boolean;
}[] = [
  // Falsely landed, each by one kind of evidence:
  { id: "ses_detached", context: "wc_detached", branch: "detached@51eae4d8f", base: DETACHED_BASE, landed: true },
  { id: "ses_flagged", context: "wc_flagged", branch: "feat/cut-from-main", base: FLAGGED_BASE, baseOnDefault: true, landed: true, ended: true },
  { id: "ses_on_main", context: "wc_on_main", branch: "main", base: MAIN_BASE, landed: true },
  { id: "ses_old", context: "wc_old", branch: "feat/old-checkout", base: OLD_BASE, landed: true, ended: true },
  { id: "ses_named", context: "wc_named", branch: "feat/named-stale", base: NAMED_BASE, landed: true, ended: true },
  // Truly landed, by everything there is to know:
  { id: "ses_fresh", context: "wc_fresh", branch: "feat/fresh-tip", base: FRESH_BASE, landed: true },
  { id: "ses_new_work", context: "wc_new_work", branch: "feat/said-new", base: NEW_WORK_BASE, baseOnDefault: false, landed: true, ended: true },
  // Not landed at all:
  { id: "ses_open", context: "wc_open", branch: "detached@123412341", base: OPEN_BASE, landed: false },
];

const seedHub = async (): Promise<Seeded> => {
  const harness = await createTestHarness();
  const owner: TestDeveloper = await createTestDeveloper(harness, "Nick", "nick@example.com");
  for (const session of SESSIONS) {
    await registerTestSession(harness, owner.apiKey, {
      id: session.id,
      branch: session.branch,
      baseCommit: session.base,
      ...(session.baseOnDefault === undefined ? {} : { baseOnDefault: session.baseOnDefault }),
    });
    const posted = await postRecords(harness, owner, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: session.context, sessionId: session.id, title: `Title of ${session.context}` }),
          { sessionId: session.id },
        ),
      ],
    });
    expect(posted.data?.accepted).toBe(1);
    if (session.landed) {
      // What a pre-fix hub wrote: the stamp, from a teammate's report.
      await harness.db
        .update(workContexts)
        .set({ landedAt: new Date(TEST_START_ISO) })
        .where(eq(workContexts.id, session.context));
    }
    if (session.ended === true) {
      await harness.db
        .update(agentSessions)
        .set({ endedAt: new Date(TEST_START_ISO) })
        .where(eq(agentSessions.id, session.id));
    }
  }
  const secrets = SESSIONS.flatMap((s) => [s.id, s.context, s.branch, s.base, s.base.slice(0, 9), `Title of ${s.context}`]);
  return { harness, secrets };
};

const landedIds = async (db: Db): Promise<readonly string[]> =>
  (await db.select({ id: workContexts.id }).from(workContexts).where(isNotNull(workContexts.landedAt)))
    .map((row) => row.id)
    .sort();

interface Run {
  readonly code: number;
  readonly output: string;
  readonly opened: number;
}

const run = async (
  harness: TestHarness,
  argv: readonly string[],
  edges: { readonly isGitDir?: boolean } = {},
): Promise<Run> => {
  const lines: string[] = [];
  let opened = 0;
  const code = await runUnlandFalseLanded(argv, {
    openDb: () => {
      opened += 1;
      return Promise.resolve({ db: harness.db, close: () => Promise.resolve() });
    },
    readCommitDates: () => Promise.resolve(BASE_DATES),
    isGitDir: () => Promise.resolve(edges.isGitDir ?? true),
    write: (line) => {
      lines.push(line);
    },
  });
  return { code, output: lines.join("\n"), opened };
};

/**
 * A directory that LOOKS like a hub data dir — PG_VERSION only. The script
 * checks the dir it is given; the hub it opens is still the seeded in-memory
 * one, injected through openDb.
 */
const makeHubDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-unland-hub-"));
  await writeFile(join(dir, "PG_VERSION"), "17\n", "utf8");
  return dir;
};
const HUB_DIR = await makeHubDir();
afterAll(async () => {
  await rm(HUB_DIR, { recursive: true, force: true });
});
const DATA_DIR = ["--data-dir", HUB_DIR];
const EVIDENCE = ["--git-dir", "/nonexistent/clone", "--stale-base", NAMED_BASE, "--default-branch", "origin/main"];

describe("the dry run", () => {
  test("counts the falsely landed by their evidence, changes nothing, and prints no content", async () => {
    // Arrange
    const { harness, secrets } = await seedHub();
    const before = await landedIds(harness.db);

    // Act
    const result = await run(harness, [...DATA_DIR, ...EVIDENCE]);

    // Assert
    expect(result.code).toBe(0);
    expect(result.output).toContain("landed contexts: 7");
    expect(result.output).toContain("base already on the default branch: 5");
    expect(result.output).toContain(
      "connector said so 1 · detached 1 · on the default branch 1 · operator-named base 1 · stale base 1",
    );
    expect(result.output).toContain("dry run: nothing changed");
    expect(await landedIds(harness.db)).toEqual(before);
    expect(secrets.filter((secret) => result.output.includes(secret))).toEqual([]);
  });

  test("without a clone the age of a base is not judged, and the output says so", async () => {
    // Arrange
    const { harness } = await seedHub();

    // Act
    const result = await run(harness, [...DATA_DIR, "--stale-base", NAMED_BASE]);

    // Assert: the old checkout and the session on main stay landed — no
    // evidence, no change.
    expect(result.output).toContain("base already on the default branch: 3");
    expect(result.output).toContain("stale base not judged (no --git-dir)");
    expect(result.output).toContain("on the default branch not judged (no --default-branch)");
  });
});

describe("--stale-base", () => {
  test("a unique prefix of 7+ hex names the base; an ambiguous one changes nothing", async () => {
    // Arrange: a second landed base sharing NAMED_BASE's first eight digits.
    const { harness } = await seedHub();
    const owner = await createTestDeveloper(harness, "Mira", "mira@example.com");
    const twin = `${NAMED_BASE.slice(0, 8)}${"1".repeat(32)}`;
    await registerTestSession(harness, owner.apiKey, { id: "ses_twin", branch: "feat/twin", baseCommit: twin });
    await postRecords(harness, owner, {
      records: [recordEnvelope("work_context", validWorkContextBody({ id: "wc_twin", sessionId: "ses_twin" }), { sessionId: "ses_twin" })],
    });
    await harness.db.update(workContexts).set({ landedAt: new Date(TEST_START_ISO) }).where(eq(workContexts.id, "wc_twin"));
    const before = await landedIds(harness.db);

    // Act
    const ambiguous = await run(harness, [...DATA_DIR, "--scope", "all", "--stale-base", NAMED_BASE.slice(0, 8), "--apply"]);
    const afterAmbiguous = await landedIds(harness.db);
    const unique = await run(harness, [...DATA_DIR, "--stale-base", NAMED_BASE.slice(0, 9)]);
    const nothing = await run(harness, [...DATA_DIR, "--stale-base", "fedcba9"]);

    // Assert
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.output).toContain("matches 2 landed bases");
    expect(afterAmbiguous).toEqual(before);
    expect(unique.output).toContain("operator-named base 1");
    expect(nothing.output).toContain("--stale-base fedcba9 matches no landed base");
  });
});

describe("a connector's word against an operator's", () => {
  test("a base the connector said was new keeps its stamp when named; only the override clears it", async () => {
    // Arrange: wc_new_work's connector said its base was NOT on main.
    const { harness } = await seedHub();

    // Act
    const named = await run(harness, [...DATA_DIR, "--scope", "all", "--stale-base", NEW_WORK_BASE, "--apply"]);
    const keptAfterNamed = (await landedIds(harness.db)).includes("wc_new_work");
    const overridden = await run(harness, [...DATA_DIR, "--scope", "all", "--stale-base-override", NEW_WORK_BASE, "--apply"]);
    const keptAfterOverride = (await landedIds(harness.db)).includes("wc_new_work");

    // Assert
    expect(named.output).toContain("operator-named base 0");
    expect(keptAfterNamed).toBe(true);
    expect(overridden.output).toContain("operator override 1");
    expect(keptAfterOverride).toBe(false);
  });
});

describe("--data-dir", () => {
  test("must name an existing hub data dir, never a typo or another flag", async () => {
    // Arrange: a missing path, a directory that is not a data dir, and the
    // reviewer's own slip — `--data-dir --apply`, which made a dir named
    // `--apply`.
    const { harness } = await seedHub();
    const notAHub = await mkdtemp(join(tmpdir(), "cx-unland-nothub-"));

    // Act
    const missing = await run(harness, ["--data-dir", join(notAHub, "typo-dir")]);
    const plain = await run(harness, ["--data-dir", notAHub]);
    const flagShaped = await run(harness, ["--data-dir", "--apply"]);
    await rm(notAHub, { recursive: true, force: true });

    // Assert: refused, and nothing was opened — or created.
    expect([missing.code, plain.code, flagShaped.code]).toEqual([2, 2, 2]);
    expect(missing.opened + plain.opened + flagShaped.opened).toBe(0);
    expect(missing.output).toContain("is not a hub data dir");
    expect(flagShaped.output).toContain("--data-dir needs a value, not another flag");
  });

  test("a data dir a hub still holds is refused unless --force", async () => {
    // Arrange: PGlite writes postmaster.pid while it holds the dir.
    const { harness } = await seedHub();
    const held = await makeHubDir();
    await writeFile(join(held, "postmaster.pid"), "1\n", "utf8");

    // Act
    const refused = await run(harness, ["--data-dir", held]);
    const forced = await run(harness, ["--data-dir", held, "--force"]);
    await rm(held, { recursive: true, force: true });

    // Assert
    expect(refused.code).toBe(2);
    expect(refused.opened).toBe(0);
    expect(refused.output).toContain("postmaster.pid");
    expect(forced.code).toBe(0);
  });
});

describe("--git-dir", () => {
  test("a path that is not a git repository is refused before the hub is opened", async () => {
    // Arrange
    const { harness } = await seedHub();

    // Act
    const result = await run(harness, [...DATA_DIR, ...EVIDENCE], { isGitDir: false });

    // Assert
    expect(result.code).toBe(2);
    expect(result.opened).toBe(0);
    expect(result.output).toContain("--git-dir is not a git repository");
  });

  test("the run says how many bases the clone could date, and how many it could not", async () => {
    // Arrange: seven landed bases, two of which the clone dates.
    const { harness } = await seedHub();

    // Act
    const result = await run(harness, [...DATA_DIR, ...EVIDENCE]);

    // Assert
    expect(result.output).toContain("git dates: 3 of 7 bases dated, 4 not in that clone");
  });
});

describe("--scope", () => {
  test("open judges only the contexts whose session is still open — the owner's run", async () => {
    // Arrange: three landed contexts sit on open sessions — the detached one
    // and the one on main, both falsely, and the fresh tip truly; the other
    // four landed contexts' sessions ended.
    const { harness } = await seedHub();

    // Act
    const dry = await run(harness, [...DATA_DIR, ...EVIDENCE, "--scope", "open"]);
    const applied = await run(harness, [...DATA_DIR, ...EVIDENCE, "--scope", "open", "--apply"]);

    // Assert: the ended sessions' stamps, false ones included, stay.
    expect(dry.output).toContain("scope: contexts on open sessions");
    expect(dry.output).toContain("landed contexts: 3");
    expect(dry.output).toContain("base already on the default branch: 2");
    expect(applied.output).toContain("un-landed 2 contexts");
    expect(await landedIds(harness.db)).toEqual(["wc_flagged", "wc_fresh", "wc_named", "wc_new_work", "wc_old"]);
  });

  test("--apply needs an explicit scope, and every run reminds to save the pilot report first", async () => {
    // Arrange
    const { harness } = await seedHub();

    // Act
    const unscoped = await run(harness, [...DATA_DIR, ...EVIDENCE, "--apply"]);
    const badScope = await run(harness, [...DATA_DIR, "--scope", "some"]);
    const dry = await run(harness, [...DATA_DIR, ...EVIDENCE]);

    // Assert
    expect([unscoped.code, badScope.code]).toEqual([2, 2]);
    expect(unscoped.opened + badScope.opened).toBe(0);
    expect(unscoped.output).toContain("--apply needs --scope open or --scope all");
    expect(dry.output).toContain("scope: every landed context");
    expect(dry.output).toContain("crosscheck pilot --json");
    expect(await landedIds(harness.db)).toHaveLength(7);
  });
});

describe("--apply", () => {
  test("un-lands exactly the falsely landed, and a second run finds nothing", async () => {
    // Arrange
    const { harness, secrets } = await seedHub();

    // Act
    const applied = await run(harness, [...DATA_DIR, ...EVIDENCE, "--scope", "all", "--apply"]);
    const again = await run(harness, [...DATA_DIR, ...EVIDENCE]);

    // Assert
    expect(applied.code).toBe(0);
    expect(applied.output).toContain("un-landed 5 contexts");
    expect(await landedIds(harness.db)).toEqual(["wc_fresh", "wc_new_work"]);
    expect(again.output).toContain("base already on the default branch: 0");
    expect(secrets.filter((secret) => applied.output.includes(secret))).toEqual([]);
  });
});

describe("opt-in, explicitly", () => {
  test("refuses to open anything without --data-dir, or with a value that is not a sha", async () => {
    // Arrange
    const { harness } = await seedHub();

    // Act
    const noDir = await run(harness, ["--scope", "all"]);
    const badSha = await run(harness, [...DATA_DIR, "--stale-base", "--all"]);
    const unknown = await run(harness, [...DATA_DIR, "--yes"]);

    // Assert: usage errors, and the hub was never opened.
    expect([noDir.code, badSha.code, unknown.code]).toEqual([2, 2, 2]);
    expect(noDir.opened + badSha.opened + unknown.opened).toBe(0);
    expect(await landedIds(harness.db)).toHaveLength(7);
  });
});

describe("readCommitDates", () => {
  const cleanups: string[] = [];
  afterAll(async () => {
    await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  });

  const git = async (cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> => {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out.trim();
  };

  test("isGitRepository tells a clone from a plain directory", async () => {
    // Arrange
    const clone = await mkdtemp(join(tmpdir(), "cx-unland-clone-"));
    const plain = await mkdtemp(join(tmpdir(), "cx-unland-plain-"));
    cleanups.push(clone, plain);
    await git(clone, ["init", "-q"]);

    // Act + Assert
    expect(await isGitRepository(clone)).toBe(true);
    expect(await isGitRepository(plain)).toBe(false);
  });

  test("reads each base's committer date from a clone; unknown and flag-shaped values read nothing", async () => {
    // Arrange: one commit whose committer date is set, in a temp clone.
    const root = await mkdtemp(join(tmpdir(), "cx-unland-"));
    cleanups.push(root);
    await git(root, ["init", "-q", "--initial-branch=main"]);
    await git(root, ["-c", "user.email=a@example.com", "-c", "user.name=A", "commit", "-q", "--allow-empty", "-m", "old"], {
      GIT_COMMITTER_DATE: "2026-06-12T09:00:00Z",
    });
    const sha = await git(root, ["rev-parse", "HEAD"]);

    // Act
    const dates = await readCommitDates(root, [sha, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "--all"]);

    // Assert
    expect([...dates.entries()].map(([key, at]) => [key, at.toISOString()])).toEqual([
      [sha, "2026-06-12T09:00:00.000Z"],
    ]);
  });
});
