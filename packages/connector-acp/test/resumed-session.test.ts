/**
 * A LOADED ACP SESSION IS CAPTURED AGAIN — the ACP half of the pilot's
 * resumed-session loss (connector-claude/test/resumed-session.test.ts holds
 * the evidence). The proxy ends every live session when its child exits, and
 * a later `session/load` names the same ACP session id, so the next proxy
 * registers the same host key: every life after the third — the old ladder's
 * last rung — was refused by the hub as a late write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, utimes } from "node:fs/promises";
import { join } from "node:path";

import { readSessionCausalOrder } from "@crosscheck/server";

import { HEAL_COOLDOWN_MS, MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "@crosscheck/connector-core/constants.ts";
import { writeCursorOffset } from "@crosscheck/connector-core/spool/cursor.ts";
import { readSessionSpool } from "@crosscheck/connector-core/spool/files.ts";
import { saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { sessionHealer } from "@crosscheck/connector-core/flows/heal-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "@crosscheck/connector-core/guarantees/declarations.ts";
import {
  sessionHealPathForSlug,
  sessionLineagePathForSlug,
  sessionSlug,
  sessionStatePath,
} from "@crosscheck/connector-core/config/paths.ts";
import { deriveSessionState, writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { readDropDetail } from "@crosscheck/connector-core/spool/drops.ts";
// By path, the wire-loss suite's arrangement: this package has no drizzle edge.
import { developers, workContextTargets, workContexts } from "../../server/src/db/schema.ts";

import {
  REPO_ID,
  SHUTDOWN_BUDGET_MS,
  advanceClock,
  bootCaptureHub,
  createHarness,
  handshake,
  toolCallUpdate,
  wireLine,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub, Harness } from "./fixtures/capture-harness.ts";
import { writeRepoFile } from "../../connector-core/test/helpers.ts";

/** More lives than the old three-rung ladder could give one session. */
const LIVES = 5;
const SESSION_ID = "sess_resumed";

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-resumed");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/** A proxy life that first sees the session through `session/load`. */
const loadSession = (h: Harness, id: number, sessionId: string = SESSION_ID): void => {
  h.capture.offer(
    "c2a",
    wireLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }),
  );
  h.capture.offer(
    "a2c",
    wireLine({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1, agentInfo: { name: "fake-agent", version: "1.0.0" } },
    }),
  );
  h.capture.offer(
    "c2a",
    wireLine({
      jsonrpc: "2.0",
      id,
      method: "session/load",
      params: { sessionId, cwd: h.repo, mcpServers: [] },
    }),
  );
  h.capture.offer("a2c", wireLine({ jsonrpc: "2.0", id, result: {} }));
};

const editIn = async (h: Harness, file: string, sessionId: string = SESSION_ID): Promise<void> => {
  await writeRepoFile(h.repo, file, "export const a = 1;\n");
  h.capture.offer(
    "a2c",
    toolCallUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: `call_${file}`,
      kind: "edit",
      status: "completed",
      locations: [{ path: join(h.repo, file) }],
    }),
  );
  await h.capture.settle();
};

describe("an ACP session loaded again after its proxy ended it", () => {
  test(`is captured in every one of ${String(LIVES)} proxy lives, nothing refused`, async () => {
    // Arrange: proxy life 0 births the session
    const first = await createHarness(hub, cleanups, "acp-resumed");
    const expected: string[] = [];

    // Act: every life edits, then its proxy exits and ends the session
    for (let life = 0; life < LIVES; life += 1) {
      const h =
        life === 0
          ? first
          : await createHarness(hub, cleanups, `acp-resumed-${String(life)}`, {
              home: first.home,
              repo: first.repo,
            });
      if (life === 0) {
        handshake(h, SESSION_ID, h.repo);
      } else {
        loadSession(h, 10 + life);
      }
      const file = `src/life-${String(life)}.ts`;
      expected.push(file);
      await editIn(h, file);
      await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
    }

    // Assert
    const rows = await hub.db.select({ value: workContextTargets.value }).from(workContextTargets);
    expect(
      rows.map((row) => row.value).filter((value) => value.startsWith("src/life-")).sort(),
    ).toEqual(expected);
    expect((await readDropDetail(first.home, first.hub.repoKey)).byReason["rejected"] ?? 0).toBe(0);
  });
});

