/**
 * The hub half of the generated-target rule (services/generated-targets.ts),
 * one surface at a time: a labelled file is never overlap evidence — not on
 * the ghost check, not in a conference pair, not on the tripwire, not in the
 * hot count, not in a context's size — and it is KEPT, so `suspect` still
 * names the session that touched it. Each silence has a control beside it:
 * the same shape with ordinary files must speak, or the silence proves
 * nothing.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { GHOST_HOT_TARGET_MAX_CONTEXTS, GHOST_MAX_CONTEXT_TARGETS } from "../src/constants.ts";
import { workContextTargets, workContexts } from "../src/db/schema.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

/**
 * Every case boots its own PGlite hub, and the two hot-count cases seed more
 * than twenty contexts: on a loaded machine one boot alone was measured at
 * 5.25 s, past bun's 5 s default, which reads as a red guard that is not one.
 */
const CASE_TIMEOUT_MS = 30_000;
setDefaultTimeout(CASE_TIMEOUT_MS);

const REPO = VALID_SESSION_BODY.repo;
const MY_SESSION = "ses_mine";
const THEIR_SESSION = "ses_theirs";
const MY_CONTEXT = "wc_mine";
const THEIR_CONTEXT = "wc_theirs";

/** Two ordinary files: enough to qualify a row on their own (GHOST_MIN_SHARED_TARGETS). */
const PLAN = ["src/auth/token.ts", "src/auth/session.ts"];

interface Target {
  readonly kind: string;
  readonly value: string;
  readonly generated?: string;
}

/** One of each way a file becomes generated: two labels the connector sends, two names the hub knows. */
const GENERATED: readonly Target[] = [
  { kind: "file", value: "packages/proto/src/messages.ts", generated: "attribute" },
  { kind: "file", value: "src/client/api.ts", generated: "header" },
  { kind: "file", value: "apps/practice/package-lock.json" },
  { kind: "file", value: "packages/api/src/__generated__/schema.ts" },
];

const files = (values: readonly string[]): readonly Target[] => values.map((value) => ({ kind: "file", value }));

interface GhostRow {
  readonly workContextId: string;
  readonly sharedTargets: readonly { kind: string; value: string }[];
  readonly sharedTargetCount: number;
  readonly generatedSharedCount: number;
  readonly largeChangeFiles: number | null;
}

interface ConferencePair {
  readonly workContextIdA: string;
  readonly workContextIdB: string;
  readonly sharedTargetCount: number;
  readonly generatedSharedCount: number;
}

interface Setup {
  readonly harness: TestHarness;
  readonly me: TestDeveloper;
  readonly them: TestDeveloper;
}

const setup = async (): Promise<Setup> => {
  const { harness, developer } = await createHarnessWithSession({ id: MY_SESSION });
  const them = await addTestDeveloperWithSession(harness, "Ken", "ken@example.com", { id: THEIR_SESSION });
  return { harness, me: developer, them };
};

const contextRecords = (
  contextId: string,
  sessionId: string,
  targets: readonly Target[],
): readonly Record<string, unknown>[] => [
  recordEnvelope(
    "work_context",
    validWorkContextBody({ id: contextId, sessionId, title: `Work ${contextId}`, description: undefined, createdAt: TEST_START_ISO }),
    { sessionId },
  ),
  ...targets.map((target) => recordEnvelope("target", { workContextId: contextId, ...target }, { sessionId })),
];

const seed = async (
  harness: TestHarness,
  developer: TestDeveloper,
  records: readonly Record<string, unknown>[],
): Promise<void> => {
  const posted = await postRecords(harness, developer, { records });
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`seed failed: ${JSON.stringify(posted.data?.results)}`);
  }
};

const get = async <T>(harness: TestHarness, apiKey: string, path: string): Promise<T> => {
  const response = await harness.app.request(path, jsonRequest("GET", apiKey));
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: T }).data;
};

const ghostRows = async (harness: TestHarness, me: TestDeveloper): Promise<readonly GhostRow[]> =>
  (await get<{ ghostChecks: readonly GhostRow[] }>(harness, me.apiKey, `/api/ghost-checks?repo=${encodeURIComponent(REPO)}`))
    .ghostChecks;

const conferencePairs = async (harness: TestHarness, me: TestDeveloper): Promise<readonly ConferencePair[]> =>
  (await get<{ conference: { overlaps: readonly ConferencePair[] } }>(harness, me.apiKey, `/api/conference?repo=${encodeURIComponent(REPO)}`))
    .conference.overlaps;

