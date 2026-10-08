/**
 * "THE PERSON CONFIRMED IT AT ONCE" — a test-side emulation, never a hub mode.
 *
 * Since human provenance (0.11), every door a key can reach only DRAFTS a
 * label, an outcome, a pin, a break, a mute or presence-on; a passkey
 * confirmation makes it the person's. The suites written before that pin what
 * the WRITERS do with a person's word — what stands, repeats, twins, the
 * fence, suspect, the skeleton — and they set up their worlds through the
 * doors. This wrapper keeps them testing exactly that: it lets each door draft
 * as it does in production, then confirms the draft on the spot, through code
 * the hub really runs:
 *
 *   - an outcome or a label goes through its own writer with a seeded
 *     confirmation's stamp, in the door's own channel (`agent` for
 *     `/api/hint-outcomes`, `person` for `/person`), and the writer's answer
 *     is returned — the shape those suites assert on. A real confirmation
 *     always writes `person`: the agent channel among confirmed words is
 *     reached only here;
 *   - a pin, a break, a mute, an unmute or presence-on is confirmed through
 *     the real batch store (form + confirm), only the WebAuthn signature
 *     replaced by a seeded credential — the `seedPasskey` precedent — and the
 *     answer an older client read is returned.
 *
 * Production behaviour, drafts left pending, is `drafts: "pending"`
 * (helpers.ts) — what every human-provenance suite uses.
 */
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

import type { AppEnv } from "../../src/types.ts";
import { hashApiKey } from "../../src/auth/keys.ts";
import { developers, humanConfirmationItems, humanConfirmations } from "../../src/db/schema.ts";
import type { Db } from "../../src/db/client.ts";
import type { Embedder } from "../../src/services/embedder.ts";
import { createBatchStore } from "../../src/services/confirmation-batch.ts";
import { CONFIRM_PAGE_SCOPE } from "../../src/services/confirm-page.ts";
import { finishPresenceChange } from "../../src/services/developer-settings.ts";
import { writeHintOutcome } from "../../src/services/hint-outcomes.ts";
import { pendingFingerprint, readPendingDrafts } from "../../src/services/human-drafts.ts";
import { humanStamp } from "../../src/services/human-provenance.ts";
import type { HumanStamp } from "../../src/services/human-provenance.ts";
import { writePilotMark } from "../../src/services/pilot.ts";
import { seedPasskey } from "./passkeys.ts";

type App = Hono<AppEnv>;

interface Deps {
  readonly db: Db;
  readonly now: () => Date;
  /** The hub's embedder, so presence-on re-embeds what it rebuilt as the real confirmation does. */
  readonly embedder?: Embedder | null;
}

const SEEDED_ASSERTION = { authenticatorData: "seeded", clientDataJSON: "seeded", signature: "seeded", userHandle: null };

/** One seeded passkey per developer, created on first use. */
const credentialFor = (() => {
  const byDeveloper = new WeakMap<Db, Map<string, string>>();
  return async (db: Db, developerId: string): Promise<string> => {
    const known = byDeveloper.get(db) ?? new Map<string, string>();
    byDeveloper.set(db, known);
    const existing = known.get(developerId);
    if (existing !== undefined) {
      return existing;
    }
    const { credentialId } = await seedPasskey(db, developerId);
    known.set(developerId, credentialId);
    return credentialId;
  };
})();

/** A confirmation row of its own for one word — what a one-item batch would leave. */
const seededStamp = async (deps: Deps, developerId: string): Promise<HumanStamp> => {
  const id = `hc_now_${crypto.randomUUID()}`;
  const at = deps.now();
  await deps.db.insert(humanConfirmations).values({
    id,
    developerId,
    credentialId: await credentialFor(deps.db, developerId),
    rpId: "localhost",
    digest: "confirmed at once",
    pendingFingerprint: "confirmed at once",
    itemCount: 1,
    formedAt: at,
    confirmedAt: at,
    authenticatorData: SEEDED_ASSERTION.authenticatorData,
    clientDataJson: SEEDED_ASSERTION.clientDataJSON,
    signature: SEEDED_ASSERTION.signature,
    userHandle: null,
  });
  return humanStamp(id);
};

/** Marks the door's draft as decided by that confirmation, so the person's page shows nothing left over. */
const resolveDraft = async (deps: Deps, stamp: HumanStamp, draftId: string): Promise<void> => {
  await deps.db.insert(humanConfirmationItems).values({
    confirmationId: stamp.confirmationId,
    position: 0,
    draftId,
    draftVersion: 1,
    draftDigest: "confirmed at once",
    decision: "confirm",
    content: {},
  });
};

