/**
 * THE REVIEW'S SURVIVING MUTATIONS, EACH KILLED BY A TEST (review §4).
 *
 *   - M1, M2: the two authorization lines that pick which credential may sign
 *     a `confirm_batch` — never a revoked passkey, never a colleague's;
 *   - M4: a 0.10 noise re-assertion never stands on the write path, so the
 *     person's confirmed noise is written, not swallowed as a repeat;
 *   - M5: a new version of a DECIDED subject opens a subject, so it counts
 *     against the page's bound like any new one;
 *   - M7: J8 — a confirmed outcome is written in the person's channel,
 *     whichever door drafted it.
 *
 * (M3 is in pilot-report.test.ts, proof 3; M10 in ui-confirm-signed.test.ts.)
 * Against the hub as it runs: drafts left pending, real passkeys enrolled
 * through the ceremony, real `confirm_batch` assertions, a real revocation.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { MAX_PENDING_DRAFT_SUBJECTS } from "../src/constants.ts";
import { hintOutcomes, noiseReassertions, passkeys } from "../src/db/schema.ts";
import { errorCodeOf } from "./fixtures/ceremony-driver.ts";
import { confirmPending, formBatch, pendingOf, prepareConfirmer, signBatch } from "./fixtures/confirm-driver.ts";
import type { FormedBatch } from "./fixtures/confirm-driver.ts";
import { dataOf } from "./fixtures/ceremony-driver.ts";
import {
  KEN_CONTEXT,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  recordOutcome,
  recordPersonOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { TEST_ADMIN_TOKEN, jsonRequest } from "./helpers.ts";

const MINUTE_S = 60;
const HOUR_MS = 3_600_000;

const agentSaysFollowed = async (world: OutcomeWorld): Promise<void> => {
  expect((await recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION })).status).toBe(201);
};

const mine = async (world: OutcomeWorld): Promise<Record<string, unknown>> =>
  ((await (
    await world.harness.app.request(`/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO)}`, jsonRequest("GET", world.nick.apiKey))
  ).json()) as { data: Record<string, unknown> }).data;

/** Nick's one batch over everything pending, formed in his own session. */
const nicksBatch = async (world: OutcomeWorld, viewer: Parameters<typeof formBatch>[1]): Promise<FormedBatch> => {
  const pending = await pendingOf(world.harness, world.nick);
  return dataOf<FormedBatch>(
    await formBatch(world.harness, viewer, {
      fingerprint: pending.fingerprint,
      items: pending.drafts.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm" })),
    }),
  );
};

describe("survivors M1, M2: which passkey may sign a batch", () => {
  test("M1: a passkey revoked while the prompt is up signs nothing — unknown_credential, and nothing is written", async () => {
    // Arrange — Nick's passkey and batch; the admin revokes it (a lost device) between the prompt and the tap
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const nick = await prepareConfirmer(world.harness, world.nick);
    await agentSaysFollowed(world);
    const batch = await nicksBatch(world, nick.viewer);
    const revoke = async (): Promise<void> => {
      const [row] = await world.harness.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.developerId, world.nick.developerId));
      const revoked = await world.harness.app.request(
        `/api/developers/${world.nick.developerId}/passkeys/${String(row?.id)}/revoke`,
        jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
      );
      expect(revoked.status).toBe(200);
    };

    // Act
    const signed = await signBatch(world.harness, nick, batch.batchId, revoke);

    // Assert
    expect(signed.status).toBe(422);
    expect(await errorCodeOf(signed)).toBe("unknown_credential");
    expect(await world.harness.db.select().from(hintOutcomes)).toEqual([]);
  });

  test("M2: a colleague's passkey signs nothing of mine — unknown_credential, and nothing is written", async () => {
    // Arrange — Nick's batch in Nick's session; Ken holds a passkey of his own
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const nick = await prepareConfirmer(world.harness, world.nick);
    const ken = await prepareConfirmer(world.harness, world.ken);
    await agentSaysFollowed(world);
    const batch = await nicksBatch(world, nick.viewer);

    // Act — Ken's credential over Nick's batch, from Nick's session
    const signed = await signBatch(world.harness, { ...nick, credential: ken.credential, nextCount: ken.nextCount }, batch.batchId);

    // Assert
    expect(signed.status).toBe(422);
    expect(await errorCodeOf(signed)).toBe("unknown_credential");
    expect(await world.harness.db.select().from(hintOutcomes)).toEqual([]);
  });
});