const tripwireSessions = async (harness: TestHarness, me: TestDeveloper, value: string): Promise<readonly unknown[]> =>
  (
    await get<{ sessions: readonly unknown[] }>(
      harness,
      me.apiKey,
      `/api/hints/tripwire?repo=${encodeURIComponent(REPO)}&value=${encodeURIComponent(value)}`,
    )
  ).sessions;

const storedLabel = async (harness: TestHarness, contextId: string, value: string): Promise<string | null | undefined> => {
  const rows = await harness.db
    .select({ generated: workContextTargets.generated })
    .from(workContextTargets)
    .where(and(eq(workContextTargets.workContextId, contextId), eq(workContextTargets.value, value)));
  return rows[0]?.generated;
};

/** Both developers carry the same targets on one live context each. */
const bothCarry = async (fx: Setup, mine: readonly Target[], theirs: readonly Target[] = mine): Promise<void> => {
  await seed(fx.harness, fx.me, contextRecords(MY_CONTEXT, MY_SESSION, mine));
  await seed(fx.harness, fx.them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, theirs));
};

describe("ingest: the label is stored, the touch is kept", () => {
  test("a sent label is stored as sent", async () => {
    // Arrange
    const fx = await setup();

    // Act
    await seed(fx.harness, fx.me, contextRecords(MY_CONTEXT, MY_SESSION, GENERATED));

    // Assert
    expect(await storedLabel(fx.harness, MY_CONTEXT, "packages/proto/src/messages.ts")).toBe("attribute");
    expect(await storedLabel(fx.harness, MY_CONTEXT, "src/client/api.ts")).toBe("header");
  });

  test("an OLDER connector's target, with no field, gets the path signal from the hub", async () => {
    // Arrange
    const fx = await setup();

    // Act: field-less targets, as every connector before the rule sends them.
    await seed(
      fx.harness,
      fx.me,
      contextRecords(MY_CONTEXT, MY_SESSION, files(["apps/practice/package-lock.json", "packages/api/src/__generated__/schema.ts", "src/feed.ts"])),
    );

    // Assert
    expect(await storedLabel(fx.harness, MY_CONTEXT, "apps/practice/package-lock.json")).toBe("path");
    expect(await storedLabel(fx.harness, MY_CONTEXT, "packages/api/src/__generated__/schema.ts")).toBe("path");
    expect(await storedLabel(fx.harness, MY_CONTEXT, "src/feed.ts")).toBeNull();
  });

  test("two older connectors whose only common ground is generated names are silent", async () => {
    // Arrange: neither side sends a label.
    const fx = await setup();
    const only = files(["apps/practice/package-lock.json", "packages/api/src/__generated__/schema.ts", "packages/ui/src/routes.gen.ts"]);
    await bothCarry(fx, only);

    // Act + Assert
    expect(await ghostRows(fx.harness, fx.me)).toEqual([]);
  });

  test("a generated touch is KEPT: suspect still names the session that touched it", async () => {
    // Arrange
    const fx = await setup();
    await seed(fx.harness, fx.them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, GENERATED));

    // Act
    const trace = await get<{ candidates: readonly { sessionId: string }[] }>(
      fx.harness,
      fx.me.apiKey,
      `/api/suspect?repo=${encodeURIComponent(REPO)}&path=${encodeURIComponent("packages/proto/src/messages.ts")}`,
    );

    // Assert
    expect(trace.candidates.map((candidate) => candidate.sessionId)).toEqual([THEIR_SESSION]);
  });

  test("a re-touch without a label turns the row ordinary again — the latest touch decides, toward warning", async () => {
    // Arrange: labelled once.
    const fx = await setup();
    await seed(fx.harness, fx.me, contextRecords(MY_CONTEXT, MY_SESSION, [GENERATED[0] as Target]));

    // Act: the same file again, its classification unable to run this time.
    await seed(fx.harness, fx.me, [
      recordEnvelope("target", { workContextId: MY_CONTEXT, kind: "file", value: "packages/proto/src/messages.ts" }, { sessionId: MY_SESSION }),
    ]);

    // Assert
    expect(await storedLabel(fx.harness, MY_CONTEXT, "packages/proto/src/messages.ts")).toBeNull();
  });
});

