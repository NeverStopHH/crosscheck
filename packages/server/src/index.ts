import type { Context, Hono } from "hono";

import { createApp } from "./app.ts";
import {
  IPV4_LOOPBACK,
  IPV6_LOOPBACK,
  LISTEN_ENV,
  assertListenable,
  canListenAt,
  describeListening,
  interfaceAddresses,
  legacyListenWarning,
  parseListenAddresses,
  probeAddressesFor,
  resolveListenPlan,
  restoredOnLoopbackWarning,
  serveOnPlan,
} from "./http/listen.ts";
import { REFUSE_PRE_011_DRAFTS_ENV, parseRefusePreDraftingClients } from "./http/client-release.ts";
import { NO_TRUSTED_PROXIES, TRUSTED_PROXIES_ENV, parseTrustedProxies } from "./http/forwarded.ts";
import type { TrustedProxies } from "./http/forwarded.ts";
import type { ListenKind } from "./http/listen.ts";
import { bunPeerAddress } from "./http/peer.ts";
import { holdsMembersFromBeforeInstall, readListenDefault } from "./services/hub-install.ts";
import { generateApiKey } from "./auth/keys.ts";
import { DEFAULT_PORT, SESSION_REAP_INTERVAL_MS } from "./constants.ts";
import { createDb } from "./db/client.ts";
import { createEmbedderFromEnv } from "./services/embedder.ts";
import { reapStaleSessions } from "./services/sessions.ts";
import { hasLocalhostBesideHttps, localhostBesideHttpsWarning, parseWebAuthnOrigins } from "./services/webauthn.ts";
import { backfillSkeletonIdentity } from "./services/skeleton-identity.ts";
import { runStartupUpgrades } from "./services/startup-upgrades.ts";
import { rebuildOptedOutLocationIndexes } from "./services/developer-settings.ts";
import type { Db } from "./db/client.ts";
import type { Embedder } from "./services/embedder.ts";
import type { AppEnv, Clock } from "./types.ts";

export { createApp } from "./app.ts";
export { createDb } from "./db/client.ts";
export type { Db } from "./db/client.ts";
/** The causal-order table, so a connector test can assert what the hub stored. */
export { sessionEvents } from "./db/schema.ts";
export {
  CAUSAL_INDETERMINACIES,
  CAUSAL_ORDER_REASONS,
  CAUSAL_ORDER_STATES,
  CAUSAL_POSITION_STATUSES,
  causalComparisonOf,
  causalOrderOf,
  causalPositionOf,
  compareEvents,
  isOrderable,
  readBrokenCausalOrders,
  readSessionCausalOrder,
} from "./services/session-order.ts";
export type {
  CausalComparison,
  CausalIndeterminacy,
  CausalOrderReason,
  CausalOrderState,
  CausalPosition,
  CausalPositionStatus,
  OrderedEvent,
  SessionCausalOrder,
} from "./services/session-order.ts";
// TARGET_EVENT_KINDS beside seqKindFor: connector-core's declared-guarantee
// build check (01a §3.6) holds its per-kind table to the hub's projection.
export { TARGET_EVENT_KINDS, seqKindFor } from "./services/record-handlers.ts";
// Exported so connector-core can pin its substance gate to the same terms
// (test/claim-validity-parity.test.ts).
export { isAssertableCause } from "./services/claim-validity.ts";
export { createEmbedderFromEnv } from "./services/embedder.ts";
export type { Embedder } from "./services/embedder.ts";
// 03's ground, exported because 04's verdict layer and 07's instrumentation
// both CONSUME `isJudgeable` rather than recomputing it, and because the
// connector's wire vocabulary is pinned against these three enums in
// connector-core/test/coverage-wire.test.ts.
export {
  COVERAGE_ORDER_REASONS,
  COVERAGE_REASONS,
  COVERAGE_SOURCES,
  COVERAGE_STATES,
  ORDER_STATES,
  isJudgeable,
  readCoverage,
} from "./services/coverage.ts";
export type {
  CoverageRecord,
  CoverageReason,
  CoverageScope,
  CoverageSource,
  CoverageSourceRecord,
  CoverageState,
} from "./services/coverage.ts";
// 04 §5's verdict vocabulary, exported for ONE reason: the connector cannot
// import the hub, so `connector-core/src/http/verdict.ts` re-declares these
// five enums and `connector-core/test/verdict-wire.test.ts` pins them against
// these — the shape coverage already uses, four lines up. Nothing in the CLI's
// render path imports this module: a static import of the hub would pull
// PGlite, drizzle and hono into a renderer and into the published package.
export {
  ATTRIBUTIONS,
  BEHAVIOR_DELTAS,
  PROTECTIONS,
  VERDICT_BASES,
  VERDICT_FALSIFIERS,
} from "./services/verdict.ts";
export type {
  Attribution,
  BehaviorDelta,
  InvariantRef,
  Protection,
  Verdict,
  VerdictBasis,
  VerdictFalsifier,
  WaiverRef,
} from "./services/verdict.ts";
export {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_TOKEN_CHARS,
} from "./services/search.ts";
export type { AppDeps, AppEnv, AuthedDeveloper, Clock } from "./types.ts";
export {
  EVENTS_DEFAULT_LIMIT,
  EVENTS_MAX_LIMIT,
  EVENT_KINDS,
  MAX_INGEST_BATCH,
  POLL_INTERVAL_MS,
  PRESENCE_TTL_SECONDS,
  SSE_KEEPALIVE_INTERVAL_MS,
} from "./constants.ts";

