/**
 * A hub with a dial for latency, shared by every test that has to prove a hook
 * survives a slow one.
 *
 * Latency is split per endpoint on purpose. The budget incidents were all about
 * WHICH call was allowed to spend the hook's remaining time, so a test has to be
 * able to make the drain expensive while the briefing's own calls stay cheap —
 * otherwise a missing briefing has two possible causes and proves neither.
 *
 * `latency` is handed back mutable: a test that needs an `end` call to miss its
 * timeout and then land changes one number instead of restarting a server.
 */

export interface HubCalls {
  records: number;
  end: number;
  register: number;
  presence: number;
  contexts: number;
  heartbeat: number;
}

export interface HubLatency {
  /** POST /api/records — the drain. */
  ingest: number;
  /** POST /api/sessions/:id/end. */
  end: number;
  /** Everything else: register, presence, work-contexts, heartbeat. */
  other: number;
}

export interface MockHub {
  readonly url: string;
  readonly calls: HubCalls;
  readonly latency: HubLatency;
  readonly stop: () => void;
}

/** The one teammate every briefing rendered against this hub must mention. */
export const TEAMMATE_NAME = "Teammate";
export const TEAMMATE_BRANCH = "feat/rate-limit";
export const SELF_DEVELOPER_ID = "dev_self";

const noCalls = (): HubCalls => ({
  records: 0,
  end: 0,
  register: 0,
  presence: 0,
  contexts: 0,
  heartbeat: 0,
});

const sleep = (ms: number): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise((done) => {
        setTimeout(done, ms);
      });

const presenceBody = (): Response =>
  Response.json({
    ok: true,
    data: {
      sessions: [
        {
          sessionId: "cc_other",
          developerId: "dev_other",
          developerName: TEAMMATE_NAME,
          branch: TEAMMATE_BRANCH,
          status: "implementing",
          lastHeartbeatAt: new Date().toISOString(),
          isSelf: false,
        },
      ],
    },
  });

const sessionBody = (): Response =>
  Response.json({
    ok: true,
    data: { session: { id: "cc_x", developerId: SELF_DEVELOPER_ID } },
  });

export const startSlowHub = (latency: HubLatency): MockHub => {
  const calls = noCalls();
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/records") {
        await sleep(latency.ingest);
        const body = (await request.json()) as { records: readonly unknown[] };
        calls.records += 1;
        return Response.json({
          ok: true,
          data: {
            accepted: body.records.length,
            duplicates: 0,
            ignored: 0,
            rejected: 0,
          },
        });
      }
      if (pathname.endsWith("/end")) {
        await sleep(latency.end);
        // Counted only when the caller was still listening: an `end` the client
        // abandoned mid-flight is precisely the one it must not rely on.
        if (request.signal.aborted) {
          return new Response(null, { status: 499 });
        }
        calls.end += 1;
        return sessionBody();
      }
      await sleep(latency.other);
      if (pathname === "/api/presence") {
        calls.presence += 1;
        return presenceBody();
      }
      if (pathname === "/api/work-contexts") {
        calls.contexts += 1;
        return Response.json({ ok: true, data: { workContexts: [] } });
      }
      if (pathname.endsWith("/heartbeat")) {
        calls.heartbeat += 1;
        return sessionBody();
      }
      calls.register += 1;
      return sessionBody();
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    latency,
    stop: () => {
      server.stop(true);
    },
  };
};