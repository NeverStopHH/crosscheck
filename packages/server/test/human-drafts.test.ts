/**
 * THE DRAFT STORE (human provenance §4): what a key writes when only a person
 * may decide. Append-only versions per subject; the newest undecided LIVE
 * version is what is pending; a repeat writes nothing; a person's page stays
 * a page. Driven with mute drafts — live while the mute does not hold, so a
 * subject per teammate costs no world to set up.
 */
import { describe, expect, test } from "bun:test";

import { MAX_PENDING_DRAFT_SUBJECTS } from "../src/constants.ts";
import { humanConfirmationItems, humanConfirmations, humanDrafts } from "../src/db/schema.ts";
import { addMute } from "../src/services/developer-settings.ts";
import { pendingFingerprint, readPendingDrafts, writeDraft } from "../src/services/human-drafts.ts";
import type { WriteDraftInput } from "../src/services/human-drafts.ts";
import { seedHumanStamp } from "./fixtures/human-confirmation.ts";
import { seedPasskey } from "./fixtures/passkeys.ts";
import { createTestDeveloper, createTestHarness } from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";

const muteDraft = (developerId: string, mutedId: string, name: string = mutedId): WriteDraftInput => ({
  developerId,
  repo: null,
  kind: "mute",
  subjectKey: `mute:${mutedId}`,
  payload: { developerId: mutedId, name },
  provenance: "agent_asserted",
});

const depsOf = (harness: TestHarness) => ({ db: harness.db, now: harness.clock.now });

const pendingOf = (harness: TestHarness, developerId: string) => readPendingDrafts(depsOf(harness), developerId);

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
    authenticatorData: "seeded",
    clientDataJson: "seeded",
    signature: "seeded",
    userHandle: null,
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

const idOf = (written: Awaited<ReturnType<typeof writeDraft>>): string => {
  if (!("id" in written)) {
    throw new Error("the draft was refused");
  }
  return written.id;
};