describe("ghost checks: a generated file is never overlap evidence", () => {
  test("CONTROL: two shared ordinary files are a row", async () => {
    const fx = await setup();
    await bothCarry(fx, files(PLAN));

    const rows = await ghostRows(fx.harness, fx.me);

    expect(rows.map((row) => row.workContextId)).toEqual([THEIR_CONTEXT]);
    expect(rows[0]?.generatedSharedCount).toBe(0);
  });

  test("an overlap made ONLY of generated files — every signal — is no row", async () => {
    const fx = await setup();
    await bothCarry(fx, GENERATED);

    expect(await ghostRows(fx.harness, fx.me)).toEqual([]);
  });

  test("ONE side's label is enough: their generated file is not evidence of their plan", async () => {
    // Arrange: my rows are unlabelled, theirs carry the attribute label.
    const fx = await setup();
    const mine = files(["packages/proto/src/messages.ts", "packages/proto/src/service.ts"]);
    const theirs = mine.map((target) => ({ ...target, generated: "attribute" }));
    await bothCarry(fx, mine, theirs);

    // Act + Assert
    expect(await ghostRows(fx.harness, fx.me)).toEqual([]);
  });

  test("MY side's label is enough too: my generated file is never probed", async () => {
    // Arrange: my rows carry the attribute label, theirs are unlabelled.
    const fx = await setup();
    const theirs = files(["packages/proto/src/messages.ts", "packages/proto/src/service.ts"]);
    const mine = theirs.map((target) => ({ ...target, generated: "attribute" }));
    await bothCarry(fx, mine, theirs);

    // Act + Assert
    expect(await ghostRows(fx.harness, fx.me)).toEqual([]);
  });

  test("a row that qualified on ordinary files counts the generated ones beside them, and names none", async () => {
    // Arrange
    const fx = await setup();
    await bothCarry(fx, [...files(PLAN), ...GENERATED]);

    // Act
    const rows = await ghostRows(fx.harness, fx.me);

    // Assert
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sharedTargetCount).toBe(2);
    expect(rows[0]?.generatedSharedCount).toBe(GENERATED.length);
    expect(rows[0]?.sharedTargets.map((target) => target.value).sort()).toEqual([...PLAN].sort());
  });

  test("FAIL TOWARD WARNING: a label the hub cannot read leaves the file ordinary, and it still warns", async () => {
    // Arrange: a newer connector's label, or garbage — and no path signal.
    const fx = await setup();
    const unknown = PLAN.map((value) => ({ kind: "file", value, generated: "something-new" }));
    await bothCarry(fx, unknown);

    // Act + Assert
    expect((await ghostRows(fx.harness, fx.me)).map((row) => row.workContextId)).toEqual([THEIR_CONTEXT]);
  });

  test("the hot count counts evidence only: generated copies of a file never make it hot", async () => {
    // Arrange: we share two ordinary files; one of them is ALSO carried, as a
    // labelled generated file, by more contexts than the hot bar allows.
    const fx = await setup();
    await bothCarry(fx, files(PLAN));
    const [hotIfCounted] = PLAN;
    for (let index = 0; index <= GHOST_HOT_TARGET_MAX_CONTEXTS; index += 1) {
      const sessionId = `ses_crowd_${String(index)}`;
      await registerTestSession(fx.harness, fx.them.apiKey, { id: sessionId });
      await seed(
        fx.harness,
        fx.them,
        contextRecords(`wc_crowd_${String(index)}`, sessionId, [{ kind: "file", value: hotIfCounted as string, generated: "header" }]),
      );
    }

    // Act
    const row = (await ghostRows(fx.harness, fx.me)).find((entry) => entry.workContextId === THEIR_CONTEXT);

    // Assert: both files still count — the crowd's generated copies are not evidence.
    expect(row?.sharedTargetCount).toBe(2);
  });

  test("a context's size counts ordinary files only: a regenerated tree does not make a focused change large", async () => {
    // Arrange: their focused plan plus more generated files than the large-change line.
    const fx = await setup();
    const regenerated = Array.from({ length: GHOST_MAX_CONTEXT_TARGETS + 10 }, (_unused, index) => ({
      kind: "file",
      value: `packages/proto/src/msg-${String(index)}.ts`,
      generated: "attribute",
    }));
    await bothCarry(fx, files(PLAN), [...files(PLAN), ...regenerated]);

    // Act
    const row = (await ghostRows(fx.harness, fx.me)).find((entry) => entry.workContextId === THEIR_CONTEXT);

    // Assert
    expect(row?.largeChangeFiles ?? null).toBeNull();
  });

  test("CONTROL: the same size in ordinary files IS a large change", async () => {
    const fx = await setup();
    const renamed = files(Array.from({ length: GHOST_MAX_CONTEXT_TARGETS + 10 }, (_unused, index) => `src/renamed/msg-${String(index)}.ts`));
    await bothCarry(fx, files(PLAN), [...files(PLAN), ...renamed]);

    const row = (await ghostRows(fx.harness, fx.me)).find((entry) => entry.workContextId === THEIR_CONTEXT);

    expect(row?.largeChangeFiles).toBe(GHOST_MAX_CONTEXT_TARGETS + 10 + PLAN.length);
  });
});