export interface CreateServerOptions {
  readonly db: Db;
  readonly now?: Clock;
  readonly adminToken?: string | null;
  /**
   * Omitted/null = no CI reporter: `POST /api/ci-runs` refuses with
   * `ci_disabled` and `coverage.ci` reads `unavailable`, which is a real
   * answer rather than a placeholder.
   */
  readonly ciToken?: string | null;
  /** Omitted/null = keyless: the vector tier is silently absent (DESIGN.md §6). */
  readonly embedder?: Embedder | null;
  /** Test seam only — services/search.ts SearchDeps says why. Omit in production. */
  readonly embedDeadlineMs?: number;
  /**
   * HMAC secret for /ui session cookies. Omitted = a fresh random secret per
   * process: nothing secret at rest, and a restart logs every browser out
   * (ui/session.ts documents the rotation story). Set CROSSCHECK_UI_SECRET
   * to keep sessions across restarts.
   */
  readonly uiSessionSecret?: string;
  /**
   * Where passkeys may be used (04a §7), already validated. Omitted = none:
   * `startServer` always passes the parsed `CROSSCHECK_WEBAUTHN_ORIGINS`.
   */
  readonly webauthnOrigins?: readonly string[];
  /** Omitted = Bun's own `requestIP` (http/peer.ts); the test harness injects one. */
  readonly peerAddress?: (c: Context<AppEnv>) => string | null;
  /**
   * Proxies besides loopback whose X-Forwarded-* headers count, already
   * parsed (http/forwarded.ts). Omitted = none: `startServer` passes the
   * parsed `CROSSCHECK_TRUSTED_PROXIES`.
   */
  readonly trustedProxies?: TrustedProxies;
  /** How `startServer` decided where to listen; omitted = no socket of this app's own. */
  readonly listen?: ListenKind;
  /**
   * Refuse drafts from clients older than 0.11 (http/client-release.ts).
   * Omitted = accept every client: `startServer` passes the parsed
   * `CROSSCHECK_REFUSE_PRE_011_DRAFTS`.
   */
  readonly refusePreDraftingClients?: boolean;
}

/**
 * Omitted → fresh random secret per process. Provided → must have substance:
 * `CROSSCHECK_UI_SECRET=` (empty) is not nullish, so without this guard it
 * would flow through `??` and sign every session cookie with "" — a signing
 * secret misconfiguration must fail fast at startup, not silently weaken auth.
 */
const resolveUiSessionSecret = (secret: string | undefined): string => {
  if (secret === undefined) {
    return generateApiKey();
  }
  if (secret.trim().length === 0) {
    throw new Error(
      "uiSessionSecret (CROSSCHECK_UI_SECRET) must be non-empty: it is the " +
        "HMAC key signing /ui session cookies. Unset it entirely for a " +
        "random per-process secret.",
    );
  }
  return secret;
};

export const createServer = (options: CreateServerOptions): Hono<AppEnv> =>
  createApp({
    db: options.db,
    now: options.now ?? (() => new Date()),
    adminToken: options.adminToken ?? null,
    ciToken: options.ciToken ?? null,
    embedder: options.embedder ?? null,
    ...(options.embedDeadlineMs === undefined
      ? {}
      : { embedDeadlineMs: options.embedDeadlineMs }),
    uiSessionSecret: resolveUiSessionSecret(options.uiSessionSecret),
    webauthnOrigins: options.webauthnOrigins ?? [],
    peerAddress: options.peerAddress ?? bunPeerAddress,
    trustedProxies: options.trustedProxies ?? NO_TRUSTED_PROXIES,
    listen: options.listen ?? null,
    refusePreDraftingClients: options.refusePreDraftingClients ?? false,
  });

