/**
 * THE HARD INVARIANT (human provenance §5): every pilot metric, outcome figure,
 * `--mine` line, attribution and team row counts ONLY `human_passkey_confirmed`
 * as a person's judgement.
 *
 * Walks every producer in test/human-judgement-producers.ts. A world holds the
 * same judgements in every class that is NOT human — the agent's door, the
 * terminal's door, and rows from before 0.11 — and every producer must read
 * zero. Then the drafts are confirmed through the real batch ceremony (a
 * software authenticator, a passkey enrolled moments ago) and every producer
 * must read exactly what was confirmed, the legacy rows still outside. A
 * completeness guard fails on a source that reads a judgement table and is
 * in neither the producer list nor the exempt list.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

import { PASSKEY_COOLOFF_HOURS } from "../src/constants.ts";
import {
  hintOutcomes,
  noiseReassertions,
  pilotAttributions,
  pilotMarks,
  pilotSessions,
  pinFiles,
  pins,
} from "../src/db/schema.ts";
import { assertViaUi, viewerOf } from "./fixtures/ceremony-driver.ts";
import { confirmPending, prepareConfirmer } from "./fixtures/confirm-driver.ts";
import type { Confirmer } from "./fixtures/confirm-driver.ts";
import {
  KEN_CLAIM,
  KEN_CONTEXT,
  NICK_SESSION,
  REPO,
  createOutcomeWorld,
  recordOutcome,
  recordPersonOutcome,
} from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { HUMAN_JUDGEMENT_PRODUCERS, JUDGEMENT_READERS_EXEMPT } from "./human-judgement-producers.ts";
import { TEST_ADMIN_TOKEN, jsonRequest } from "./helpers.ts";

const SECONDS_PER_HOUR = 3600;
const SURFACE = "Export keeps the header";
const LEGACY_SURFACE = "Import keeps the order";
const SRC_ROOT = new URL("../", import.meta.url).pathname;

const ok = async (response: Response | Promise<Response>, what: string): Promise<void> => {
  const answered = await response;
  if (answered.status >= 300) {
    throw new Error(`${what}: ${String(answered.status)} ${await answered.text()}`);
  }
};

const post = (world: OutcomeWorld, path: string, body: unknown): Promise<Response> =>
  Promise.resolve(world.harness.app.request(path, jsonRequest("POST", world.nick.apiKey, body)));

const label = (world: OutcomeWorld, refId: string, mark: string, reason?: string): Promise<Response> =>
  post(world, "/api/pilot-marks", {
    repo: REPO,
    refKind: "hint_delivery",
    refId,
    mark,
    presence: "controlling_terminal",
    ...(reason === undefined ? {} : { reason }),
  });

const pinBody = (id: string): Record<string, unknown> => ({
  id,
  repo: REPO,
  surface: SURFACE,
  files: ["src/export.ts"],
  check: "export, open the csv",
  presence: "controlling_terminal",
  verifiedAtCommit: "abc1234",
});

/** Rows a 0.10 hub would hold: no provenance was ever recorded for them. */
const seedLegacy = async (world: OutcomeWorld): Promise<void> => {
  const { db } = world.harness;
  const at = world.harness.clock.now();
  const legacy = { provenance: "unknown_legacy" as const, confirmationId: null };
  await db.insert(pilotMarks).values({
    id: "pm_legacy_helpful", repo: REPO, refKind: "hint_delivery", refId: world.delivered.kenClaim, mark: "helpful",
    markedBy: world.nick.developerId, captureMode: "human", createdAt: at, reason: "an old reason", ...legacy,
  });
  await db.insert(hintOutcomes).values({
    id: "ho_legacy", repo: REPO, deliveryId: world.delivered.mikeContext, outcome: "followed", reason: null,
    recordedBy: world.nick.developerId, createdAt: at, recordedVia: "person", ...legacy,
  });
  await db.insert(noiseReassertions).values({
    id: "nr_legacy", repo: REPO, deliveryId: world.delivered.kenClaim, markedBy: world.nick.developerId,
    reason: null, createdAt: at, ...legacy,
  });
  const legacyPin = {
    repo: REPO, surface: LEGACY_SURFACE, verifiedBy: world.nick.developerId, verifiedAtCommit: "a1b2c3d",
    verifiedAt: at, checkRecipe: "import, check the order", captureMode: "human" as const, createdAt: at, ...legacy,
  };
  await db.insert(pins).values({
    ...legacyPin, id: "pin_legacy", brokeAt: at, brokeBy: world.nick.developerId, brokeAtCommit: "b2c3d4e",
    brokeProvenance: "unknown_legacy",
  });
  await db.insert(pinFiles).values({ pinId: "pin_legacy", repo: REPO, path: "src/import.ts", status: "present" });
  await db.insert(pilotAttributions).values({
    id: "pa_legacy", repo: REPO, pinId: "pin_legacy", outcome: "ranked", falsifier: "recorded_break",
    topSessionId: NICK_SESSION, topLift: 1, candidates: 1, coverageJudgeable: true, answeredAt: at,
  });
  world.harness.clock.advanceSeconds(60);
  await db.insert(pins).values({
    ...legacyPin, id: "pin_legacy_repair", createdAt: world.harness.clock.now(), repairsPinId: "pin_legacy", repairsPinVersion: 1,
  });
  await db.insert(pilotMarks).values({
    id: "pm_legacy_ok", repo: REPO, refKind: "pin", refId: "pin_legacy_repair", mark: "surface_ok",
    markedBy: world.nick.developerId, captureMode: "human", createdAt: world.harness.clock.now(), reason: null, ...legacy,
  });
  // A measurement row, not a judgement: Nick's session in the discovery cohort.
  await db.insert(pilotSessions).values({
    sessionId: NICK_SESSION, repo: REPO, observedAt: at, endReason: "reported", cohort: "discovery", slot: 1, coverage: [],
  });
};

