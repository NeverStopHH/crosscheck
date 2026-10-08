/**
 * THE DRAFT STORE (human provenance §4): what a key writes when only a person
 * may decide. Append-only versions per subject; the newest unresolved version
 * is what is pending; a repeat writes nothing; a person's page stays a page.
 */
import { describe, expect, test } from "bun:test";

import { MAX_PENDING_DRAFT_SUBJECTS } from "../src/constants.ts";
import { humanConfirmationItems, humanConfirmations, humanDrafts } from "../src/db/schema.ts";
import { pendingFingerprint, readPendingDrafts, writeDraft } from "../src/services/human-drafts.ts";
import type { WriteDraftInput } from "../src/services/human-drafts.ts";
import { seedPasskey } from "./fixtures/passkeys.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";

const outcomeDraft = (developerId: string, refId: string, word: string, reason: string | null = null): WriteDraftInput => ({
  developerId,
  repo: REPO,
  kind: "outcome",
  subjectKey: `outcome:s_1:${refId}`,
  payload: { deliveryId: `hd_${refId}`, sessionId: "s_1", refId, word, reason },
  provenance: "agent_asserted",
});

const depsOf = (harness: TestHarness) => ({ db: harness.db, now: harness.clock.now });

/** A confirmed batch that resolved `draftId` with `decision` — written straight, the ceremony is not under test. */
const resolve = async (harness: TestHarness, developerId: string, draftId: string, decision: "confirm" | "discard" | "keep") => {
  const { credentialId } = await seedPasskey(harness.db, developerId);
  const id = `hc_${draftId}_${decision}`;
  const at = harness.clock.now();
  await harness.db.insert(humanConfirmations).values({
    id,
    developerId,
    credentialId,
    rpId: "localhost",
    digest: "d",
    pendingFingerprint: "f",
    itemCount: 1,
    formedAt: at,
    confirmedAt: at,
  });
  await harness.db.insert(humanConfirmationItems).values({
    confirmationId: id,
    position: 0,
    draftId,
    draftVersion: 1,
    draftDigest: "x",
    decision,
    content: {},
  });
};

describe("human drafts", () => {
  test("a draft is stored with its class at version 1, and is pending", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-1@example.com");

    // Act
    const written = await writeDraft(depsOf(harness), outcomeDraft(nick.developerId, "wc_ken", "followed"));
    const pending = await readPendingDrafts(harness.db, nick.developerId);

    // Assert
    expect(written).toMatchObject({ version: 1, repeated: false });
    expect(pending.map((draft) => [draft.kind, draft.version, draft.provenance])).toEqual([["outcome", 1, "agent_asserted"]]);
  });

  test("a different word on the same subject is its next version; only the newest is pending, the older kept", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-2@example.com");
    const deps = depsOf(harness);
    await writeDraft(deps, outcomeDraft(nick.developerId, "wc_ken", "followed"));

    // Act
    const second = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_ken", "overrode", "mine was simpler"));
    const pending = await readPendingDrafts(harness.db, nick.developerId);
    const stored = await harness.db.select().from(humanDrafts);

    // Assert
    expect(second).toMatchObject({ version: 2, repeated: false });
    expect(pending.map((draft) => draft.payload["word"])).toEqual(["overrode"]);
    expect(stored).toHaveLength(2);
  });

  test("the same word and reason again is a repeat and writes nothing", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-3@example.com");
    const deps = depsOf(harness);
    const first = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_ken", "followed"));

    // Act
    const again = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_ken", "followed"));

    // Assert
    expect(again).toEqual({ ...first, repeated: true });
    expect(await harness.db.select().from(humanDrafts)).toHaveLength(1);
  });

  test("a confirmed or discarded draft is no longer pending; keep leaves it pending", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-4@example.com");
    const deps = depsOf(harness);
    const a = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_a", "followed"));
    const b = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_b", "followed"));
    const c = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_c", "followed"));
    if (!("id" in a) || !("id" in b) || !("id" in c)) {
      throw new Error("drafts were refused");
    }

    // Act
    await resolve(harness, nick.developerId, a.id, "confirm");
    await resolve(harness, nick.developerId, b.id, "discard");
    await resolve(harness, nick.developerId, c.id, "keep");
    const pending = await readPendingDrafts(harness.db, nick.developerId);

    // Assert
    expect(pending.map((draft) => draft.id)).toEqual([c.id]);
  });

  test("a word repeating a discarded draft is a repeat; a new word after it is pending again", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-5@example.com");
    const deps = depsOf(harness);
    const first = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_ken", "followed"));
    if (!("id" in first)) {
      throw new Error("draft was refused");
    }
    await resolve(harness, nick.developerId, first.id, "discard");

    // Act
    const repeat = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_ken", "followed"));
    const changed = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_ken", "not_relevant_now"));
    const pending = await readPendingDrafts(harness.db, nick.developerId);

    // Assert
    expect(repeat).toMatchObject({ repeated: true });
    expect(changed).toMatchObject({ version: 2, repeated: false });
    expect(pending.map((draft) => draft.payload["word"])).toEqual(["not_relevant_now"]);
  });

  test("a new subject past the bound is refused; a new version of a pending subject never is", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-6@example.com");
    const deps = depsOf(harness);
    for (let index = 0; index < MAX_PENDING_DRAFT_SUBJECTS; index += 1) {
      await writeDraft(deps, outcomeDraft(nick.developerId, `wc_${String(index)}`, "followed"));
    }

    // Act
    const beyond = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_beyond", "followed"));
    const revised = await writeDraft(deps, outcomeDraft(nick.developerId, "wc_0", "overrode", "changed my mind"));

    // Assert
    expect(beyond).toEqual({ refusal: "too_many_drafts" });
    expect(revised).toMatchObject({ version: 2, repeated: false });
  });

  test("another person's drafts are never in one's pending set", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-7@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken-drafts-7@example.com");
    await writeDraft(depsOf(harness), outcomeDraft(ken.developerId, "wc_nick", "followed"));

    // Act & Assert
    expect(await readPendingDrafts(harness.db, nick.developerId)).toEqual([]);
  });

  test("the fingerprint of the pending set changes when a draft is added or superseded, and only then", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-8@example.com");
    const deps = depsOf(harness);
    await writeDraft(deps, outcomeDraft(nick.developerId, "wc_a", "followed"));
    const fingerprint = async () => pendingFingerprint(await readPendingDrafts(harness.db, nick.developerId));
    const before = await fingerprint();

    // Act
    const unchanged = await fingerprint();
    await writeDraft(deps, outcomeDraft(nick.developerId, "wc_b", "followed"));
    const added = await fingerprint();
    await writeDraft(deps, outcomeDraft(nick.developerId, "wc_b", "overrode", "no"));
    const superseded = await fingerprint();

    // Assert
    expect(unchanged).toBe(before);
    expect(new Set([before, added, superseded]).size).toBe(3);
  });
});