const MIN_PORT = 1;
const MAX_PORT = 65535;

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(
      `invalid PORT "${raw}": expected an integer between ${MIN_PORT} and ${MAX_PORT}`,
    );
  }
  return parsed;
};

/** Localhost answers fast either way; an unanswered probe is read as free. */
const PORT_PROBE_TIMEOUT_MS = 500;

/**
 * The loopbacks the hub listens at when nobody says otherwise, and the probe
 * knocks at for a wildcard: both, where the machine has `::1`. A foreign
 * listener on `[::1]:<port>` would otherwise answer every browser that tries
 * IPv6 first (review of the hub hardening, X9).
 */
const loopbackAddresses = (): readonly string[] =>
  canListenAt(IPV6_LOOPBACK) ? [IPV4_LOOPBACK, IPV6_LOOPBACK] : [IPV4_LOOPBACK];

/**
 * "Address already in use" is the commonest first-run error, and Bun.serve on
 * macOS cannot report it against a FOREIGN listener: it binds over one with
 * reuse semantics, prints the healthy banner, and the kernel splits traffic
 * between two servers — intermittent 401s instead of a sentence. (Two BUN
 * listeners do collide loudly; the foreign case is the silent one.) So the
 * port is probed by CONNECTING first: anything answering on localhost means
 * taken, said here, before a database is booted for nothing. The probe is
 * best-effort — an unanswered connect (timeout) proceeds, and the tiny
 * check-to-bind race is accepted.
 */
const isAnswering = (hostname: string, port: number): Promise<boolean> =>
  Promise.race([
    Bun.connect({
      hostname,
      port,
      socket: { data: () => {} },
    }).then(
      (socket) => {
        socket.end();
        return true;
      },
      () => false,
    ),
    new Promise<boolean>((resolveProbe) => {
      setTimeout(() => resolveProbe(false), PORT_PROBE_TIMEOUT_MS);
    }),
  ]);

const assertPortFree = async (port: number, hostnames: readonly string[]): Promise<void> => {
  const answers = await Promise.all(hostnames.map((hostname) => isAnswering(hostname, port)));
  const taken = answers.some((answered) => answered);
  if (taken) {
    throw new Error(
      `port ${port} is already in use — something is listening there ` +
        "(another crosscheck hub, or a different server). Stop it, or set " +
        "PORT to a free one.",
    );
  }
};

/**
 * Boot the hub from process env, exactly as `bun run packages/server/src/index.ts`
 * always has. Exported so the `crosscheck serve` CLI command (DESIGN.md §2's
 * `npx crosscheck-hub serve`) is this same code path rather than a second copy.
 */
