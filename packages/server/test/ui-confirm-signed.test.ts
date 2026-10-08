/**
 * THE PAGE SHOWS EVERYTHING THE SIGNATURE COVERS (human provenance §6; review
 * M2, survivor M10).
 *
 * One assertion signs a digest over every draft's id, version, subject and
 * WHOLE payload. The confirm page is the only place a person sees those terms
 * (residual R6), so every one of them is rendered, in full: a pin's check
 * recipe, the commit it was verified at, every one of its files; a break's
 * commit; a label's and an outcome's delivery and word. A field that is signed
 * and not shown fails this test, whichever kind it belongs to.
 *
 * And the safe default holds: a person who taps without choosing confirms
 * nothing — every decision starts at "leave for later".
 */
import { describe, expect, test } from "bun:test";
import { DRAFT_KINDS, PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { createPin } from "../src/services/pins.ts";
import { pendingOf } from "./fixtures/confirm-driver.ts";
import { seedHumanStamp } from "./fixtures/human-confirmation.ts";
import { KEN_CONTEXT, REPO, createOutcomeWorld, recordPersonOutcome } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";
import { loginUi, uiGet } from "./ui-helpers.ts";

const PIN_FILES = Array.from({ length: 30 }, (_, index) => `src/very/long/directory/name/for/padding/file-${String(index).padStart(2, "0")}.ts`);

const post = (world: OutcomeWorld, method: string, path: string, body: unknown): Promise<Response> =>
  Promise.resolve(world.harness.app.request(path, jsonRequest(method, world.nick.apiKey, body)));

/** One pending draft of every kind, each with a distinctive value in every field it signs. */
const everyKindWaiting = async (world: OutcomeWorld): Promise<void> => {
  const existing = {
    id: "pin_existing",
    repo: REPO,
    surface: "Import keeps the order",
    files: ["src/import.ts"],
    check: "import, check the order",
    presence: PIN_PRESENCE_TERMINAL as typeof PIN_PRESENCE_TERMINAL,
    verifiedAtCommit: "a1b2c3d",
  };
  await createPin(
    { db: world.harness.db, now: world.harness.clock.now },
    world.nick.developerId,
    existing,
    await seedHumanStamp(world.harness.db, world.nick.developerId),
  );
  const answers = [
    await post(world, "POST", "/api/pilot-marks", {
      repo: REPO, refKind: "hint_delivery", refId: world.delivered.kenClaim, mark: "helpful", reason: "label-reason-quokka", presence: PIN_PRESENCE_TERMINAL,
    }),
    await post(world, "POST", "/api/pilot-marks", { repo: REPO, refKind: "pin", refId: "pin_existing", mark: "surface_ok", presence: PIN_PRESENCE_TERMINAL }),
    await recordPersonOutcome(world, world.nick, { ref: KEN_CONTEXT, outcome: "overrode", reason: "outcome-reason-wombat" }),
    await post(world, "POST", "/api/pins", {
      id: "pin_signed", repo: REPO, surface: "Export keeps the header", files: PIN_FILES,
      check: "HIDDEN-CHECK-RECIPE-numbat", presence: PIN_PRESENCE_TERMINAL, verifiedAtCommit: "abc1234",
    }),
    await post(world, "POST", "/api/pins/pin_existing/broke", { repo: REPO, presence: PIN_PRESENCE_TERMINAL, brokeAtCommit: "def5678" }),
    await post(world, "POST", "/api/settings/mutes", { developer: world.ken.developerId }),
    await post(world, "PUT", "/api/settings/presence", { optOut: true }),
    await post(world, "PUT", "/api/settings/presence", { optOut: false }),
  ];
  for (const answer of answers) {
    expect(answer.status).toBeLessThan(300);
  }
};

/** Every value a signed field holds, as text the page must carry. */
const signedTexts = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(signedTexts);
  }
  if (value === null || value === undefined) {
    return [];
  }
  return typeof value === "object" ? Object.values(value as Record<string, unknown>).flatMap(signedTexts) : [String(value)];
};

describe("GET /ui/confirm renders every signed field", () => {
  test("every kind's id, version, subject and whole payload — a pin's recipe, commit and all thirty files included", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    await everyKindWaiting(world);
    const pending = await pendingOf(world.harness, world.nick);
    const cookie = await loginUi(world.harness, world.nick.apiKey);

    // Act
    const html = await (await uiGet(world.harness, "/ui/confirm", cookie)).text();

    // Assert — every kind is on the page, and nothing a draft signs is missing from it
    expect(new Set(pending.drafts.map((draft) => draft.kind))).toEqual(new Set(DRAFT_KINDS.filter((kind) => kind !== "unmute")));
    for (const draft of pending.drafts) {
      for (const signed of [draft.id, `version ${String(draft.version)}`, draft.subjectKey]) {
        expect({ kind: draft.kind, signed, shown: html.includes(signed) }).toEqual({ kind: draft.kind, signed, shown: true });
      }
      for (const key of Object.keys(draft.payload)) {
        expect({ kind: draft.kind, key, shown: html.includes(`data-term="${key}"`) }).toEqual({ kind: draft.kind, key, shown: true });
      }
      for (const signed of signedTexts(draft.payload)) {
        expect({ kind: draft.kind, signed, shown: html.includes(signed) }).toEqual({ kind: draft.kind, signed, shown: true });
      }
    }
    expect(html).toContain("HIDDEN-CHECK-RECIPE-numbat");
    expect(html).toContain("file-29.ts");
    expect(html).toContain("abc1234");
    expect(html).toContain("def5678");
  });

  test("survivor M10: every decision starts at 'leave for later' — a tap without choosing confirms nothing", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });
    await everyKindWaiting(world);
    const pending = await pendingOf(world.harness, world.nick);
    const cookie = await loginUi(world.harness, world.nick.apiKey);

    // Act
    const html = await (await uiGet(world.harness, "/ui/confirm", cookie)).text();
    const decisions = [...html.matchAll(/<select name="decision">([\s\S]*?)<\/select>/g)].map((match) => match[1] ?? "");

    // Assert
    expect(decisions).toHaveLength(pending.drafts.length);
    for (const options of decisions) {
      expect(/<option value="keep" selected/.test(options)).toBe(true);
      expect(/<option value="confirm" selected/.test(options)).toBe(false);
      expect(/<option value="discard" selected/.test(options)).toBe(false);
    }
  });
});
