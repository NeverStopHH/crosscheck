/**
 * THE FROZEN CONFIRMATION BATCH (human provenance §6).
 *
 * One passkey tap never means "confirm whatever is pending": the person's
 * decisions are frozen into a batch, the WebAuthn challenge is bound to that
 * batch's id and digest, and verify re-reads the pending set under lock and
 * refuses the WHOLE batch if any item changed, was added or was removed since
 * the snapshot. Driven through the real /ui endpoints with a software
 * authenticator, a passkey enrolled moments ago (Q19: no cool-off for this).
 */
import { describe, expect, test } from "bun:test";

import { hintOutcomes, humanConfirmationItems, humanConfirmations, humanDrafts, pilotMarks } from "../src/db/schema.ts";
import { dataOf, errorCodeOf } from "./fixtures/ceremony-driver.ts";
import {
  confirmPending,
  formBatch,
  pendingOf,
  prepareConfirmer,
  signBatch,
} from "./fixtures/confirm-driver.ts";
import type { FormedBatch } from "./fixtures/confirm-driver.ts";
import { assertViaUi, ceremony } from "./fixtures/ceremony-driver.ts";
import { softAuthenticationResponse } from "./fixtures/soft-authenticator.ts";
import {
  KEN_CLAIM,
  KEN_CONTEXT,
  MIKE_CONTEXT,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  recordOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { TEST_ADMIN_TOKEN, TEST_WEBAUTHN_ORIGIN, jsonRequest } from "./helpers.ts";

const agentSays = async (world: OutcomeWorld, ref: string, outcome: string, reason?: string): Promise<void> => {
  const response = await recordOutcome(world, world.nick, {
    ref,
    outcome,
    session: NICK_SESSION,
    ...(reason === undefined ? {} : { reason }),
  });
  expect(response.status).toBe(201);
};

const outcomesOf = (world: OutcomeWorld) =>
  world.harness.db
    .select({
      outcome: hintOutcomes.outcome,
      reason: hintOutcomes.reason,
      provenance: hintOutcomes.provenance,
      confirmationId: hintOutcomes.confirmationId,
    })
    .from(hintOutcomes);

describe("a confirmation batch", () => {
  test("one assertion makes the agent's drafts the person's: human_passkey_confirmed, naming the confirmation; the drafts untouched", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    await agentSays(world, KEN_CLAIM, "overrode", "kept the retry on the hub");
    const draftsBefore = await world.harness.db.select().from(humanDrafts);
    const confirmer = await prepareConfirmer(world.harness, world.nick);

    // Act
    const verified = await confirmPending(world.harness, world.nick, confirmer);
    const stored = await outcomesOf(world);
    const confirmations = await world.harness.db.select().from(humanConfirmations);

    // Assert
    expect(verified.status).toBe(200);
    expect(stored.map((row) => [row.outcome, row.provenance]).sort()).toEqual([
      ["followed", "human_passkey_confirmed"],
      ["overrode", "human_passkey_confirmed"],
    ]);
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]?.credentialId).toBe(confirmer.credential.id);
    expect(stored.every((row) => row.confirmationId === confirmations[0]?.id)).toBe(true);
    expect(await world.harness.db.select().from(humanDrafts)).toEqual(draftsBefore);
    expect((await pendingOf(world.harness, world.nick)).drafts).toEqual([]);
  });

  test("an edit is stored exactly as signed: the person turns the agent's followed into overrode, with a reason", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const confirmer = await prepareConfirmer(world.harness, world.nick);

    // Act
    const verified = await confirmPending(world.harness, world.nick, confirmer, () => ({
      decision: "confirm",
      word: "overrode",
      reason: "my retry was simpler",
    }));

    // Assert
    expect(verified.status).toBe(200);
    expect((await outcomesOf(world)).map((row) => [row.outcome, row.reason])).toEqual([["overrode", "my retry was simpler"]]);
    const items = await world.harness.db.select().from(humanConfirmationItems);
    expect(items.map((item) => item.content)).toEqual([
      expect.objectContaining({ word: "overrode", reason: "my retry was simpler" }),
    ]);
  });

  test("discard writes nothing and resolves the draft; keep leaves it pending", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    await agentSays(world, MIKE_CONTEXT, "not_relevant_now");
    const confirmer = await prepareConfirmer(world.harness, world.nick);

    // Act
    const verified = await confirmPending(world.harness, world.nick, confirmer, (draft) => ({
      decision: draft.payload["refId"] === KEN_CONTEXT ? "discard" : "keep",
    }));
    const pending = await pendingOf(world.harness, world.nick);

    // Assert
    expect(verified.status).toBe(200);
    expect(await outcomesOf(world)).toEqual([]);
    expect(pending.drafts.map((draft) => draft.payload["refId"])).toEqual([MIKE_CONTEXT]);
  });

  test("an edit that could never be stored is refused when the batch is formed: a reason holding a secret", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const [draft] = pending.drafts;
    if (draft === undefined) {
      throw new Error("no draft");
    }

    // Act
    const formed = await formBatch(world.harness, confirmer.viewer, {
      fingerprint: pending.fingerprint,
      items: [{ draftId: draft.id, version: draft.version, decision: "confirm", word: "overrode", reason: "api key sk-ant-REDACTED-0000000000000000000000000000" }],
    });

    // Assert
    expect(formed.status).toBe(422);
    expect(await errorCodeOf(formed)).toBe("reason_secret");
  });

  test("a writer's refusal at confirm time rolls the WHOLE batch back and names nothing as confirmed", async () => {
    // Arrange: an outcome and a pin; the team narrows who may pin between the batch and the tap
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    await world.harness.app.request("/api/pins", jsonRequest("POST", world.nick.apiKey, {
      id: "pin_batch_refused", repo: REPO, surface: "Export keeps the header", files: ["src/never-touched.ts"],
      check: "export, open the csv", presence: "controlling_terminal", verifiedAtCommit: "abc1234",
    }));
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const batch = await dataOf<FormedBatch>(
      await formBatch(world.harness, confirmer.viewer, {
        fingerprint: pending.fingerprint,
        items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm" })),
      }),
    );
    await world.harness.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pinPolicy: "touched_files" }));

    // Act
    const verified = await signBatch(world.harness, confirmer, batch.batchId);

    // Assert
    expect(pending.drafts.map((draft) => draft.kind).sort()).toEqual(["outcome", "pin"]);
    expect(verified.status).toBe(422);
    expect(await errorCodeOf(verified)).toBe("item_refused");
    expect(await outcomesOf(world)).toEqual([]);
    expect(await world.harness.db.select().from(humanConfirmations)).toEqual([]);
    expect((await pendingOf(world.harness, world.nick)).drafts).toHaveLength(2);
  });

  test("a draft that dies between the snapshot and the tap refuses the whole batch", async () => {
    // Arrange: the repo leaves the pilot, so no outcome there can count any more
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const batch = await dataOf<FormedBatch>(
      await formBatch(world.harness, confirmer.viewer, {
        fingerprint: pending.fingerprint,
        items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm" })),
      }),
    );
    await world.harness.app.request("/api/team-settings", jsonRequest("PUT", TEST_ADMIN_TOKEN, { repo: REPO, pilotEnrolled: false }));

    // Act
    const verified = await signBatch(world.harness, confirmer, batch.batchId);

    // Assert — and the dead draft has left the list on its own
    expect(verified.status).toBe(422);
    expect(await errorCodeOf(verified)).toBe("pending_changed");
    expect(await outcomesOf(world)).toEqual([]);
    expect((await pendingOf(world.harness, world.nick)).drafts).toEqual([]);
  });

  test("labels confirm into pilot_marks, and a pin's ok into a surface-ok mark", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await world.harness.app.request("/api/pilot-marks", jsonRequest("POST", world.nick.apiKey, {
      repo: REPO, refKind: "hint_delivery", refId: world.delivered.kenContext, mark: "helpful", reason: "saved me an hour", presence: "controlling_terminal",
    }));
    const confirmer = await prepareConfirmer(world.harness, world.nick);

    // Act
    const verified = await confirmPending(world.harness, world.nick, confirmer);
    const marks = await world.harness.db
      .select({ mark: pilotMarks.mark, reason: pilotMarks.reason, provenance: pilotMarks.provenance })
      .from(pilotMarks);

    // Assert
    expect(verified.status).toBe(200);
    expect(marks).toEqual([{ mark: "helpful", reason: "saved me an hour", provenance: "human_passkey_confirmed" }]);
  });
});