describe("an ACP session the hub ends while its proxy keeps capturing", () => {
  test("the next capture heals into the next life, and the edits after it land there", async () => {
    // Arrange: a live session, then ended by another proxy on the same machine
    const h = await createHarness(hub, cleanups, "acp-mid-life");
    const sessionId = "sess_mid_life";
    const hostKey = `acp-fake-agent--${sessionId}`;
    handshake(h, sessionId, h.repo);
    await h.capture.settle();
    await fetch(`${hub.hubUrl}/api/sessions/${encodeURIComponent(`cc_${hostKey}`)}/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hub.apiKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const editAs = async (file: string): Promise<void> => {
      await writeRepoFile(h.repo, file, "export const a = 1;\n");
      h.capture.offer(
        "a2c",
        toolCallUpdate(sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: `call_${file}`,
          kind: "edit",
          status: "completed",
          locations: [{ path: join(h.repo, file) }],
        }),
      );
      await h.capture.settle();
    };

    // Act: the edit the hub refuses, then the next one
    await editAs("src/mid/refused.ts");
    await editAs("src/mid/after.ts");

    // Assert: the later edit is in the next life's work context
    const rows = await hub.db
      .select({ workContextId: workContextTargets.workContextId, value: workContextTargets.value })
      .from(workContextTargets);
    expect(rows.filter((row) => row.value.startsWith("src/mid/"))).toEqual([
      { workContextId: `wc_cc_${hostKey}~r1`, value: "src/mid/after.ts" },
    ]);
    expect((await readDropDetail(h.home, h.hub.repoKey)).rejectedCauses).toEqual({ session_ended: 1 });
  });
});

/**
 * A REGISTER THE HUB REFUSED AT session/new (review-2 finding 1). The
 * registration flush carried no healer, so the hub's `session_unknown` for
 * the life's own work context spent it, and every capture after a later heal
 * named a work context the hub never saw.
 */
describe("an ACP session whose register the hub refused", () => {
  test("is registered by its first flush, work context and all, and its edits land", async () => {
    // Arrange: a front to the hub that refuses the proxy's first register
    let refuseNext = 1;
    const front = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const { pathname, search } = new URL(request.url);
        if (request.method === "POST" && pathname === "/api/sessions" && refuseNext > 0) {
          refuseNext -= 1;
          return Response.json({ ok: false, error: { code: "unavailable", message: "down" } }, { status: 503 });
        }
        return fetch(`${hub.hubUrl}${pathname}${search}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" ? undefined : await request.arrayBuffer(),
        });
      },
    });
    const frontUrl = `http://127.0.0.1:${String(front.port)}`;
    const h = await createHarness({ ...hub, hubUrl: frontUrl }, cleanups, "acp-refused");
    // A LOGGED-IN machine: a refused register falls back to the stored
    // developer id, so the life's records name a developer the hub knows.
    const [developer] = await hub.db.select({ id: developers.id }).from(developers);
    await saveConfig(h.home, { version: 1, hubUrl: frontUrl, apiKey: hub.apiKey, developerId: developer?.id ?? "" });
    const sessionId = "sess_register_refused";
    const workContextId = `wc_cc_acp-fake-agent--${sessionId}`;

    // Act: session/new, then one edit
    handshake(h, sessionId, h.repo);
    await h.capture.settle();
    const contexts = await hub.db.select({ id: workContexts.id }).from(workContexts);
    await writeRepoFile(h.repo, "src/refused-register/a.ts", "export const a = 1;\n");
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_refused_register",
        kind: "edit",
        status: "completed",
        locations: [{ path: join(h.repo, "src/refused-register/a.ts") }],
      }),
    );
    await h.capture.settle();
    front.stop(true);

    // Assert: the work context reached the hub at registration, the edit after it
    expect(contexts.map((row) => row.id)).toContain(workContextId);
    const rows = await hub.db
      .select({ workContextId: workContextTargets.workContextId, value: workContextTargets.value })
      .from(workContextTargets);
    expect(rows.filter((row) => row.value.startsWith("src/refused-register/"))).toEqual([
      { workContextId, value: "src/refused-register/a.ts" },
    ]);
    expect((await readDropDetail(h.home, h.hub.repoKey)).byReason["rejected"] ?? 0).toBe(0);
  });
});