describe("human drafts", () => {
  test("a draft is stored with its class at version 1, and is pending", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-1@example.com");

    // Act
    const written = await writeDraft(depsOf(harness), muteDraft(nick.developerId, "dev_ken"));
    const pending = await pendingOf(harness, nick.developerId);

    // Assert
    expect(written).toMatchObject({ version: 1, repeated: false });
    expect(pending.map((draft) => [draft.kind, draft.version, draft.provenance])).toEqual([["mute", 1, "agent_asserted"]]);
  });

  test("a different word on the same subject is its next version; only the newest is pending, the older kept", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-2@example.com");
    const deps = depsOf(harness);
    await writeDraft(deps, muteDraft(nick.developerId, "dev_ken", "Ken"));

    // Act
    const second = await writeDraft(deps, muteDraft(nick.developerId, "dev_ken", "Ken K."));
    const pending = await pendingOf(harness, nick.developerId);
    const stored = await harness.db.select().from(humanDrafts);

    // Assert
    expect(second).toMatchObject({ version: 2, repeated: false });
    expect(pending.map((draft) => draft.payload["name"])).toEqual(["Ken K."]);
    expect(stored).toHaveLength(2);
  });

  test("the same draft again is a repeat and writes nothing", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-3@example.com");
    const deps = depsOf(harness);
    const first = await writeDraft(deps, muteDraft(nick.developerId, "dev_ken"));

    // Act
    const again = await writeDraft(deps, muteDraft(nick.developerId, "dev_ken"));

    // Assert
    expect(again).toEqual({ ...first, repeated: true });
    expect(await harness.db.select().from(humanDrafts)).toHaveLength(1);
  });

  test("a confirmed or discarded draft is no longer pending; keep leaves it pending", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-4@example.com");
    const deps = depsOf(harness);
    const a = idOf(await writeDraft(deps, muteDraft(nick.developerId, "dev_a")));
    const b = idOf(await writeDraft(deps, muteDraft(nick.developerId, "dev_b")));
    const c = idOf(await writeDraft(deps, muteDraft(nick.developerId, "dev_c")));

    // Act
    await resolve(harness, nick.developerId, a, "confirm");
    await resolve(harness, nick.developerId, b, "discard");
    await resolve(harness, nick.developerId, c, "keep");
    const pending = await pendingOf(harness, nick.developerId);

    // Assert
    expect(pending.map((draft) => draft.id)).toEqual([c]);
  });

  test("a draft saying again what was DECIDED is a new draft — a repeat only while the same one still waits (review H2, H3)", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-5@example.com");
    const deps = depsOf(harness);
    const first = idOf(await writeDraft(deps, muteDraft(nick.developerId, "dev_ken", "Ken")));
    await resolve(harness, nick.developerId, first, "discard");

    // Act
    const askedAgain = await writeDraft(deps, muteDraft(nick.developerId, "dev_ken", "Ken"));
    const whileWaiting = await writeDraft(deps, muteDraft(nick.developerId, "dev_ken", "Ken"));
    const pending = await pendingOf(harness, nick.developerId);

    // Assert — the discarded mute is asked for again; saying it once more while it waits writes nothing
    expect(askedAgain).toMatchObject({ version: 2, repeated: false, waiting: true });
    expect(whileWaiting).toMatchObject({ version: 2, repeated: true, waiting: true, discardedByPerson: false });
    expect(pending.map((draft) => draft.version)).toEqual([2]);
  });

  test("the agent's door saying again an outcome the person discarded is the one repeat against a decision", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-5b@example.com");
    const deps = depsOf(harness);
    const outcome = (provenance: WriteDraftInput["provenance"]): WriteDraftInput => ({
      developerId: nick.developerId,
      repo: "github.com/acme/api",
      kind: "outcome",
      subjectKey: "outcome:cc_s:wc_ken",
      payload: { deliveryId: "hd_1", sessionId: "cc_s", refId: "wc_ken", word: "followed", reason: null },
      provenance,
    });
    const first = idOf(await writeDraft(deps, outcome("agent_asserted")));
    await resolve(harness, nick.developerId, first, "discard");

    // Act
    const agentAgain = await writeDraft(deps, outcome("agent_asserted"));
    const personSaysIt = await writeDraft(deps, outcome("interactive_terminal_asserted"));

    // Assert
    expect(agentAgain).toMatchObject({ repeated: true, waiting: false, discardedByPerson: true });
    expect(personSaysIt).toMatchObject({ version: 2, repeated: false, waiting: true });
  });

  test("a new subject past the bound is refused; a new version of a pending subject never is", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-6@example.com");
    const deps = depsOf(harness);
    for (let index = 0; index < MAX_PENDING_DRAFT_SUBJECTS; index += 1) {
      await writeDraft(deps, muteDraft(nick.developerId, `dev_${String(index)}`));
    }

    // Act
    const beyond = await writeDraft(deps, muteDraft(nick.developerId, "dev_beyond"));
    const revised = await writeDraft(deps, muteDraft(nick.developerId, "dev_0", "changed"));

    // Assert
    expect(beyond).toEqual({ refusal: "too_many_drafts" });
    expect(revised).toMatchObject({ version: 2, repeated: false });
  });

  test("a dead draft leaves the pending list on its own, and frees its place", async () => {
    // Arrange: Nick's agent drafts a mute of Ken; Nick then mutes Ken through a confirmation
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-dead@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken-drafts-dead@example.com");
    const deps = depsOf(harness);
    await writeDraft(deps, muteDraft(nick.developerId, ken.developerId, "Ken"));
    const before = await pendingOf(harness, nick.developerId);

    // Act
    await addMute(deps, nick.developerId, ken.developerId, await seedHumanStamp(harness.db, nick.developerId));
    const after = await pendingOf(harness, nick.developerId);

    // Assert — a mute that already holds is no decision anybody can make
    expect(before).toHaveLength(1);
    expect(after).toEqual([]);
  });

  test("another person's drafts are never in one's pending set", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-7@example.com");
    const ken = await createTestDeveloper(harness, "Ken", "ken-drafts-7@example.com");
    await writeDraft(depsOf(harness), muteDraft(ken.developerId, "dev_nick"));

    // Act & Assert
    expect(await pendingOf(harness, nick.developerId)).toEqual([]);
  });

  test("the fingerprint of the pending set changes when a draft is added or superseded, and only then", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-8@example.com");
    const deps = depsOf(harness);
    await writeDraft(deps, muteDraft(nick.developerId, "dev_a"));
    const fingerprint = async () => pendingFingerprint(await pendingOf(harness, nick.developerId));
    const before = await fingerprint();

    // Act
    const unchanged = await fingerprint();
    await writeDraft(deps, muteDraft(nick.developerId, "dev_b"));
    const added = await fingerprint();
    await writeDraft(deps, muteDraft(nick.developerId, "dev_b", "renamed"));
    const superseded = await fingerprint();

    // Assert
    expect(unchanged).toBe(before);
    expect(new Set([before, added, superseded]).size).toBe(3);
  });

  test("a scope keeps a page's own kinds: a draft of another kind is outside it", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-drafts-9@example.com");
    const deps = depsOf(harness);
    await writeDraft(deps, muteDraft(nick.developerId, "dev_a"));

    // Act
    const muteScope = await readPendingDrafts(deps, nick.developerId, { scope: ["mute"] });
    const labelScope = await readPendingDrafts(deps, nick.developerId, { scope: ["label", "outcome"] });

    // Assert
    expect(muteScope).toHaveLength(1);
    expect(labelScope).toEqual([]);
  });
});
