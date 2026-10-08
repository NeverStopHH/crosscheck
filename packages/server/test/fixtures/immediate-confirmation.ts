/**
 * "THE PERSON CONFIRMED IT AT ONCE" — a test-side emulation, never a hub mode.
 *
 * Since human provenance (0.11), every door a key can reach only DRAFTS a
 * label, an outcome, a pin, a break, a mute or presence-on; a passkey
 * confirmation makes it the person's. The suites written before that pin what
 * the WRITERS do with a person's word — what stands, repeats, twins, the
 * fence, suspect, the skeleton — and they set up their worlds through the
 * doors. This wrapper keeps them testing exactly that, and NOTHING production
 * cannot do (review M1):
 *
 *   - each door drafts as it does in production; a door that answered
 *     `repeated: true` wrote nothing and its answer is returned untouched;
 *   - otherwise the draft is confirmed through the REAL batch store — form
 *     from the scoped pending set, liveness, the kind's registered writer over
 *     the draft's payload, `recordedVia = person` for every confirmed word
 *     (J8) — with only the WebAuthn signature replaced by a seeded credential
 *     past its cool-off (the `seedPasskey` precedent);
 *   - the answer is the writer's own (what stands, what it replaced, a repeat)
 *     for a label or an outcome, and for a pin, a break, a mute, an unmute or
 *     presence-on the answer an older client read.
 *
 * Production behaviour, drafts left pending, is `drafts: "pending"`
 * (helpers.ts) — what every human-provenance suite uses.
 */
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

import type { AppEnv } from "../../src/types.ts";
import { createServer } from "../../src/index.ts";
import type { CreateServerOptions } from "../../src/index.ts";
import { hashApiKey } from "../../src/auth/keys.ts";
import { developers } from "../../src/db/schema.ts";
import type { Db } from "../../src/db/client.ts";
import type { Embedder } from "../../src/services/embedder.ts";
import { createBatchStore } from "../../src/services/confirmation-batch.ts";
import type { ConfirmedBatch, ConfirmRefused } from "../../src/services/confirmation-batch.ts";
import { CONFIRM_PAGE_SCOPE } from "../../src/services/confirm-page.ts";
import { finishPresenceChange } from "../../src/services/developer-settings.ts";
import { pendingFingerprint, readPendingDrafts } from "../../src/services/human-drafts.ts";
import { seedPasskey } from "./passkeys.ts";

type App = Hono<AppEnv>;

interface Deps {
  readonly db: Db;
  readonly now: () => Date;
  /** The hub's embedder, so presence-on re-embeds what it rebuilt as the real confirmation does. */
  readonly embedder?: Embedder | null;
}

const SEEDED_ASSERTION = { authenticatorData: "seeded", clientDataJSON: "seeded", signature: "seeded", userHandle: null };

/** One seeded passkey per developer, created on first use — enrolled long ago, past its cool-off. */
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

const NOTHING_CONFIRMED: ConfirmedBatch = {
  confirmed: 0,
  discarded: 0,
  kept: 0,
  presenceOn: false,
  effects: new Map(),
};

/** Every pending draft of the developer, confirmed through the real batch store. */
export const confirmDraftsDirectly = async (deps: Deps, developerId: string): Promise<ConfirmedBatch | ConfirmRefused> => {
  const pending = await readPendingDrafts(deps, developerId, { scope: CONFIRM_PAGE_SCOPE });
  if (pending.length === 0) {
    return NOTHING_CONFIRMED;
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
    return outcome;
  }
  if (outcome.presenceOn) {
    await finishPresenceChange({ db: deps.db, now: deps.now, embedder: deps.embedder ?? null }, developerId, false);
  }
  return outcome;
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

/** A label's writer answer as the 0.10 door answered it: its id, a repeat, and what now stands. */
const labelAnswer = (effect: Body): Body => {
  const standing = effect["stands"] === undefined ? {} : { stands: effect["stands"], replaced: effect["replaced"] ?? null };
  return { id: effect["id"], repeated: effect["repeated"], ...standing };
};

/** The answer an older client read from each door that now drafts, once the draft took effect. */
const effectAnswer = (path: string, data: Body): Body => {
  const { draft: _draft, provenance: _provenance, waiting: _waiting, ...rest } = data;
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

/** A judgement's door: its draft confirmed through the store, and the writer's own answer returned. */
const judgementAtOnce = async (
  deps: Deps,
  developerId: string,
  draftId: string,
  kind: "outcome" | "label",
  fallback: Response,
): Promise<Response> => {
  const confirmed = await confirmDraftsDirectly(deps, developerId);
  if ("refusal" in confirmed) {
    return refused(confirmed.cause ?? confirmed.refusal);
  }
  const effect = confirmed.effects.get(draftId) as Body | undefined;
  if (effect === undefined) {
    return fallback;
  }
  const answer = kind === "label" ? labelAnswer(effect) : effect;
  return json(answer, answer["repeated"] === true ? 200 : 201);
};

/**
 * A HUB THAT APPLIES A KEY'S WORD AT ONCE, for the connector and CLI suites
 * from before 0.11 that drive a hub over a socket: what they pin is how the
 * client renders a word that took effect — the answer every hub before human
 * provenance gave, and the one an older hub still gives. Production
 * behaviour, the word left a draft, is plain `createServer`.
 */
export const createServerConfirmingAtOnce = (options: CreateServerOptions): App =>
  confirmingAtOnce(createServer(options), {
    db: options.db,
    now: options.now ?? (() => new Date()),
    embedder: options.embedder ?? null,
  });

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
    // A door that wrote nothing — not a draft, or a repeat of one — is answered as the hub answered it.
    if (data["draft"] !== true || data["repeated"] === true) {
      return response;
    }
    const developerId = await developerOfKey(deps.db, init);
    if (developerId === null) {
      return response;
    }
    if (isOutcome || isLabel) {
      return judgementAtOnce(deps, developerId, String(data["id"]), isLabel ? "label" : "outcome", response);
    }
    const confirmed = await confirmDraftsDirectly(deps, developerId);
    if ("refusal" in confirmed) {
      throw new Error(`confirming at once was refused: ${confirmed.refusal} (${String(confirmed.cause)})`);
    }
    return json(effectAnswer(path, data), 200);
  };
  // The same, for a hub on a real socket (`Bun.serve({ fetch })`): the
  // connector and CLI suites from before 0.11 talk to one over HTTP.
  const fetchAtOnce = async (incoming: Request, env?: Parameters<App["request"]>[2]): Promise<Response> => {
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    return request(
      incoming.url,
      { method: incoming.method, headers: incoming.headers, ...(hasBody ? { body: await incoming.text() } : {}) },
      env,
    );
  };
  return new Proxy(app, {
    get: (target, property, receiver) => {
      if (property === "request") {
        return request;
      }
      if (property === "fetch") {
        return fetchAtOnce;
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
};
