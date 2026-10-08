/**
 * ONE MEMBER NEVER BLOCKS ANOTHER FROM CONFIRMING (human provenance §6;
 * review M3).
 *
 * Formed batches live in hub memory, bounded three ways: per browser session,
 * per developer across all their sessions, and per hub. Every bound EVICTS —
 * the session's own oldest, the developer's own oldest, and at the hub's
 * bound the oldest batch of whoever holds the most — and never refuses
 * another developer's batch. A batch that decides nothing (every draft left
 * for later, or no draft at all) has nothing to sign and is refused: it can
 * fill no bound.
 *
 * The bounds are the store's, exercised directly with small numbers; the
 * route's refusal of an empty batch is exercised through /ui/confirm/batch.
 */
import { describe, expect, test } from "bun:test";

import { BATCH_LIMITS, createBatchStore } from "../src/services/confirmation-batch.ts";
import { CONFIRM_PAGE_SCOPE } from "../src/services/confirm-page.ts";
import { pendingFingerprint, readPendingDrafts, writeDraft } from "../src/services/human-drafts.ts";
import { errorCodeOf, viewerOf } from "./fixtures/ceremony-driver.ts";
import { formBatch, pendingOf } from "./fixtures/confirm-driver.ts";
import { KEN_CONTEXT, NICK_SESSION, createOutcomeWorld, recordOutcome } from "./fixtures/hint-outcome-world.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const SMALL = { perSession: 2, perDeveloper: 3, total: 5 } as const;

/** One waiting mute draft for `developerId`, and a batch body discarding it. */
const draftedFor = async (harness: TestHarness, developerId: string) => {
  const deps = { db: harness.db, now: harness.clock.now };
  await writeDraft(deps, {
    developerId,
    repo: null,
    kind: "mute",
    subjectKey: `mute:dev_someone_${developerId}`,
    payload: { developerId: `dev_someone_${developerId}`, name: "Someone" },
    provenance: "agent_asserted",
  });
  const pending = await readPendingDrafts(deps, developerId, { scope: CONFIRM_PAGE_SCOPE });
  return {
    deps,
    body: {
      fingerprint: pendingFingerprint(pending),
      items: pending.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "discard" as const })),
    },
  };
};

describe("the batch store's bounds evict, never refuse another developer", () => {
  test("a developer's batches across many sessions are capped at their own: their oldest goes, nobody else's", async () => {
    // Arrange
    const harness = await createTestHarness({ drafts: "pending" });
    const ken = await createTestDeveloper(harness, "Ken", "ken-limits@example.com");
    const nick = await createTestDeveloper(harness, "Nick", "nick-limits@example.com");
    const store = createBatchStore(() => harness.clock.now().getTime(), SMALL);
    const kens = await draftedFor(harness, ken.developerId);
    const nicks = await draftedFor(harness, nick.developerId);
    const nickOwner = { developerId: nick.developerId, sessionKey: "nick-session" };
    const nickBatch = await store.form(nicks.deps, nickOwner, nicks.body, CONFIRM_PAGE_SCOPE);

    // Act — Ken's agent: one batch in each of ten sessions
    const kenBatches = [];
    for (let session = 0; session < 10; session += 1) {
      kenBatches.push(await store.form(kens.deps, { developerId: ken.developerId, sessionKey: `ken-${String(session)}` }, kens.body, CONFIRM_PAGE_SCOPE));
    }

    // Assert — Nick's batch stands; Ken keeps only his newest few
    expect("id" in nickBatch && store.read(nickOwner, nickBatch.id)).toBeTruthy();
    const kept = kenBatches.filter(
      (batch, session) => "id" in batch && store.read({ developerId: ken.developerId, sessionKey: `ken-${String(session)}` }, batch.id) !== null,
    );
    expect(kept).toHaveLength(SMALL.perDeveloper);
  });

  test("at the hub's bound, the oldest batch of whoever holds the most is evicted — a newcomer is never refused", async () => {
    // Arrange — two developers at their own cap fill the hub
    const harness = await createTestHarness({ drafts: "pending" });
    const ken = await createTestDeveloper(harness, "Ken", "ken-bound@example.com");
    const mike = await createTestDeveloper(harness, "Mike", "mike-bound@example.com");
    const nick = await createTestDeveloper(harness, "Nick", "nick-bound@example.com");
    const store = createBatchStore(() => harness.clock.now().getTime(), SMALL);
    const formAll = async (developerId: string, count: number) => {
      const drafted = await draftedFor(harness, developerId);
      const formed = [];
      for (let session = 0; session < count; session += 1) {
        formed.push(await store.form(drafted.deps, { developerId, sessionKey: `${developerId}-${String(session)}` }, drafted.body, CONFIRM_PAGE_SCOPE));
      }
      return formed;
    };
    const kens = await formAll(ken.developerId, SMALL.perDeveloper);
    await formAll(mike.developerId, SMALL.total - SMALL.perDeveloper);

    // Act — a third developer forms one
    const [nicks] = await formAll(nick.developerId, 1);

    // Assert — formed; the hub's heaviest holder lost their oldest
    expect(nicks !== undefined && "id" in nicks).toBe(true);
    const kensOldest = kens[0];
    expect(kensOldest !== undefined && "id" in kensOldest).toBe(true);
    expect(
      kensOldest !== undefined && "id" in kensOldest
        ? store.read({ developerId: ken.developerId, sessionKey: `${ken.developerId}-0` }, kensOldest.id)
        : "not formed",
    ).toBeNull();
  });
});

describe("a batch with nothing to sign", () => {
  test("every draft left for later, or no draft at all, is refused at the route: nothing to sign", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const viewer = await viewerOf(world.harness, world.nick);
    const empty = await pendingOf(world.harness, world.nick);
    const noDraft = await formBatch(world.harness, viewer, { fingerprint: empty.fingerprint, items: [] });
    expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);
    const pending = await pendingOf(world.harness, world.nick);

    // Act
    const allKept = await formBatch(world.harness, viewer, {
      fingerprint: pending.fingerprint,
      items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "keep" as const })),
    });

    // Assert
    expect(noDraft.status).toBe(422);
    expect(await errorCodeOf(noDraft)).toBe("nothing_to_sign");
    expect(allKept.status).toBe(422);
    expect(await errorCodeOf(allKept)).toBe("nothing_to_sign");
  });

  test("the hub's real bounds: per session, per developer, per hub", () => {
    expect(BATCH_LIMITS).toEqual({ perSession: 4, perDeveloper: 8, total: 1024 });
  });
});