export const startServer = async (): Promise<void> => {
  // Port and address checks come FIRST: a taken port or an address this
  // machine does not have must refuse before PGlite writes a single byte,
  // not after a full database boot.
  const port = parsePort(process.env["PORT"]);
  const configuredListen = parseListenAddresses(process.env[LISTEN_ENV]);
  const trustedProxies = parseTrustedProxies(process.env[TRUSTED_PROXIES_ENV]);
  if (configuredListen !== null) {
    assertListenable(configuredListen);
  }
  await assertPortFree(port, probeAddressesFor(configuredListen, loopbackAddresses(), interfaceAddresses()));
  const dataDir = process.env["CROSSCHECK_DATA_DIR"];
  const db = await createDb(dataDir === undefined ? {} : { dataDir });
  const listenPlan = resolveListenPlan({
    configured: configuredListen,
    listenDefault: await readListenDefault(db),
    hasIpv6Loopback: canListenAt(IPV6_LOOPBACK),
  });
  // Every interface, decided only now that the data dir has spoken: knock the
  // machine's own addresses too, where a foreign listener would share the
  // port with the hub (review of the hub hardening, L4).
  if (listenPlan.kind === "legacy_all_interfaces") {
    await assertPortFree(port, interfaceAddresses());
  }
  // Throws on explicit misconfiguration (e.g. openai chosen, no key) — a hub
  // that silently dropped its vector tier would be DESIGN.md §10 "silent death".
  const embedder = createEmbedderFromEnv(process.env);
  const uiSessionSecret = process.env["CROSSCHECK_UI_SECRET"];
  // Throws on an origin no browser would run a ceremony at — refused here
  // rather than in front of a person at the approval page (04a §7).
  const webauthnOrigins = parseWebAuthnOrigins(process.env["CROSSCHECK_WEBAUTHN_ORIGINS"], port);
  if (hasLocalhostBesideHttps(webauthnOrigins)) {
    console.warn(localhostBesideHttpsWarning(webauthnOrigins));
  }
  // Throws on a value that is neither on nor off, rather than guessing which was meant.
  const refusePreDraftingClients = parseRefusePreDraftingClients(process.env[REFUSE_PRE_011_DRAFTS_ENV]);
  const app = createServer({
    db,
    adminToken: process.env["ADMIN_TOKEN"] ?? null,
    ciToken: process.env["CROSSCHECK_CI_TOKEN"] ?? null,
    embedder,
    ...(uiSessionSecret === undefined ? {} : { uiSessionSecret }),
    webauthnOrigins,
    trustedProxies,
    listen: listenPlan.kind,
    refusePreDraftingClients,
  });
  // AN OPT-OUT FROM BEFORE THE INDEX FOLLOWED THE SETTING (review round 5,
  // M1): her docs still hold her branch titles, so they are rebuilt BEFORE
  // serving — a colleague's first search must not find her by a guessed
  // branch. Once per opt-out (developers.location_index_built_at).
  const indexesRebuilt = await rebuildOptedOutLocationIndexes({ db, now: () => new Date(), embedder });
  if (indexesRebuilt > 0) {
    console.log(`[crosscheck] search index: rebuilt for ${String(indexesRebuilt)} opted-out developer(s)`);
  }
  const servers = serveOnPlan(listenPlan, port, app.fetch);
  const listeningPort = servers[0]?.port ?? port;
  if (listenPlan.kind === "legacy_all_interfaces") {
    console.warn(legacyListenWarning(listeningPort));
  }
  if (listenPlan.kind === "loopback_default" && (await holdsMembersFromBeforeInstall(db))) {
    console.warn(restoredOnLoopbackWarning(listeningPort));
  }
  // THE SKELETON'S IDENTITY FOR ROWS THAT PREDATE ITS COLUMNS (01a §4.1).
  // After serving, not before: until it has run, a missing identity reads as
  // UNRESOLVED and the retention sweep keeps what it cannot resolve, so
  // nothing depends on it finishing first — and a large hub is not held
  // offline while it does. Idempotent; each start finishes what the last left.
  void backfillSkeletonIdentity({ db, now: () => new Date() }).then(
    (report) => {
      console.log(
        `[crosscheck] skeleton identity: ${String(report.pinPathsCanonicalised)} legacy pin path(s) respelled, ` +
          `${String(report.pinsSeeded)} pin(s) seeded, ` +
          `${String(report.fileRefs)} file identities filled, ` +
          `${String(report.unresolvedFileRefs)} unresolved (kept)`,
      );
    },
    (error: unknown) => {
      console.error("[crosscheck] skeleton identity backfill failed; unresolved rows are kept", error);
    },
  );
  // DRAFTS OUT OF WHAT AN OLDER HUB BUILT: the auto links its gate made into
  // teammates' trees on a draft's strength, the docs that still fold drafts
  // in, and — with an embedder — every vector missing or from another model
  // (services/startup-upgrades.ts runs them apart, each logging its own
  // outcome). After serving, for the same reason: until they have run the
  // old rows behave as they did before the upgrade, and nothing waits on
  // them. All idempotent; each start finishes what the last left.
  void runStartupUpgrades({ db, embedder });
  // The hub's own reaper (trial finding M6). HERE and not in `createApp`:
  // every test that builds an app would otherwise leak a timer, and the
  // registration path already reaps the registering developer's own sessions
  // — this pass is for the developers who have stopped starting sessions at
  // all, which is exactly the 104 the trial hub never closed. `.unref()` so
  // it never holds the process open by itself.
  setInterval(() => {
    void reapStaleSessions({ db, now: () => new Date() }).catch(
      (error: unknown) => {
        console.error("[crosscheck] session reaper pass failed", error);
      },
    );
  }, SESSION_REAP_INTERVAL_MS).unref();
  const searchMode =
    embedder === null ? "exact+fts (keyless)" : `exact+fts+vector (${embedder.model})`;
  console.log(
    `crosscheck server listening on :${String(listeningPort)} (${describeListening(listenPlan, servers)}) · search: ${searchMode}`,
  );
};

if (import.meta.main) {
  await startServer();
}