/**
 * REFUSING DRAFTS FROM CLIENTS OLDER THAN 0.11 (human provenance §10, round
 * 2): an opt-in hub setting, `CROSSCHECK_REFUSE_PRE_011_DRAFTS`.
 *
 * A 0.10 client sends no release and says "recorded" over what the hub only
 * drafted. With the setting on, every drafting door refuses a request that
 * names no release, or an older one, with one sentence the 0.10 CLI prints as
 * it is. Reads and switching presence off are never refused. Not a security
 * control: any program can send the header (docs/OPERATIONS.md says so).
 */
import { describe, expect, test } from "bun:test";
import { CLIENT_RELEASE, CLIENT_RELEASE_HEADER, PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import {
  PRE_DRAFTING_CLIENT_SENTENCE,
  parseRefusePreDraftingClients,
} from "../src/http/client-release.ts";
import { MAX_REFUSAL_CHARS, asRendered } from "../src/services/refusal.ts";
import { pendingOf } from "./fixtures/confirm-driver.ts";
import { KEN_CONTEXT, NICK_SESSION, REPO, createOutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";

const NEWER_RELEASE = "0.12.0";
const OLDER_RELEASE = "0.10.0";

/** A request from a client of `release`, or from one that names none (a 0.10 client). */
const from = (world: OutcomeWorld, method: string, path: string, body: unknown, release: string | null): Promise<Response> => {
  const init = jsonRequest(method, world.nick.apiKey, body);
  const headers = new Headers(init.headers);
  if (release !== null) {
    headers.set(CLIENT_RELEASE_HEADER, release);
  }
  return Promise.resolve(world.harness.app.request(path, { ...init, headers }));
};

const refusedWith = async (response: Response): Promise<unknown> => ({
  status: response.status,
  error: ((await response.json()) as { error?: unknown }).error,
});

const REFUSAL = { status: 422, error: { code: "client_upgrade_required", message: PRE_DRAFTING_CLIENT_SENTENCE } };

/** A label drafted as before: the door's 201 and its draft flag. */
const DRAFTED = { status: 201, draft: true };

const draftedWith = async (response: Response): Promise<unknown> => ({
  status: response.status,
  draft: ((await response.json()) as { data?: { draft?: unknown } }).data?.draft,
});

/** Every door that drafts, with the body a 0.10 client would send it. */
const DRAFTING_DOORS = (world: OutcomeWorld): readonly (readonly [string, string, unknown])[] => [
  ["POST", "/api/pilot-marks", { repo: REPO, refKind: "hint_delivery", refId: world.delivered.kenContext, mark: "noise", presence: PIN_PRESENCE_TERMINAL }],
  ["POST", "/api/hint-outcomes", { repo: REPO, ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION }],
  ["POST", "/api/hint-outcomes/person", { repo: REPO, ref: KEN_CONTEXT, outcome: "followed", session: NICK_SESSION }],
  ["POST", "/api/pins", { id: "pin_old_client", repo: REPO, surface: "Play button plays", files: ["src/player.ts"], check: "press Play", presence: PIN_PRESENCE_TERMINAL, verifiedAtCommit: "abc1234" }],
  ["POST", "/api/pins/pin_old_client/broke", { repo: REPO, presence: PIN_PRESENCE_TERMINAL }],
  ["POST", "/api/settings/mutes", { developer: "Ken" }],
  ["DELETE", "/api/settings/mutes/Ken", undefined],
  ["PUT", "/api/settings/presence", { optOut: false }],
];

describe("CROSSCHECK_REFUSE_PRE_011_DRAFTS on", () => {
  test("every drafting door refuses a client that names no release, with the sentence a 0.10 CLI prints — and drafts nothing", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending", refusePreDraftingClients: true });

    // Act
    const answers = [];
    for (const [method, path, body] of DRAFTING_DOORS(world)) {
      answers.push({ door: `${method} ${path}`, ...((await refusedWith(await from(world, method, path, body, null))) as object) });
    }

    // Assert
    expect(answers).toEqual(DRAFTING_DOORS(world).map(([method, path]) => ({ door: `${method} ${path}`, ...REFUSAL })));
    expect((await pendingOf(world.harness, world.nick)).drafts).toHaveLength(0);
  });

  test("an older release is refused; this client's release and a newer one draft", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending", refusePreDraftingClients: true });
    const label = (release: string | null, mark: "noise" | "helpful") =>
      from(world, "POST", "/api/pilot-marks", { repo: REPO, refKind: "hint_delivery", refId: world.delivered.kenContext, mark, presence: PIN_PRESENCE_TERMINAL }, release);

    // Act
    const older = await refusedWith(await label(OLDER_RELEASE, "noise"));
    const current = await draftedWith(await label(CLIENT_RELEASE, "noise"));
    const newer = await draftedWith(await label(NEWER_RELEASE, "helpful"));

    // Assert
    expect(older).toEqual(REFUSAL);
    expect(current).toEqual(DRAFTED);
    expect(newer).toEqual(DRAFTED);
  });

  test("switching presence off and every read are never refused", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending", refusePreDraftingClients: true });

    // Act
    const off = await from(world, "PUT", "/api/settings/presence", { optOut: true }, null);
    const reads = await Promise.all(
      ["/api/settings", `/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO)}`, "/api/confirm/status"].map((path) =>
        from(world, "GET", path, undefined, null),
      ),
    );

    // Assert
    expect(off.status).toBe(200);
    expect(reads.map((response) => response.status)).toEqual([200, 200, 200]);
  });
});

describe("CROSSCHECK_REFUSE_PRE_011_DRAFTS off (the default)", () => {
  test("a client that names no release drafts as before", async () => {
    // Arrange
    const world = await createOutcomeWorld({ enrolled: true, drafts: "pending" });

    // Act
    const answer = await from(world, "POST", "/api/pilot-marks", { repo: REPO, refKind: "hint_delivery", refId: world.delivered.kenContext, mark: "noise", presence: PIN_PRESENCE_TERMINAL }, null);

    // Assert
    expect(await draftedWith(answer)).toEqual(DRAFTED);
  });
});

describe("the setting and its sentence", () => {
  test("1 is on; unset, empty and 0 are off; anything else stops the hub", () => {
    // Assert
    expect(parseRefusePreDraftingClients("1")).toBe(true);
    expect(parseRefusePreDraftingClients(undefined)).toBe(false);
    expect(parseRefusePreDraftingClients("")).toBe(false);
    expect(parseRefusePreDraftingClients("0")).toBe(false);
    expect(() => parseRefusePreDraftingClients("yes")).toThrow("CROSSCHECK_REFUSE_PRE_011_DRAFTS");
  });

  test("the sentence fits the 0.10 client's bound and says what to do and that nothing was recorded", () => {
    // Assert
    expect(asRendered(PRE_DRAFTING_CLIENT_SENTENCE).length).toBeLessThanOrEqual(MAX_REFUSAL_CHARS);
    expect(PRE_DRAFTING_CLIENT_SENTENCE).toContain("crosscheck 0.11 or newer");
    expect(PRE_DRAFTING_CLIENT_SENTENCE).toContain("upgrade crosscheck");
    expect(PRE_DRAFTING_CLIENT_SENTENCE).toContain("nothing was recorded");
  });
});
