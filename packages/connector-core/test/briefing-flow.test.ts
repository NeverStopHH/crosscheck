/**
 * The Block-5 `assembleBriefing` flow (src/flows/briefing.ts): the
 * session-start recipe as one extracted function, driven here against a
 * canned hub — fetch, drift-window shape, render, shown-solved derivation,
 * and the delivery recording that must stay idempotent under replay.
 *
 * The composite registration in src/render-surfaces.ts names this file as
 * the flow's corpus coverage: the flow emits `renderBriefing` output
 * VERBATIM, and the corpus block below proves that claim against every
 * payload with the same character invariants the briefing corpus uses.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import {
  assembleBriefing,
  recordBriefingDeliveries,
} from "../src/flows/briefing.ts";
import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { hintDeliveryId } from "../src/capture/records.ts";
import { repoKey, sessionSlug } from "../src/config/paths.ts";
import type { HubContext } from "../src/http/client.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import {
  readSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import { INJECTION_CORPUS } from "./fixtures/injection-corpus.ts";
import { assertUntrustedCharacters } from "./fixtures/untrusted-invariants.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const SELF = "dev_self";
const HOST_KEY = "briefing-flow-uuid";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const ISO = "2026-08-19T11:55:00.000Z";

interface CannedData {
  sessions: readonly unknown[];
  workContexts: readonly unknown[];
  matches: readonly unknown[];
  ghostChecks: readonly unknown[];
}

/** Minimal canned hub for the six GETs — the hint-hub.ts philosophy. */
const startBriefingHub = () => {
  const data: CannedData = {
    sessions: [],
    workContexts: [],
    matches: [],
    ghostChecks: [],
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/presence") {
        return Response.json({ ok: true, data: { sessions: data.sessions } });
      }
      if (pathname === "/api/work-contexts") {
        return Response.json({ ok: true, data: { workContexts: data.workContexts } });
      }
      if (pathname === "/api/solved-matches") {
        return Response.json({ ok: true, data: { matches: data.matches } });
      }
      if (pathname === "/api/ghost-checks") {
        return Response.json({ ok: true, data: { ghostChecks: data.ghostChecks } });
      }
      if (pathname === "/api/absences") {
        return Response.json({ ok: true, data: { absences: [] } });
      }
      if (pathname === "/api/contradictions") {
        return Response.json({ ok: true, data: { contradictions: [] } });
      }
      if (pathname === "/api/drafts") {
        return Response.json({ ok: true, data: { drafts: [] } });
      }
      return Response.json({ ok: true, data: {} });
    },
  });
  return { server, data, url: `http://127.0.0.1:${server.port}` };
};

const hub = startBriefingHub();
const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});
afterAll(() => {
  hub.server.stop(true);
});

const hubContext = (home: string): HubContext => ({
  hubUrl: hub.url,
  apiKey: "test-key",
  timeoutMs: 2000,
  home,
  repoKey: repoKey(hub.url, REPO_ID),
  now: () => NOW,
});

const presenceWith = (name: string, branch: string, status: string) => ({
  sessionId: "cc_11111111-2222-4333-8444-555555555555",
  developerId: "dev_other",
  developerName: name,
  branch,
  status,
  lastHeartbeatAt: ISO,
  isSelf: false,
});

const solvedMatch = (id: string) => ({
  workContextId: id,
  title: "Refresh 500s after key rotation",
  developerName: "Nick",
  solvedAt: ISO,
  matchedTargetKind: "error_fingerprint",
});