describe("an ACP-only machine sweeps the side files of lives that never came back (review finding 8)", () => {
  test("the proxy's shutdown reap removes lineage notes and heal stamps past their age", async () => {
    // Arrange: a live session gives the shutdown its home; a week-old note and stamp beside it
    const h = await createHarness(hub, cleanups, "acp-sweep");
    handshake(h, "sess_sweep", h.repo);
    await h.capture.settle();
    // Aged against the engine's own clock, which the harness freezes.
    const old = new Date(h.clock.value.getTime() - (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY);
    const sideFiles = [
      sessionLineagePathForSlug(h.home, sessionSlug("acp-gone")),
      sessionHealPathForSlug(h.home, sessionSlug("acp-gone")),
    ];
    for (const path of sideFiles) {
      await writeRepoFile(h.home, path.slice(h.home.length + 1), "{}\n");
      await utimes(path, old, old);
    }

    // Act
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert
    for (const path of sideFiles) {
      expect(await Bun.file(path).exists()).toBe(false);
    }
  });

  test("the proxy's shutdown removes the state file of a session silent for a week (review-2 round 6, HIGH-2)", async () => {
    // Arrange: a session that died without an end a week before the engine's clock
    const h = await createHarness(hub, cleanups, "acp-corpse");
    handshake(h, "sess_corpse_witness", h.repo);
    await h.capture.settle();
    const old = new Date(h.clock.value.getTime() - (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY);
    const corpse = deriveSessionState({
      hostSessionKey: "acp-gone-corpse",
      repoId: REPO_ID,
      repoRoot: h.repo,
      hubUrl: hub.hubUrl,
      developerId: null,
      startedAt: old.toISOString(),
    });
    await writeSessionState(h.home, { ...corpse, lastHeartbeatAt: old.toISOString() });
    await utimes(sessionStatePath(h.home, "acp-gone-corpse"), old, old);

    // Act
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert
    expect(await Bun.file(sessionStatePath(h.home, "acp-gone-corpse")).exists()).toBe(false);
  });
});

/**
 * A PROXY THAT EXITS AFTER A HEAL MOVED ITS SESSION (review-2 finding 2). The
 * proxy's shutdown races its dispatch chain against a timer, so it can end a
 * session whose in-memory twin still names the life a heal just moved the
 * state file off. The end deleted that state unconditionally: the healed life
 * stayed open with nothing naming it, and the next `session/load` landed on
 * it under a fresh epoch.
 */
describe("an ACP proxy that exits while a heal has moved its session on", () => {
  test("its shutdown ends the healed life too, and the next load starts above it", async () => {
    // Arrange: a live session the hub ended, healed by a walk the proxy's
    // in-memory session has not heard of yet
    const h = await createHarness(hub, cleanups, "acp-heal-exit");
    const sessionId = "sess_heal_exit";
    const hostKey = `acp-fake-agent--${sessionId}`;
    const base = `cc_${hostKey}`;
    handshake(h, sessionId, h.repo);
    await h.capture.settle();
    await fetch(`${hub.hubUrl}/api/sessions/${encodeURIComponent(base)}/end`, {
      method: "POST",
      headers: { Authorization: `Bearer ${hub.apiKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const healed = await sessionHealer({
      home: h.home,
      repoKey: h.hub.repoKey,
      hub: h.hub,
      agentKind: "acp:fake-agent",
      hostSessionKey: hostKey,
      repoId: REPO_ID,
      branch: "main",
      baseCommit: "0".repeat(40),
      guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
      now: () => h.clock.value,
    })({ sessionId: base, cause: "session_ended" }, Date.now() + SHUTDOWN_BUDGET_MS);

    // Act: the proxy exits; a later proxy loads the session and edits
    await h.capture.shutdown(SHUTDOWN_BUDGET_MS);
    const next = await createHarness(hub, cleanups, "acp-heal-exit-2", { home: h.home, repo: h.repo });
    loadSession(next, 30, sessionId);
    await editIn(next, "src/heal-exit/after.ts", sessionId);
    await next.capture.shutdown(SHUTDOWN_BUDGET_MS);

    // Assert: the healed life was ended by the exit, the load took a fresh one
    const healedLife = `${base}~r1`;
    expect(healed).toMatchObject({ outcome: "healed", refusedSessionId: base, sessionId: healedLife });
    const rows = await hub.db
      .select({ workContextId: workContextTargets.workContextId, value: workContextTargets.value })
      .from(workContextTargets);
    expect(rows.filter((row) => row.value.startsWith("src/heal-exit/"))).toEqual([
      { workContextId: `wc_${base}~r2`, value: "src/heal-exit/after.ts" },
    ]);
    expect(await readSessionCausalOrder(hub.db, healedLife)).toMatchObject({ state: "usable", epochs: 1 });
  });
});

/**
 * THE PROXY'S TWIN OF THE HEALER (review-2 round 6, MEDIUM-2): it forwards
 * the cooldown's verdict, and clears its in-memory seen-set on a heal onto
 * the same id as it does on a move to the next life (E1, E2).
 */
describe("an ACP session whose register the hub keeps refusing", () => {
  /** A front to the hub that refuses registers while asked to, and counts record deliveries. */
  const front = () => {
    const dials = { refuseRegisters: true, recordPosts: 0 };
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const { pathname, search } = new URL(request.url);
        if (request.method === "POST" && pathname === "/api/records") {
          dials.recordPosts += 1;
        }
        if (request.method === "POST" && pathname === "/api/sessions" && dials.refuseRegisters) {
          return Response.json({ ok: false, error: { code: "unavailable", message: "down" } }, { status: 503 });
        }
        return fetch(`${hub.hubUrl}${pathname}${search}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" ? undefined : await request.arrayBuffer(),
        });
      },
    });
    return { dials, server, url: `http://127.0.0.1:${String(server.port)}` };
  };

  /** A logged-in machine behind the front, its session on and its first walk refused. */
  const refusedSession = async (label: string, sessionId: string) => {
    const proxy = front();
    const h = await createHarness({ ...hub, hubUrl: proxy.url }, cleanups, label);
    const [developer] = await hub.db.select({ id: developers.id }).from(developers);
    await saveConfig(h.home, { version: 1, hubUrl: proxy.url, apiKey: hub.apiKey, developerId: developer?.id ?? "" });
    handshake(h, sessionId, h.repo);
    await h.capture.settle();
    return { h, proxy };
  };

  const editOnce = async (h: Harness, sessionId: string, file: string, call: string): Promise<void> => {
    await writeRepoFile(h.repo, file, `export const a = ${call.length};\n`);
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: call,
        kind: "edit",
        status: "completed",
        locations: [{ path: join(h.repo, file) }],
      }),
    );
    await h.capture.settle();
  };

  test("posts nothing inside the failed walk's cooldown (E2)", async () => {
    // Arrange
    const sessionId = "sess_cooldown_twin";
    const { h, proxy } = await refusedSession("acp-cooldown-twin", sessionId);
    const before = proxy.dials.recordPosts;

    // Act: a capture inside the cooldown
    await editOnce(h, sessionId, "src/twin/inside.ts", "call_inside");
    proxy.server.stop(true);

    // Assert
    expect(proxy.dials.recordPosts - before).toBe(0);
  });

  test("captures a file again after a heal onto the same id (E1)", async () => {
    // Arrange: an edit captured while the hub refuses the life, then spent by
    // an older connector's flush (the cursor past it, nothing sent)
    const sessionId = "sess_seen_twin";
    const { h, proxy } = await refusedSession("acp-seen-twin", sessionId);
    await editOnce(h, sessionId, "src/seen/a.ts", "call_a_first");
    const spool = await readSessionSpool(h.home, h.hub.repoKey, sessionSlug(`acp-fake-agent--${sessionId}`));
    await writeCursorOffset(spool.dataPath, spool.cursorPath, spool.size, spool);
    proxy.dials.refuseRegisters = false;
    advanceClock(h, HEAL_COOLDOWN_MS + 1);

    // Act: the edit whose flush heals the life as itself, then a.ts edited again
    await editOnce(h, sessionId, "src/seen/b.ts", "call_b");
    await editOnce(h, sessionId, "src/seen/a.ts", "call_a_again");
    proxy.server.stop(true);

    // Assert
    const rows = await hub.db.select({ value: workContextTargets.value }).from(workContextTargets);
    expect(rows.map((row) => row.value).filter((value) => value.startsWith("src/seen/")).sort()).toEqual([
      "src/seen/a.ts",
      "src/seen/b.ts",
    ]);
  });
});