/** Every pending draft of the developer, confirmed through the real batch store. */
export const confirmDraftsDirectly = async (deps: Deps, developerId: string): Promise<void> => {
  const pending = await readPendingDrafts(deps, developerId, { scope: CONFIRM_PAGE_SCOPE });
  if (pending.length === 0) {
    return;
  }
  const store = createBatchStore(() => deps.now().getTime());
  const owner = { developerId, sessionKey: "confirmed-at-once" };
  const batch = await store.form(
    deps,
    owner,
    {
      fingerprint: pendingFingerprint(pending),
      items: pending.map((draft) => ({ draftId: draft.id, version: draft.version, decision: "confirm" as const })),
    },
    CONFIRM_PAGE_SCOPE,
  );
  if ("refusal" in batch) {
    throw new Error(`confirming at once was refused: ${batch.refusal}`);
  }
  const outcome = await store.confirm(deps, batch, { id: await credentialFor(deps.db, developerId), rpId: "localhost" }, SEEDED_ASSERTION);
  if ("refusal" in outcome) {
    throw new Error(`confirming at once was refused: ${outcome.refusal} (${String(outcome.cause)})`);
  }
  if (outcome.presenceOn) {
    await finishPresenceChange({ db: deps.db, now: deps.now, embedder: deps.embedder ?? null }, developerId, false);
  }
};

const developerOfKey = async (db: Db, init: RequestInit | undefined): Promise<string | null> => {
  const header = new Headers(init?.headers).get("authorization") ?? "";
  const key = header.replace(/^Bearer /, "");
  const rows = await db.select({ id: developers.id }).from(developers).where(eq(developers.apiKeyHash, hashApiKey(key))).limit(1);
  return rows[0]?.id ?? null;
};

const json = (data: unknown, status: number): Response => Response.json({ ok: true, data }, { status });

const refused = (code: string, status = 422): Response =>
  Response.json({ ok: false, error: { code, message: code } }, { status });

type Body = Record<string, unknown>;

const outcomeAtOnce = async (deps: Deps, developerId: string, body: Body, draftId: string, via: "agent" | "person"): Promise<Response> => {
  const stamp = await seededStamp(deps, developerId);
  const result = await writeHintOutcome(deps, {
    repo: String(body["repo"]),
    ref: String(body["ref"]),
    outcome: body["outcome"] as "followed",
    reason: typeof body["reason"] === "string" ? body["reason"].trim() : null,
    session: typeof body["session"] === "string" ? body["session"] : null,
    recordedBy: developerId,
    recordedVia: via,
    stamp,
  });
  if ("refusal" in result) {
    return refused(result.refusal);
  }
  await resolveDraft(deps, stamp, draftId);
  return json(result, result.repeated ? 200 : 201);
};

const labelAtOnce = async (deps: Deps, developerId: string, body: Body, draftId: string): Promise<Response> => {
  const stamp = await seededStamp(deps, developerId);
  const result = await writePilotMark(deps, {
    repo: String(body["repo"]),
    refKind: body["refKind"] as "hint_delivery",
    refId: String(body["refId"]),
    mark: body["mark"] as "noise",
    markedBy: developerId,
    reason: typeof body["reason"] === "string" ? body["reason"].trim() : null,
    stamp,
  });
  if ("refusal" in result) {
    return refused(result.refusal);
  }
  await resolveDraft(deps, stamp, draftId);
  const standing = result.stands === undefined ? {} : { stands: result.stands, replaced: result.replaced ?? null };
  return json({ id: result.id, repeated: result.repeated, ...standing }, result.repeated ? 200 : 201);
};

/** The answer an older client read from each door that now drafts, once the draft took effect. */
const effectAnswer = (path: string, data: Body): Body => {
  const { draft: _draft, provenance: _provenance, ...rest } = data;
  if (path.startsWith("/api/settings/mutes")) {
    return "unmuted" in rest ? { ...rest, wasMuted: true } : { ...rest, alreadyMuted: false };
  }
  if (path === "/api/settings/presence") {
    return { presenceOptOut: false };
  }
  return rest;
};

const isDraftingDoor = (method: string, path: string): boolean =>
  (method === "POST" && (path === "/api/pins" || /^\/api\/pins\/[^/]+\/broke$/.test(path) || path === "/api/settings/mutes")) ||
  (method === "DELETE" && path.startsWith("/api/settings/mutes/")) ||
  (method === "PUT" && path === "/api/settings/presence");

/** Wraps an app so every drafted word is confirmed the moment it is written (see the header). */
export const confirmingAtOnce = (app: App, deps: Deps): App => {
  const request = async (...args: Parameters<App["request"]>): Promise<Response> => {
    const [input, init] = args;
    const response = await app.request(...args);
    const method = (init?.method ?? "GET").toUpperCase();
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href, "http://hub.test").pathname;
    if (response.status >= 300) {
      return response;
    }
    const isOutcome = method === "POST" && (path === "/api/hint-outcomes" || path === "/api/hint-outcomes/person");
    const isLabel = method === "POST" && path === "/api/pilot-marks";
    if (!isOutcome && !isLabel && !isDraftingDoor(method, path)) {
      return response;
    }
    const answered = (await response.clone().json()) as { data?: Body };
    const data = answered.data ?? {};
    if (data["draft"] !== true) {
      return response;
    }
    const developerId = await developerOfKey(deps.db, init);
    if (developerId === null) {
      return response;
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    if (isOutcome) {
      return outcomeAtOnce(deps, developerId, body, String(data["id"]), path.endsWith("/person") ? "person" : "agent");
    }
    if (isLabel) {
      return labelAtOnce(deps, developerId, body, String(data["id"]));
    }
    await confirmDraftsDirectly(deps, developerId);
    return json(effectAnswer(path, data), 200);
  };
  return new Proxy(app, {
    get: (target, property, receiver) => {
      if (property === "request") {
        return request;
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
};