describe("conference: a generated file never pairs two contexts", () => {
  test("a pair made only of generated files is no overlap; with two ordinary files it pairs, counting the rest", async () => {
    // Arrange: first only generated ground.
    const only = await setup();
    await bothCarry(only, GENERATED);
    const both = await setup();
    await bothCarry(both, [...files(PLAN), ...GENERATED]);

    // Act
    const silent = await conferencePairs(only.harness, only.me);
    const paired = await conferencePairs(both.harness, both.me);

    // Assert
    expect(silent).toEqual([]);
    expect(paired).toHaveLength(1);
    expect(paired[0]?.sharedTargetCount).toBe(2);
    expect(paired[0]?.generatedSharedCount).toBe(GENERATED.length);
  });

  test("ONE side's label keeps the pair apart: their generated file is no member of the overlap", async () => {
    // Arrange: my rows unlabelled, theirs labelled.
    const fx = await setup();
    const mine = files(["packages/proto/src/messages.ts", "packages/proto/src/service.ts"]);
    await bothCarry(fx, mine, mine.map((target) => ({ ...target, generated: "attribute" })));

    // Act + Assert
    expect(await conferencePairs(fx.harness, fx.me)).toEqual([]);
  });

  test("the conference's hot count counts evidence only: generated copies never make a shared file hot", async () => {
    // Arrange: we share two ordinary files; one of them is also carried, as a
    // labelled generated file, by more contexts than the hot bar allows —
    // LANDED, so they are off the page and change nothing but the rarity.
    const fx = await setup();
    await bothCarry(fx, files(PLAN));
    const [hotIfCounted] = PLAN;
    for (let index = 0; index <= GHOST_HOT_TARGET_MAX_CONTEXTS; index += 1) {
      const id = `wc_filler_${String(index)}`;
      await seed(fx.harness, fx.me, contextRecords(id, MY_SESSION, [{ kind: "file", value: hotIfCounted as string, generated: "header" }]));
      await fx.harness.db.update(workContexts).set({ landedAt: new Date() }).where(eq(workContexts.id, id));
    }

    // Act
    const pairs = await conferencePairs(fx.harness, fx.me);

    // Assert
    expect(pairs.map((pair) => pair.sharedTargetCount)).toEqual([2]);
  });
});

describe("tripwire: a teammate on a generated file is nobody to stop for", () => {
  test("CONTROL: a teammate on an ordinary file is named", async () => {
    const fx = await setup();
    await seed(fx.harness, fx.them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, files(PLAN)));

    expect(await tripwireSessions(fx.harness, fx.me, PLAN[0] as string)).toHaveLength(1);
  });

  test("their labelled file, and a well-known generated name whatever its row says, name nobody", async () => {
    // Arrange: one labelled row; one nested lockfile whose row predates the
    // column (forced back to NULL), asked about by a connector with no rule.
    const fx = await setup();
    await seed(fx.harness, fx.them, contextRecords(THEIR_CONTEXT, THEIR_SESSION, GENERATED));
    await fx.harness.db
      .update(workContextTargets)
      .set({ generated: null })
      .where(eq(workContextTargets.value, "apps/practice/package-lock.json"));

    // Act + Assert
    expect(await tripwireSessions(fx.harness, fx.me, "packages/proto/src/messages.ts")).toEqual([]);
    expect(await tripwireSessions(fx.harness, fx.me, "src/client/api.ts")).toEqual([]);
    expect(await tripwireSessions(fx.harness, fx.me, "apps/practice/package-lock.json")).toEqual([]);
  });
});