describe("the batch is frozen: what was reviewed is what is signed", () => {
  test("TOCTOU: a draft added between the snapshot and the assertion is in no batch — never confirmed by this one", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const batch = await dataOf<FormedBatch>(
      await formBatch(world.harness, confirmer.viewer, {
        fingerprint: pending.fingerprint,
        items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm" })),
      }),
    );

    // Act: the agent slips in a word about ANOTHER hint while the person reads the prompt
    const verified = await signBatch(world.harness, confirmer, batch.batchId, async () => {
      await agentSays(world, MIKE_CONTEXT, "followed");
    });
    const stillPending = (await pendingOf(world.harness, world.nick)).drafts;

    // Assert — the batch held only what the person saw; the newcomer waits for its own review
    expect(verified.status).toBe(200);
    expect((await outcomesOf(world)).map((row) => row.outcome)).toEqual(["followed"]);
    expect(stillPending.map((draft) => draft.payload["refId"])).toEqual([MIKE_CONTEXT]);
  });

  test("TOCTOU: an item decided by another batch between the snapshot and the assertion refuses the whole batch", async () => {
    // Arrange: two browser sessions of the person, each with a batch over the same draft
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const first = await prepareConfirmer(world.harness, world.nick);
    world.harness.clock.advanceSeconds(1);
    const second = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const items = pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version }));
    const discardBatch = await dataOf<FormedBatch>(
      await formBatch(world.harness, first.viewer, { fingerprint: pending.fingerprint, items: items.map((item) => ({ ...item, decision: "discard" as const })) }),
    );
    const confirmBatch = await dataOf<FormedBatch>(
      await formBatch(world.harness, second.viewer, { fingerprint: pending.fingerprint, items: items.map((item) => ({ ...item, decision: "confirm" as const })) }),
    );

    // Act
    const discarded = await signBatch(world.harness, first, discardBatch.batchId);
    const confirmed = await signBatch(world.harness, second, confirmBatch.batchId);

    // Assert
    expect(discarded.status).toBe(200);
    expect(confirmed.status).toBe(422);
    expect(await errorCodeOf(confirmed)).toBe("pending_changed");
    expect(await outcomesOf(world)).toEqual([]);
  });

  test("TOCTOU: a draft edited (a newer version) between the snapshot and the assertion refuses the whole batch", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const batch = await dataOf<FormedBatch>(
      await formBatch(world.harness, confirmer.viewer, {
        fingerprint: pending.fingerprint,
        items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm" })),
      }),
    );

    // Act
    const verified = await signBatch(world.harness, confirmer, batch.batchId, async () => {
      await agentSays(world, KEN_CONTEXT, "overrode", "changed its mind");
    });

    // Assert
    expect(verified.status).toBe(422);
    expect(await errorCodeOf(verified)).toBe("pending_changed");
    expect(await outcomesOf(world)).toEqual([]);
  });

  test("TOCTOU: a page older than the pending set cannot even form a batch", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    await agentSays(world, MIKE_CONTEXT, "followed");

    // Act
    const formed = await formBatch(world.harness, confirmer.viewer, {
      fingerprint: pending.fingerprint,
      items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm" })),
    });

    // Assert
    expect(formed.status).toBe(422);
    expect(await errorCodeOf(formed)).toBe("pending_changed");
  });

  test("a batch must decide every pending draft — leaving one out is refused", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    await agentSays(world, MIKE_CONTEXT, "followed");
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const [first] = pending.drafts;
    if (first === undefined) {
      throw new Error("no draft");
    }

    // Act
    const formed = await formBatch(world.harness, confirmer.viewer, {
      fingerprint: pending.fingerprint,
      items: [{ draftId: first.id, version: first.version, decision: "confirm" }],
    });

    // Assert
    expect(formed.status).toBe(422);
    expect(await errorCodeOf(formed)).toBe("pending_changed");
  });

  test("replay: the same signed answer sent again is refused, and the batch is confirmed once", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const batch = await dataOf<FormedBatch>(
      await formBatch(world.harness, confirmer.viewer, {
        fingerprint: pending.fingerprint,
        items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm" })),
      }),
    );
    const fields = { action: "confirm_batch", subjectId: batch.batchId };
    const options = await dataOf<{ ceremonyId: string; publicKey: { challenge: string } }>(
      await ceremony(world.harness, confirmer.viewer, "options", fields),
    );
    const body = {
      ...fields,
      ceremonyId: options.ceremonyId,
      response: softAuthenticationResponse({
        credential: confirmer.credential,
        challenge: options.publicKey.challenge,
        origin: TEST_WEBAUTHN_ORIGIN,
        rpId: "localhost",
        signCount: confirmer.nextCount(),
      }),
    };

    // Act
    const first = await ceremony(world.harness, confirmer.viewer, "verify", body);
    const replayed = await ceremony(world.harness, confirmer.viewer, "verify", body);
    const reminted = await ceremony(world.harness, confirmer.viewer, "options", fields);

    // Assert
    expect(first.status).toBe(200);
    expect(replayed.status).toBe(422);
    expect(reminted.status).toBe(422);
    expect(await errorCodeOf(reminted)).toBe("unknown_batch");
    expect(await world.harness.db.select().from(humanConfirmations)).toHaveLength(1);
    expect(await outcomesOf(world)).toHaveLength(1);
  });

  test("cross-batch: an assertion over one batch's challenge cannot confirm another batch", async () => {
    // Arrange: two batches over the same pending set — one confirms, one discards
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const formWith = async (decision: "confirm" | "discard") =>
      dataOf<FormedBatch>(
        await formBatch(world.harness, confirmer.viewer, {
          fingerprint: pending.fingerprint,
          items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision })),
        }),
      );
    const discard = await formWith("discard");
    const confirm = await formWith("confirm");
    const discardOptions = await dataOf<{ ceremonyId: string; publicKey: { challenge: string } }>(
      await ceremony(world.harness, confirmer.viewer, "options", { action: "confirm_batch", subjectId: discard.batchId }),
    );
    const confirmOptions = await dataOf<{ ceremonyId: string; publicKey: { challenge: string } }>(
      await ceremony(world.harness, confirmer.viewer, "options", { action: "confirm_batch", subjectId: confirm.batchId }),
    );

    const signedForDiscard = (signCount: number) =>
      softAuthenticationResponse({
        credential: confirmer.credential,
        challenge: discardOptions.publicKey.challenge,
        origin: TEST_WEBAUTHN_ORIGIN,
        rpId: "localhost",
        signCount,
      });

    // Act: the person signed the DISCARD prompt; the answer is posted as the CONFIRM batch —
    // first on the discard ceremony itself, then on the confirm batch's own ceremony
    const sameCeremony = await ceremony(world.harness, confirmer.viewer, "verify", {
      action: "confirm_batch",
      subjectId: confirm.batchId,
      ceremonyId: discardOptions.ceremonyId,
      response: signedForDiscard(confirmer.nextCount()),
    });
    const otherCeremony = await ceremony(world.harness, confirmer.viewer, "verify", {
      action: "confirm_batch",
      subjectId: confirm.batchId,
      ceremonyId: confirmOptions.ceremonyId,
      response: signedForDiscard(confirmer.nextCount()),
    });

    // Assert
    expect(discard.digest).not.toBe(confirm.digest);
    expect(sameCeremony.status).toBe(422);
    expect(otherCeremony.status).toBe(422);
    expect(await outcomesOf(world)).toEqual([]);
    expect(await world.harness.db.select().from(humanConfirmations)).toEqual([]);
  });

  test("a batch belongs to the session that formed it: another session cannot sign it", async () => {
    // Arrange: the agent forms a batch in its own UI session
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const agentsSession = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const batch = await dataOf<FormedBatch>(
      await formBatch(world.harness, agentsSession.viewer, {
        fingerprint: pending.fingerprint,
        items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm" })),
      }),
    );
    // A session token is deterministic in its instant: the person logs in a second later.
    world.harness.clock.advanceSeconds(1);
    const persons = await prepareConfirmer(world.harness, world.nick);
    expect(persons.viewer.cookie).not.toBe(agentsSession.viewer.cookie);

    // Act
    const signed = await assertViaUi(world.harness, persons.viewer, persons.credential, {
      action: "confirm_batch",
      subjectId: batch.batchId,
    });

    // Assert
    expect(signed.status).toBe(422);
    expect(await errorCodeOf(signed)).toBe("unknown_batch");
    expect(await outcomesOf(world)).toEqual([]);
  });

  test("the digest covers the decisions: confirming and discarding the same set sign different terms", async () => {
    // Arrange
    const world = await createOutcomeWorld();
    await agentSays(world, KEN_CONTEXT, "followed");
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    const pending = await pendingOf(world.harness, world.nick);
    const formWith = async (word: string) =>
      dataOf<FormedBatch>(
        await formBatch(world.harness, confirmer.viewer, {
          fingerprint: pending.fingerprint,
          items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm", word })),
        }),
      );

    // Act
    const followed = await formWith("followed");
    const overrode = await formWith("not_relevant_now");

    // Assert
    expect(followed.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(followed.digest).not.toBe(overrode.digest);
  });
});