/** Every non-human class: the agent's door, the terminal's doors, and 0.10 rows. */
const nonHumanWorld = async (): Promise<OutcomeWorld> => {
  const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
  await ok(recordOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION }), "agent outcome");
  await ok(recordPersonOutcome(world, world.nick, { ref: KEN_CLAIM, outcome: "overrode", reason: "kept the retry on the hub" }), "terminal outcome");
  await ok(label(world, world.delivered.kenContext, "helpful", "saved me an hour"), "terminal helpful");
  await ok(label(world, world.delivered.mikeContext, "noise"), "terminal noise");
  await ok(post(world, "/api/pins", pinBody("pin_human")), "terminal pin");
  await seedLegacy(world);
  return world;
};

const readAll = async (world: OutcomeWorld): Promise<Readonly<Record<string, Readonly<Record<string, number>>>>> => {
  const entries = await Promise.all(
    Object.entries(HUMAN_JUDGEMENT_PRODUCERS).map(async ([name, producer]) => [name, await producer.read(world)] as const),
  );
  return Object.fromEntries(entries);
};

const confirmAll = async (world: OutcomeWorld, confirmer: Confirmer): Promise<void> => {
  world.harness.clock.advanceSeconds(1);
  await ok(confirmPending(world.harness, world.nick, confirmer), "confirmation");
};

describe("only human_passkey_confirmed counts as a person's judgement", () => {
  test("no producer counts the agent's, the terminal's or a 0.10 row's word", async () => {
    // Arrange
    const world = await nonHumanWorld();

    // Act
    const counts = await readAll(world);

    // Assert — every number every producer presents as people's judgement is zero
    for (const [name, values] of Object.entries(counts)) {
      expect({ name, values }).toEqual({ name, values: Object.fromEntries(Object.keys(values).map((key) => [key, 0])) });
    }
  });

  test("confirmed through the batch ceremony, each producer counts exactly what was confirmed — and the legacy rows stay out", async () => {
    // Arrange
    const { world } = await confirmedWorld({ pastCoolOff: true });

    // Act
    const counts = await readAll(world);

    // Assert
    expect(counts).toEqual(EXACTLY_CONFIRMED);
  });

  test("H1: confirmed with a passkey still cooling off, no producer counts it until the cool-off ends — then each counts exactly", async () => {
    // Arrange — Q19: a passkey enrolled moments ago confirms at once
    const { world } = await confirmedWorld({ pastCoolOff: false });

    // Act
    const whileCooling = await readAll(world);
    world.harness.clock.advanceSeconds(PASSKEY_COOLOFF_HOURS * SECONDS_PER_HOUR);
    const afterCoolOff = await readAll(world);

    // Assert
    expect(whileCooling).toEqual(zeroesOf(EXACTLY_CONFIRMED));
    expect(afterCoolOff).toEqual(EXACTLY_CONFIRMED);
  });

  test("H1: declaring the passkey that confirmed compromised retracts every producer's count to zero", async () => {
    // Arrange — every round confirmed; a second passkey of the person's
    const { world, confirmer } = await confirmedWorld({ pastCoolOff: true });
    const other = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: true });

    // Act — the second passkey declares the first compromised (round-2 R2-H3)
    const revoked = await assertViaUi(
      world.harness,
      await viewerOf(world.harness, world.nick),
      other.credential,
      { action: "revoke_passkey", subjectId: confirmer.passkeyId, reason: "compromised" },
      { signCount: other.nextCount() },
    );
    const counts = await readAll(world);

    // Assert
    expect(revoked.status).toBe(200);
    expect(counts).toEqual(zeroesOf(EXACTLY_CONFIRMED));
  });

  test("R2-H3: retiring the passkey that confirmed (a lost device) keeps every producer's count", async () => {
    // Arrange
    const { world, confirmer } = await confirmedWorld({ pastCoolOff: true });

    // Act — the admin retires it (04a §4.5)
    const revoked = await world.harness.app.request(
      `/api/developers/${world.nick.developerId}/passkeys/${confirmer.passkeyId}/revoke`,
      jsonRequest("POST", TEST_ADMIN_TOKEN, {}),
    );
    const counts = await readAll(world);

    // Assert
    expect(revoked.status).toBe(200);
    expect(counts).toEqual(EXACTLY_CONFIRMED);
  });
});

