/**
 * ONE HOST SESSION KEY ON TWO MACHINES (review-2 round 8, M6): a cloud agent and
 * a local resume of the same conversation. Each machine's connector registers
 * the same life id, captures and flushes as usual, and one machine's
 * SessionEnd ends the life the other is still writing under. The hub's order
 * for that session breaks (epoch_split), and the other machine's records are
 * refused as late writes.
 *
 * ACCEPTED AS A RESIDUAL for now (loss-accounting.md names the future fix, an
 * installation discriminator in the life id). What this asserts is that the
 * residual is never silent: every record either machine captured is on the
 * hub or counted in that machine's loss ledger, and the broken order is there
 * for anyone who reads it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { readSessionCausalOrder } from "@crosscheck/server";

import { repoKey } from "../src/config/paths.ts";
import { targetRecord } from "../src/capture/records.ts";
import { seqAt, withSeq } from "../src/capture/seq.ts";
import { HTTP_TIMEOUT_MS } from "../src/constants.ts";
import { endSessionFlow } from "../src/flows/end-session.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import { registerSessionFlow } from "../src/flows/register-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { readDropDetail } from "../src/spool/drops.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { allocateSeq, readSessionState } from "../src/state/session-state.ts";
import { startSimHub } from "./simulation/sim-hub.ts";
import type { SimHub } from "./simulation/sim-hub.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO = "github.com/acme/twin";
const HOST = "shared-conversation";
const BUDGET_MS = 2000;
const TAKEN: ReadonlySet<string> = new Set(["accepted", "duplicate"]);

let hub: SimHub;
let repoDir: string;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await startSimHub();
  repoDir = await makeRepo("twin", { remote: "git@github.com:acme/twin.git" });
  cleanups.push(repoDir);
});

afterAll(async () => {
  await hub.stop();
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

test("one host session key on two machines: the broken order is visible and every record delivered or counted", async () => {
  // Arrange: two homes, one hub, the same conversation key on both
  const machines = [await makeHome("machine-a"), await makeHome("machine-b")] as const;
  cleanups.push(...machines);
  const key = repoKey(hub.url, REPO);
  const ctxOf = (home: string) => ({ hubUrl: hub.url, apiKey: hub.apiKey, timeoutMs: HTTP_TIMEOUT_MS, home, repoKey: key, now: () => new Date() });
  const captured: string[] = [];
  const start = (home: string) =>
    registerSessionFlow({
      home,
      repoKey: key,
      hub: ctxOf(home),
      agentKind: "acp:twin",
      hostSessionKey: HOST,
      repoId: REPO,
      repoRoot: repoDir,
      branch: "main",
      baseCommit: "0".repeat(40),
      hubUrl: hub.url,
      fallbackDeveloperId: hub.developerId,
      title: "Twin",
      status: "implementing",
      now: new Date(),
      guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
    });
  const flush = async (home: string) => {
    const state = await readSessionState(home, HOST);
    if (state === null) {
      return;
    }
    const heal = sessionHealer({
      home,
      repoKey: key,
      hub: ctxOf(home),
      agentKind: "acp:twin",
      hostSessionKey: HOST,
      repoId: REPO,
      branch: "main",
      baseCommit: "0".repeat(40),
      guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
      now: () => new Date(),
    });
    await flushSpool(ctxOf(home), { sessionId: state.crosscheckSessionId, developerId: hub.developerId, heal }, BUDGET_MS);
  };
  const edit = async (home: string, label: string) => {
    const state = await readSessionState(home, HOST);
    if (state === null) {
      return;
    }
    const seq = seqAt(await allocateSeq(home, HOST, 1), 0);
    const producer = { developerId: hub.developerId, agentKind: "acp:twin", sessionId: state.crosscheckSessionId };
    const record = withSeq(targetRecord(state.workContextId, "file", `src/${label}.ts`, producer, new Date()), seq);
    captured.push(String(record["id"]));
    await appendRecords(home, key, HOST, [record], new Date());
    await flush(home);
  };
  const [a, b] = machines;
  hub.deliveries.length = 0;

  // Act: both machines work, B's SessionEnd ends the shared life, A keeps going, B resumes later
  const life = await start(a);
  await edit(a, "a1");
  await start(b);
  await edit(b, "b1");
  await edit(a, "a2");
  const stateB = await readSessionState(b, HOST);
  await endSessionFlow({
    home: b,
    repoKey: key,
    hub: ctxOf(b),
    hostSessionKey: HOST,
    crosscheckSessionId: stateB?.crosscheckSessionId ?? "",
    developerId: hub.developerId,
    flushBudgetMs: BUDGET_MS,
    now: () => new Date(),
  });
  await edit(a, "a3");
  await start(b);
  await edit(b, "b2");
  await flush(a);
  await flush(b);

  // Assert: the broken order is on the hub; nothing either machine captured is silently gone
  const taken = new Set(hub.deliveries.filter((delivery) => TAKEN.has(delivery.status)).map((delivery) => delivery.id));
  const lost = captured.filter((id) => !taken.has(id)).length;
  const counted = (await readDropDetail(a, key)).summary.records + (await readDropDetail(b, key)).summary.records;
  expect(await readSessionCausalOrder(hub.db, life.crosscheckSessionId)).toMatchObject({ state: "broken", reason: "epoch_split" });
  expect(lost).toBeGreaterThan(0);
  expect(counted).toBe(lost);
}, 120_000);