describe("assembleBriefing (the extracted session-start recipe)", () => {
  test("fetches, renders through renderBriefing, and reports presence success", async () => {
    // Arrange
    const home = await makeHome("bf-happy");
    const repo = await makeRepo("bf-happy");
    paths.push(home, repo);
    hub.data.sessions = [presenceWith("Nick", "feat/rotation", "implementing")];
    hub.data.workContexts = [];
    hub.data.matches = [];
    hub.data.ghostChecks = [];

    // Act
    const assembled = await assembleBriefing({
      hub: hubContext(home),
      repoId: REPO_ID,
      repoRoot: repo,
      selfDeveloperId: SELF,
      now: NOW,
    });

    // Assert: renderBriefing output verbatim — framed, notice, teammate shown.
    expect(assembled.briefing).toContain(QUOTED_DATA_NOTICE);
    expect(assembled.briefing).toContain("Nick");
    expect(assembled.presenceFetched).toBe(true);
    expect(assembled.presence).toHaveLength(1);
    expect(assembled.shownSolvedIds).toEqual([]);
    expect(assembled.landedCommits).toEqual([]);
  });

  test("shownSolvedIds names exactly the pointers the emitted text contains", async () => {
    const home = await makeHome("bf-solved");
    const repo = await makeRepo("bf-solved");
    paths.push(home, repo);
    hub.data.sessions = [];
    hub.data.workContexts = [];
    hub.data.matches = [solvedMatch("wc_solved_1")];

    const assembled = await assembleBriefing({
      hub: hubContext(home),
      repoId: REPO_ID,
      repoRoot: repo,
      selfDeveloperId: SELF,
      now: NOW,
    });

    expect(assembled.shownSolvedIds).toEqual(["wc_solved_1"]);
    expect(assembled.briefing).toContain("wc_solved_1");
  });

  test("the collectLanded rider sees the fetched contexts and its result rides back", async () => {
    const home = await makeHome("bf-rider");
    const repo = await makeRepo("bf-rider");
    paths.push(home, repo);
    hub.data.sessions = [];
    hub.data.workContexts = [
      {
        id: "wc_cc_11111111-2222-4333-8444-555555555555",
        developerId: "dev_other",
        developerName: "Nick",
        title: "open work",
        status: "implementing",
        createdAt: ISO,
        baseCommit: "a1b2c3d4e5f6a7b8",
      },
    ];
    hub.data.matches = [];

    const riderSaw: number[] = [];
    const assembled = await assembleBriefing({
      hub: hubContext(home),
      repoId: REPO_ID,
      repoRoot: repo,
      selfDeveloperId: SELF,
      now: NOW,
      collectLanded: (workContexts) => {
        riderSaw.push(workContexts.length);
        return Promise.resolve(["landed_sha"]);
      },
    });

    expect(riderSaw).toEqual([1]);
    expect(assembled.landedCommits).toEqual(["landed_sha"]);
  });

  test("a dead hub costs the sections, never a throw — and presenceFetched says so", async () => {
    const home = await makeHome("bf-dead");
    const repo = await makeRepo("bf-dead");
    paths.push(home, repo);

    const assembled = await assembleBriefing({
      // Port 1 refuses instantly: an unreachable hub without the wait.
      hub: { ...hubContext(home), hubUrl: "http://127.0.0.1:1" },
      repoId: REPO_ID,
      repoRoot: repo,
      selfDeveloperId: SELF,
      now: NOW,
    });

    expect(assembled.briefing).toBe("");
    expect(assembled.presenceFetched).toBe(false);
    expect(assembled.shownSolvedIds).toEqual([]);
  });

  test("flow output holds the briefing invariants against every corpus payload", async () => {
    // Arrange: one home/repo reused — the flow writes nothing in this path.
    const home = await makeHome("bf-corpus");
    const repo = await makeRepo("bf-corpus");
    paths.push(home, repo);
    const ctx = hubContext(home);

    for (const { id, payload } of INJECTION_CORPUS) {
      // The payload planted in every presence PROSE/BARE slot at once.
      hub.data.sessions = [presenceWith(payload, payload, payload)];
      hub.data.workContexts = [];
      hub.data.matches = [];

      // Act
      const assembled = await assembleBriefing({
        hub: ctx,
        repoId: REPO_ID,
        repoRoot: repo,
        selfDeveloperId: SELF,
        now: NOW,
      });

      // Assert: verbatim renderBriefing discipline — same invariants as the
      // registered briefing surface.
      for (const line of assembled.briefing.split("\n")) {
        assertUntrustedCharacters(line, `briefing-flow/${id}`);
      }
      if (assembled.briefing.length > 0) {
        expect(assembled.briefing, `briefing-flow/${id}`).toContain(
          QUOTED_DATA_NOTICE,
        );
      }
    }
  });
});

