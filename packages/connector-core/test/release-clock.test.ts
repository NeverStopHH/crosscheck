/**
 * THREE CLOCKS THAT WERE ONE (review-2 round 8, findings H1 and H2).
 *
 * The refused-lives note dropped an entry MAX_SPOOL_AGE_DAYS after it was
 * written; a flush read a silent host session as abandoned after the same
 * span; and reap expired a spool whose data file was that old. A host that
 * died therefore had its spool released exactly when the notes saying which of
 * its lives the hub had ended aged out (H1: a straggler filed into an ended
 * session), and when reap expired whatever its successor had not yet sent
 * (H2: 2605 of a 3000-record backlog expired at the second SessionStart).
 *
 * Now a note lives while its host session still has records or a debt on
 * disk, and never less than twice the age bound; and the expiry clock of a
 * released spool starts at its release, not at its last write.
 *
 * The dead host's silence is a clock too (L7): a successor's flush that wrote
 * the hub's acknowledgement of the dead host's work context into the dead
 * host's state revived it, and its backlog was held from every successor.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, rm, stat, utimes, writeFile } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { HTTP_TIMEOUT_MS, MAX_SPOOL_AGE_DAYS, MS_PER_DAY, MS_PER_SECOND } from "../src/constants.ts";
import {
  repoKey,
  sessionSlug,
  sessionStatePath,
  spoolDataPath,
  spoolOwedWorkContextPath,
  spoolReleasedPath,
} from "../src/config/paths.ts";
import { targetRecord } from "../src/capture/records.ts";
import type { Producer } from "../src/capture/records.ts";
import type { HubContext } from "../src/http/client.ts";
import { endSession } from "../src/http/hub.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { reapSpool } from "../src/spool/reap.ts";
import { readRefusedLives, recordRefusedLife } from "../src/spool/refused-lives.ts";
import { reapStaleSessionStates } from "../src/state/session-reap.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "release-clock-admin";
const REPO_ID = "github.com/acme/api";
const BRANCH = "main";
const BASE_COMMIT = "0000000000000000000000000000000000000000";
const HOUR_MS = 3600 * MS_PER_SECOND;
const AGE_BOUND_MS = MAX_SPOOL_AGE_DAYS * MS_PER_DAY;
/** Past the bound a flush reads a silent host session as abandoned, and session-reap deletes its state. */
const ABANDONED_MS = AGE_BOUND_MS + HOUR_MS;
/** What a hook spares a drain: one SessionStart's, at the production request timeout. */
const HOOK_DRAIN_MS = 500;
/** The probe's backlog (review H2): a laptop that coded offline for a while, then died. */
const BACKLOG = 3000;
const APPEND_CHUNK = 200;
/** A bound on the successor's drains after its SessionStarts: each sends up to MAX_FLUSH_BATCHES_PER_HOOK batches, so two or three empty the backlog. */
const MAX_HOOKS = 200;
/**
 * A request and a drain no load cuts short. A hook-sized one (HOOK_DRAIN_MS,
 * HTTP_TIMEOUT_MS) gives up on a batch a loaded machine's hub answers late,
 * though the hub took it, and whatever came of that batch is then decided by
 * the machine's speed: its re-send is answered `duplicate`, never an
 * acknowledgement, and a drain made of such batches sends nothing at all. A
 * probe whose assertion follows from an answered batch drains with this.
 */
const PATIENT_MS = 60_000;
/** More than one batch: the rest goes only while the dead host still reads as abandoned. */
const ACK_BACKLOG = 150;
/**
 * Booting the in-process hub (PGlite) outlasted bun's 5 s hook default on a
 * loaded machine, and the mutation proof read the file as red unmutated; the
 * boot is not what this file measures (claim-revalidation-pull.test.ts).
 */
const HUB_BOOT_TIMEOUT_MS = 60_000;

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let apiKey: string;
let developerId: string;
const cleanups: string[] = [];

interface Fixture {
  readonly home: string;
  readonly repo: string;
  readonly key: string;
  readonly hub: HubContext;
}