/** What every producer reads once the four rounds below are confirmed. */
const EXACTLY_CONFIRMED: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "proof 4: the labelled figures (precision, benefit, coverage)": { helpful: 1, noise: 1, unclear: 0 },
  "proof 4: the reasons people typed beside a label": { reasons: 1 },
  "proof 4: the cohorts, side by side": { labelled: 2 },
  "proof 4: the noisy-sessions floor": { noisy: 1 },
  "proof 4: surface-ok marks (pin --ok)": { surfaceOk: 1 },
  "proof 3: attributions scored against a repair": { scored: 1 },
  "--mine: what the caller's hints led to": { followed: 1, overrode: 1, notRelevantNow: 0, noise: 1, helpful: 1, reasons: 2 },
  "the team line and the source credit (one closed period's aggregate)": {
    followed: 1, overrode: 1, notRelevantNow: 0, noise: 1, recorders: 1,
  },
};

const zeroesOf = (
  counts: Readonly<Record<string, Readonly<Record<string, number>>>>,
): Readonly<Record<string, Readonly<Record<string, number>>>> =>
  Object.fromEntries(
    Object.entries(counts).map(([name, values]) => [name, Object.fromEntries(Object.keys(values).map((key) => [key, 0]))]),
  );

/**
 * The non-human world, then every draft confirmed through the real ceremony in
 * four rounds: both outcomes, both labels and the pin; the pin still works; it
 * broke (suspect answered); its repair.
 */
const confirmedWorld = async (options: { readonly pastCoolOff: boolean }): Promise<{ world: OutcomeWorld; confirmer: Confirmer }> => {
    const world = await nonHumanWorld();
    const confirmer = await prepareConfirmer(world.harness, world.nick, { pastCoolOff: options.pastCoolOff });
    // Round 1: both outcomes, both labels, the pin.
    await confirmAll(world, confirmer);
    // Round 2: the pin still works.
    await ok(post(world, "/api/pilot-marks", { repo: REPO, refKind: "pin", refId: "pin_human", mark: "surface_ok", presence: "controlling_terminal" }), "pin ok");
    await confirmAll(world, confirmer);
    // Round 3: it broke; suspect answered; round 4: the repair.
    await ok(post(world, "/api/pins/pin_human/broke", { repo: REPO, presence: "controlling_terminal", brokeAtCommit: "c3d4e5f" }), "break");
    await confirmAll(world, confirmer);
    await world.harness.db.insert(pilotAttributions).values({
      id: "pa_human", repo: REPO, pinId: "pin_human", outcome: "ranked", falsifier: "recorded_break",
      topSessionId: NICK_SESSION, topLift: 1, candidates: 1, coverageJudgeable: true, answeredAt: world.harness.clock.now(),
    });
    world.harness.clock.advanceSeconds(60);
    await ok(post(world, "/api/pins", { ...pinBody("pin_human_repair"), verifiedAtCommit: "d4e5f6a" }), "repair pin");
    await confirmAll(world, confirmer);
    return { world, confirmer };
};

describe("the producer registry", () => {
  test("every source that reads a judgement table is a registered producer or exempt with its reason", async () => {
    // Arrange
    // Round-1 L2: every table a person's judgement or setting lands in, attributions,
    // drafts, mutes and privacy changes included — not only the figures' own tables.
    const reads =
      /pilot_marks|pilotMarks|hint_outcomes|hintOutcomes|noise_reassertions|noiseReassertions|repairs_pin_id|repairsPinId|broke_provenance|brokeProvenance|human_confirmation|humanConfirmation|pilot_attributions|pilotAttributions|human_drafts|humanDrafts|developer_mutes|developerMutes|privacy_changes|privacyChanges/;
    const registered = new Set(Object.values(HUMAN_JUDGEMENT_PRODUCERS).map((producer) => producer.file));
    const readers: string[] = [];
    for await (const path of new Glob("src/{services,routes}/**/*.{ts,tsx}").scan(SRC_ROOT)) {
      if (reads.test(await Bun.file(`${SRC_ROOT}${path}`).text())) {
        readers.push(path);
      }
    }

    // Act
    const unaccounted = readers.filter((path) => !registered.has(path) && JUDGEMENT_READERS_EXEMPT[path] === undefined);
    const stale = [...registered, ...Object.keys(JUDGEMENT_READERS_EXEMPT)].filter((path) => !readers.includes(path));

    // Assert
    expect(readers.length).toBeGreaterThan(0);
    expect(unaccounted).toEqual([]);
    expect(stale).toEqual([]);
  });
});