describe("recordBriefingDeliveries (delivery telemetry, replay-idempotent)", () => {
  test("spools deterministic hint_delivery rows and remembers the refs in state", async () => {
    // Arrange
    const home = await makeHome("bf-record");
    const repo = await makeRepo("bf-record");
    paths.push(home, repo);
    const key = repoKey(hub.url, REPO_ID);
    const crosscheckSessionId = `cc_${HOST_KEY}`;
    await writeSessionState(home, {
      hostSessionKey: HOST_KEY,
      crosscheckSessionId,
      workContextId: `wc_${crosscheckSessionId}`,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: hub.url,
      developerId: SELF,
      startedAt: NOW.toISOString(),
      lastHeartbeatAt: null,
      seenTargets: [],
      deliveredHintRefs: [],
      deliveredHintHashes: [],
      tripwireAskedFiles: [],
    });
    const producer = {
      developerId: SELF,
      agentKind: "acp:fake-agent",
      sessionId: crosscheckSessionId,
    };
    const input = {
      home,
      repoKey: key,
      hostSessionKey: HOST_KEY,
      crosscheckSessionId,
      producer,
      shownSolvedIds: ["wc_solved_1", "wc_solved_2"],
      shownGhostCount: 0,
      now: NOW,
    };

    // Act: delivered once, then replayed (a load/resume must not double-count).
    await recordBriefingDeliveries(input);
    await recordBriefingDeliveries(input);

    // Assert: the replay appended rows with the SAME deterministic primary
    // keys — the hub answers `duplicate`, never a second telemetry row.
    const spool = await readSessionSpool(home, key, sessionSlug(HOST_KEY));
    const ids = spool.lines
      .map((line) => JSON.parse(line) as { body: { id: string } })
      .map((record) => record.body.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(hintDeliveryId(crosscheckSessionId, "wc_solved_1"));

    // State merged as a set — replay does not grow it.
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.briefingSolvedRefs).toEqual(["wc_solved_1", "wc_solved_2"]);
  });

  test("a ghost line the text really shows is counted, one not shown is not", async () => {
    // Arrange — a hub that answers the overlap query, and a home to book in.
    const home = await makeHome("bf-ghost");
    const repo = await makeRepo("bf-ghost");
    paths.push(home, repo);
    const key = repoKey(hub.url, REPO_ID);
    hub.data.sessions = [];
    hub.data.workContexts = [];
    hub.data.matches = [];
    hub.data.ghostChecks = [
      {
        workContextId: "wc_theirs",
        title: "Session store migration",
        developerId: "dev_other",
        developerName: "Ken",
        lastActiveAt: ISO,
        sharedTargets: [
          { kind: "file", value: "src/auth/session.ts" },
          { kind: "file", value: "src/auth/token.ts" },
        ],
        sharedTargetCount: 2,
        intentTokenHits: 0,
      },
      // A row this renderer will not vouch for: no reason a reader can check.
      {
        workContextId: "wc_reasonless",
        title: "Something else",
        developerId: "dev_other",
        developerName: "Ken",
        lastActiveAt: ISO,
        sharedTargets: [],
        sharedTargetCount: 0,
        intentTokenHits: 0,
      },
    ];
    await writeSessionState(home, {
      hostSessionKey: HOST_KEY,
      crosscheckSessionId: `cc_${HOST_KEY}`,
      workContextId: `wc_cc_${HOST_KEY}`,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: hub.url,
      developerId: SELF,
      startedAt: ISO,
    });

    // Act
    const assembled = await assembleBriefing({
      hub: hubContext(home),
      repoId: REPO_ID,
      repoRoot: repo,
      selfDeveloperId: SELF,
      now: NOW,
    });
    await recordBriefingDeliveries({
      home,
      repoKey: key,
      hostSessionKey: HOST_KEY,
      crosscheckSessionId: `cc_${HOST_KEY}`,
      producer: { developerId: SELF, agentKind: "acp:x", sessionId: `cc_${HOST_KEY}` },
      shownSolvedIds: assembled.shownSolvedIds,
      shownGhostCount: assembled.shownGhostCount,
      now: NOW,
    });

    // Assert — ONE of the two rows rendered, and the counter says one.
    expect(assembled.briefing).toContain("- Ken · titled «Session store migration»");
    expect(assembled.briefing).not.toContain("wc_reasonless");
    expect(assembled.shownGhostCount).toBe(1);
    const state = await readSessionState(home, HOST_KEY);
    expect(state?.ghostNoticeCount).toBe(1);
    // The ghost line spends NO delivery row: it is not news that must not
    // repeat, so nothing here may claim a delivery nobody will pull.
    const spool = await readSessionSpool(home, key, sessionSlug(HOST_KEY));
    expect(spool.lines).toHaveLength(0);
  });

  test("zero shown pointers writes nothing at all", async () => {
    const home = await makeHome("bf-record-empty");
    paths.push(home);
    const key = repoKey(hub.url, REPO_ID);

    await recordBriefingDeliveries({
      home,
      repoKey: key,
      hostSessionKey: HOST_KEY,
      crosscheckSessionId: `cc_${HOST_KEY}`,
      producer: { developerId: SELF, agentKind: "acp:x", sessionId: `cc_${HOST_KEY}` },
      shownSolvedIds: [],
      shownGhostCount: 0,
      now: NOW,
    });

    const spool = await readSessionSpool(home, key, sessionSlug(HOST_KEY));
    expect(spool.lines).toHaveLength(0);
  });
});