const fixture = async (label: string): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  const key = repoKey(hubUrl, REPO_ID);
  return { home, repo, key, hub: { hubUrl, apiKey, timeoutMs: HTTP_TIMEOUT_MS, home, repoKey: key, now: () => new Date() } };
};

const register = (fx: Fixture, hostSessionKey: string) =>
  registerSessionFlow({
    home: fx.home,
    repoKey: fx.key,
    hub: fx.hub,
    agentKind: "acp:test",
    hostSessionKey,
    repoId: REPO_ID,
    repoRoot: fx.repo,
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    hubUrl,
    fallbackDeveloperId: developerId,
    title: fallbackWorkContextTitle(BRANCH, REPO_ID),
    status: "analyzing",
    now: new Date(),
    guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
  });

const producerOf = (sessionId: string): Producer => ({ developerId, agentKind: "acp:test", sessionId });

const edits = (life: { workContextId: string; crosscheckSessionId: string }, tag: string, n: number) =>
  Array.from({ length: n }, (_, index) =>
    targetRecord(life.workContextId, "file", `src/${tag}-${String(index)}.ts`, producerOf(life.crosscheckSessionId), new Date()),
  );

/** The host session died `agoMs` ago: its state, and its spool's data file, untouched since. */
const diedAgo = async (fx: Fixture, hostSessionKey: string, agoMs: number): Promise<void> => {
  const then = new Date(Date.now() - agoMs);
  const path = sessionStatePath(fx.home, hostSessionKey);
  const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, `${JSON.stringify({ ...state, startedAt: then.toISOString(), lastHeartbeatAt: then.toISOString() })}\n`);
  await utimes(path, then, then);
  await utimes(spoolDataPath(fx.home, fx.key, sessionSlug(hostSessionKey)), then, then);
};

const targetsOf = async (workContextId: string): Promise<number> =>
  (
    await (db as unknown as { $client: { query: (q: string, p: readonly unknown[]) => Promise<{ rows: { n: number }[] }> } })
      .$client.query("select count(*)::int as n from work_context_targets where work_context_id = $1", [workContextId])
  ).rows[0]?.n ?? 0;

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Release", email: "release-clock@example.com" }),
  });
  const body = (await response.json()) as { data: { developer: { id: string }; apiKey: string } };
  apiKey = body.data.apiKey;
  developerId = body.data.developer.id;
}, HUB_BOOT_TIMEOUT_MS);