describe("survivor M4: a 0.10 re-assertion never stands on the write path", () => {
  const sayNoise = async (world: OutcomeWorld): Promise<void> => {
    const said = await world.harness.app.request(
      "/api/pilot-marks",
      jsonRequest("POST", world.nick.apiKey, {
        repo: REPO,
        refKind: "hint_delivery",
        refId: world.delivered.kenContext,
        mark: "noise",
        presence: PIN_PRESENCE_TERMINAL,
      }),
    );
    expect(said.status).toBe(201);
  };

  test("noise said again over the person's confirmed word is written, whatever a 0.10 re-assertion says", async () => {
    // Arrange — the person's confirmed noise, then their confirmed followed over it
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    const confirmAll = async (): Promise<void> => {
      world.harness.clock.advanceSeconds(MINUTE_S);
      expect((await confirmPending(world.harness, world.nick, confirmer)).status).toBe(200);
      world.harness.clock.advanceSeconds(MINUTE_S);
    };
    await sayNoise(world);
    await confirmAll();
    expect((await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed" })).status).toBe(201);
    await confirmAll();
    // A 0.10 re-assertion dated after both — a hub clock that ran ahead before the upgrade
    await world.harness.db.insert(noiseReassertions).values({
      id: "nr_legacy",
      repo: REPO,
      deliveryId: world.delivered.kenContext,
      markedBy: world.nick.developerId,
      reason: null,
      createdAt: new Date(world.harness.clock.now().getTime() + HOUR_MS),
      provenance: "unknown_legacy",
      confirmationId: null,
    });

    // Act — the person says noise again, and confirms it
    await sayNoise(world);
    await confirmAll();
    const written = await world.harness.db.select({ provenance: noiseReassertions.provenance }).from(noiseReassertions);

    // Assert — a confirmed re-assertion is written beside the 0.10 one, and the person's noise stands
    expect(written.map((row) => row.provenance).sort()).toEqual(["human_passkey_confirmed", "unknown_legacy"]);
    expect(await mine(world)).toMatchObject({ followed: 0, noise: 1 });
  });
});

describe("survivor M5: a decided subject said again opens a subject", () => {
  test("at the bound, a new version of a confirmed subject is refused like any new subject", async () => {
    // Arrange — one outcome confirmed, then the page filled with pin drafts
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick);
    await agentSaysFollowed(world);
    world.harness.clock.advanceSeconds(MINUTE_S);
    expect((await confirmPending(world.harness, world.nick, confirmer)).status).toBe(200);
    for (let index = 0; index < MAX_PENDING_DRAFT_SUBJECTS; index += 1) {
      const pin = await world.harness.app.request(
        "/api/pins",
        jsonRequest("POST", world.nick.apiKey, {
          id: `pin_bound_${String(index)}`,
          repo: REPO,
          surface: "Play button plays/pauses",
          files: ["src/workbench/PlaybackControls.tsx"],
          check: "open /workbench, press Play",
          presence: PIN_PRESENCE_TERMINAL,
          verifiedAtCommit: "abc1234",
        }),
      );
      expect(pin.status).toBe(202);
    }

    // Act — the confirmed outcome, said otherwise
    const again = await recordOutcome(world, world.nick, {
      ref: KEN_CONTEXT,
      outcome: "overrode",
      reason: "kept the existing cache key",
      session: NICK_SESSION,
    });

    // Assert
    expect(again.status).toBe(422);
    expect(await errorCodeOf(again)).toBe("too_many_drafts");
    expect((await pendingOf(world.harness, world.nick)).drafts).toHaveLength(MAX_PENDING_DRAFT_SUBJECTS);
  });
});

describe("survivor M7: J8, the channel of a confirmed word", () => {
  test("the agent's drafted outcome, once the person confirms it, is written in the person's channel", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });
    await agentSaysFollowed(world);
    world.harness.clock.advanceSeconds(MINUTE_S);

    // Act
    expect((await confirmPending(world.harness, world.nick, confirmer)).status).toBe(200);
    world.harness.clock.advanceSeconds(MINUTE_S);
    const rows = await world.harness.db
      .select({ recordedVia: hintOutcomes.recordedVia, provenance: hintOutcomes.provenance })
      .from(hintOutcomes);

    // Assert
    expect(rows).toEqual([{ recordedVia: "person", provenance: "human_passkey_confirmed" }]);
    expect(await mine(world)).toMatchObject({ followed: 1 });
  });
});
