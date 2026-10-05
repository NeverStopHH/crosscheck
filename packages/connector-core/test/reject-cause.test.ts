/**
 * A REJECTED RECORD SAYS WHY (docs/1.0/loss-accounting.md §4.3; pilot,
 * 2026-10-05). The pilot's ledgers held 433 dropped records, every one
 * `{"at","count":1,"reason":"rejected"}`, and nothing on the machine could
 * say what the hub had refused them for. Against a REAL hub here, so the
 * wording matched is the hub's own and not a copy of it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { z } from "zod";

import { createDb, createServer } from "@crosscheck/server";

import { recordEnvelope } from "../../server/test/helpers.ts";
import { repoKey, sessionSlug, spoolDropsPath } from "../src/config/paths.ts";
import type { HubContext } from "../src/http/client.ts";
import { endSessionFlow } from "../src/flows/end-session.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../src/flows/register-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { appendRecords } from "../src/spool/append.ts";
import { archiveLedger, readDropDetail, recordDrop } from "../src/spool/drops.ts";
import { flushSpool } from "../src/spool/flush.ts";
import { rejectCauseOf, screenCauses } from "../src/spool/reject-cause.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ADMIN_TOKEN = "reject-cause-admin";
const REPO_ID = "github.com/acme/api";
const GENEROUS_BUDGET_MS = 3000;

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let apiKey: string;
let developerId: string;
const cleanups: string[] = [];

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Rejected", email: "rejected@example.com" }),
  });
  const body = (await response.json()) as { data: { developer: { id: string }; apiKey: string } };
  apiKey = body.data.apiKey;
  developerId = body.data.developer.id;
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("the cause a refusal is kept under", () => {
  test("the hub's producer-session sentences each have their word", () => {
    expect(rejectCauseOf(["producer.sessionId: session has already ended — late writes are rejected"])).toBe(
      "session_ended",
    );
    expect(rejectCauseOf(['producer.sessionId: session "cc_x~r3" not found'])).toBe("session_unknown");
    expect(rejectCauseOf(["producer.sessionId: session belongs to another developer"])).toBe("session_foreign");
    expect(rejectCauseOf(["producer.developerId: does not match authenticated developer"])).toBe(
      "developer_mismatch",
    );
  });

  test("anything else is `other`, and no hub sentence is ever kept", () => {
    expect(rejectCauseOf(["cx: Invalid input: expected string, received undefined"])).toBe("other");
    expect(rejectCauseOf([])).toBe("other");
    expect(rejectCauseOf(undefined)).toBe("other");
    expect(screenCauses({ session_ended: 2, "rm -rf /": 1, other: 1, constructor: 1 })).toEqual({
      session_ended: 2,
      other: 3,
    });
  });
});

describe("a late write after a final end", () => {
  test("stays rejected, and its ledger line names the end — readable by a 0.10 reader", async () => {
    // Arrange: a session that ended for good, and a record still in its name
    const home = await makeHome("reject-late");
    const repo = await makeRepo("reject-late", { remote: "git@github.com:acme/api.git" });
    cleanups.push(home, repo);
    const key = repoKey(hubUrl, REPO_ID);
    const hub: HubContext = { hubUrl, apiKey, timeoutMs: 4000, home, repoKey: key, now: () => new Date() };
    const hostSessionKey = "acp-test--sess_late";
    const registered = await registerSessionFlow({
      home,
      repoKey: key,
      hub,
      agentKind: "acp:test",
      hostSessionKey,
      repoId: REPO_ID,
      repoRoot: repo,
      branch: "main",
      baseCommit: "0000000000000000000000000000000000000000",
      hubUrl,
      fallbackDeveloperId: null,
      title: fallbackWorkContextTitle("main", REPO_ID),
      status: "analyzing",
      now: new Date(),
      guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
    });
    await endSessionFlow({
      home,
      repoKey: key,
      hub,
      hostSessionKey,
      crosscheckSessionId: registered.crosscheckSessionId,
      developerId,
      flushBudgetMs: GENEROUS_BUDGET_MS,
      now: () => new Date(),
    });
    await appendRecords(
      home,
      key,
      hostSessionKey,
      [
        recordEnvelope(
          "target",
          { workContextId: registered.workContextId, kind: "file", value: "src/late.ts" },
          { developerId, sessionId: registered.crosscheckSessionId },
        ),
      ],
      new Date(),
    );

    // Act: delivered in the ended session's own name
    await flushSpool(hub, { sessionId: registered.crosscheckSessionId, developerId }, GENEROUS_BUDGET_MS);

    // Assert: refused, counted, and the count says why
    const detail = await readDropDetail(home, key);
    expect(detail.byReason["rejected"]).toBe(1);
    expect(detail.rejectedCauses).toEqual({ session_ended: 1 });
    const line = (await readFile(spoolDropsPath(home, key, sessionSlug(hostSessionKey)), "utf8")).trim();
    expect(line).not.toContain("late writes");
    // v0.10.0's reader, verbatim (spool/drops.ts:65-69 at that tag).
    const V010_DROP_SCHEMA = z.looseObject({
      at: z.string().min(1),
      count: z.number().int().min(0),
      reason: z.string().min(1),
    });
    expect(V010_DROP_SCHEMA.safeParse(JSON.parse(line)).success).toBe(true);
  });
});

describe("the archive fold", () => {
  test("keeps the causes when the age sweep folds a ledger away", async () => {
    // Arrange
    const home = await makeHome("reject-archive");
    cleanups.push(home);
    const key = repoKey(hubUrl, REPO_ID);
    const slug = sessionSlug("archived-session");
    const now = new Date();
    await recordDrop(home, key, slug, 2, "rejected", now, { target: 2 }, { session_ended: 2 });
    await recordDrop(home, key, slug, 1, "rejected", now);

    // Act
    await archiveLedger(home, key, spoolDropsPath(home, key, slug));
    await rm(spoolDropsPath(home, key, slug), { force: true });

    // Assert: the named causes survive; the uncaused record stays uncaused
    const detail = await readDropDetail(home, key);
    expect(detail.byReason["rejected"]).toBe(3);
    expect(detail.rejectedCauses).toEqual({ session_ended: 2 });
  });
});