afterAll(async () => {
  server.stop(true);
  await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close().catch(() => undefined);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("the refused-lives note (H1)", () => {
  test("still withholds an ended life's straggler once its dead host's spool is released as abandoned", async () => {
    // Arrange: the hub ended the life, the note says so, a straggler of it waits; the host dies, a week passes
    const fx = await fixture("note-outlives");
    const host = "acp-release--dead";
    const life = await register(fx, host);
    await flushSpool(fx.hub, { sessionId: life.crosscheckSessionId, developerId }, 3000);
    await endSession(fx.hub, life.crosscheckSessionId);
    const noted = new Date(Date.now() - ABANDONED_MS);
    await recordRefusedLife(fx.home, fx.key, life.crosscheckSessionId, noted);
    await appendRecords(fx.home, fx.key, host, edits(life, "straggler", 1), noted);
    await diedAgo(fx, host, ABANDONED_MS);

    // Act: another conversation's flush finds the dead host's spool abandoned
    const other = await register(fx, "acp-release--successor");
    await flushSpool(fx.hub, { sessionId: other.crosscheckSessionId, developerId }, 3000);

    // Assert: never filed into the ended life; counted as withheld
    expect(await targetsOf(life.workContextId)).toBe(0);
    expect((await readDropDetail(fx.home, fx.key)).byReason["withheld"]).toBe(1);
  });

  test("keeps an entry for twice the age bound with nothing waiting, and past it while its host session has records or a debt", async () => {
    // Arrange: refused lives noted past twice the bound — one of a host session with a record still on disk, one owing a work context
    const fx = await fixture("note-bound");
    const now = new Date();
    const young = new Date(now.getTime() - (2 * AGE_BOUND_MS - HOUR_MS));
    const old = new Date(now.getTime() - (2 * AGE_BOUND_MS + HOUR_MS));
    await recordRefusedLife(fx.home, fx.key, "cc_young", young);
    await recordRefusedLife(fx.home, fx.key, "cc_old-idle", old);
    await recordRefusedLife(fx.home, fx.key, "cc_old-waiting~r1", old);
    await recordRefusedLife(fx.home, fx.key, "cc_old-owing", old);
    await appendRecords(fx.home, fx.key, "old-waiting", edits({ workContextId: "wc_cc_old-waiting~r1", crosscheckSessionId: "cc_old-waiting~r1" }, "w", 1), old);
    await writeFile(spoolOwedWorkContextPath(fx.home, fx.key, sessionSlug("old-owing")), "{}\n");

    // Act
    const lives = await readRefusedLives(fx.home, fx.key, now);

    // Assert
    expect([...lives].sort()).toEqual(["cc_old-owing", "cc_old-waiting~r1", "cc_young"]);
  });
});

describe("the expiry clock of a released spool (H2)", () => {
  test("starts when session-reap deletes its stale state, not at its last write", async () => {
    // Arrange: a dead host session's backlog, its state and data file a week and an hour old
    const fx = await fixture("expiry-clock");
    const host = "acp-release--corpse";
    const life = await register(fx, host);
    await appendRecords(fx.home, fx.key, host, edits(life, "backlog", 3), new Date());
    await diedAgo(fx, host, ABANDONED_MS);

    // Act: the successor's SessionStart reaps the stale state, then reap runs now and a week later
    await reapStaleSessionStates(fx.home, new Date());
    const now = await reapSpool(fx.home, fx.key, new Date());
    const weekOn = await reapSpool(fx.home, fx.key, new Date(Date.now() + ABANDONED_MS));

    // Assert: nothing expired until a full bound after the release; the stamp went with the spool
    expect(now.expired).toBe(0);
    expect(weekOn.expired).toBe(1);
    expect(await Bun.file(spoolReleasedPath(fx.home, fx.key, sessionSlug(host))).exists()).toBe(false);
  });

  test("is never stamped for a spool that is not there: a later one of the same host session keeps its own clock", async () => {
    // Arrange: a dead host session that never wrote a spool in this repo
    const fx = await fixture("no-spool");
    const host = "acp-release--never-wrote";
    await register(fx, host);
    await rm(spoolDataPath(fx.home, fx.key, sessionSlug(host)), { force: true });
    const then = new Date(Date.now() - ABANDONED_MS);
    const path = sessionStatePath(fx.home, host);
    const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...state, startedAt: then.toISOString(), lastHeartbeatAt: then.toISOString() })}\n`);
    await utimes(path, then, then);

    // Act
    await reapStaleSessionStates(fx.home, new Date());

    // Assert
    expect(await Bun.file(spoolReleasedPath(fx.home, fx.key, sessionSlug(host))).exists()).toBe(false);
  });

  test("starts at the first send of an abandoned host's spool, when that came before the state was reaped", async () => {
    // Arrange: a dead host session's backlog; a successor finds it abandoned while the hub is unreachable
    const fx = await fixture("abandoned-send");
    const host = "acp-release--abandoned";
    const life = await register(fx, host);
    await appendRecords(fx.home, fx.key, host, edits(life, "backlog", 3), new Date());
    await diedAgo(fx, host, ABANDONED_MS);
    const other = await register(fx, "acp-release--early-successor");
    const firstSend = Date.now();
    const unreachable = { ...fx.hub, hubUrl: "http://127.0.0.1:1", now: () => new Date(firstSend) };

    // Act: the release by that send; session-reap three days on; reap a full bound after the send
    await flushSpool(unreachable, { sessionId: other.crosscheckSessionId, developerId }, 3000);
    await reapStaleSessionStates(fx.home, new Date(firstSend + 3 * MS_PER_DAY));
    const reaped = await reapSpool(fx.home, fx.key, new Date(firstSend + ABANDONED_MS));

    // Assert: the clock ran from the send, not from the later reap of the state
    expect(reaped.expired).toBe(1);
  });

  test(`a dead host's ${String(BACKLOG)}-record backlog is delivered over the successor's hooks, never expired (probe r7-abandon-expiry)`, async () => {
    // Arrange: C coded offline, its register landed, every flush failed; then the laptop died a week ago
    const fx = await fixture("abandon-expiry");
    const host = "acp-release--offline";
    const c = await register(fx, host);
    const backlog = edits(c, "offline", BACKLOG);
    for (let index = 0; index < backlog.length; index += APPEND_CHUNK) {
      await appendRecords(fx.home, fx.key, host, backlog.slice(index, index + APPEND_CHUNK), new Date());
    }
    await diedAgo(fx, host, ABANDONED_MS);

    // Act: D's SessionStart (drain, reap, reap of stale states), another, then
    // its later drains until nothing is left. The SessionStarts are hook-sized,
    // the probe's own: whatever their drains manage, one drain sends at most
    // MAX_FLUSH_BATCHES_PER_HOOK batches, so a backlog is still on disk when the
    // first reap runs. The drains after them reap nothing and are patient: on a
    // loaded machine a hook-sized drain sends nothing at all (PATIENT_MS).
    const successor = "acp-release--successor";
    const d = await register(fx, successor);
    const input = { sessionId: d.crosscheckSessionId, developerId };
    const sessionStart = async () => {
      await flushSpool(fx.hub, input, HOOK_DRAIN_MS);
      await reapSpool(fx.home, fx.key, new Date());
      await reapStaleSessionStates(fx.home, new Date(), { keepHostSessionKey: successor });
    };
    await sessionStart();
    await sessionStart();
    const patient = { ...fx.hub, timeoutMs: PATIENT_MS };
    for (let hook = 0; hook < MAX_HOOKS && (await readSessionSpool(fx.home, fx.key, sessionSlug(host))).lines.length > 0; hook += 1) {
      await flushSpool(patient, input, PATIENT_MS);
    }

    // Assert: every record delivered, none expired
    expect((await readDropDetail(fx.home, fx.key)).byReason["expired"] ?? 0).toBe(0);
    expect(await targetsOf(c.workContextId)).toBe(BACKLOG);
  }, 120_000);
});

describe("the silence of a dead host (L7)", () => {
  test("a successor's flush the hub acknowledges the dead host's work context for writes nothing into the dead host's state, and drains its backlog", async () => {
    // Arrange: a dead host session's work context and backlog, its state silent a week and an hour
    const fx = await fixture("ack-elsewhere");
    const host = "acp-release--acked-corpse";
    const life = await register(fx, host);
    await appendRecords(fx.home, fx.key, host, edits(life, "backlog", ACK_BACKLOG), new Date());
    await diedAgo(fx, host, ABANDONED_MS);
    const statePath = sessionStatePath(fx.home, host);
    const silentSinceMs = (await stat(statePath)).mtimeMs;
    const successor = await register(fx, "acp-release--ack-successor");
    // Every batch is answered: the hub's acceptance of the dead host's work
    // context always reaches the flush, whatever the machine's speed.
    const patient = { ...fx.hub, timeoutMs: PATIENT_MS };

    // Act: one drain, the dead host's work context at the head of its first batch
    await flushSpool(patient, { sessionId: successor.crosscheckSessionId, developerId }, PATIENT_MS);

    // Assert: the whole backlog went in that drain; the dead host's state was never written — its silence is its abandonment
    expect(await targetsOf(life.workContextId)).toBe(ACK_BACKLOG);
    const state = JSON.parse(await readFile(statePath, "utf8")) as { workContextAcked?: unknown };
    expect(state.workContextAcked).toBeUndefined();
    expect((await stat(statePath)).mtimeMs).toBe(silentSinceMs);
  }, 2 * PATIENT_MS);
});
