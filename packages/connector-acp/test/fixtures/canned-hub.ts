/**
 * A fully canned hub for the injection suites (hint-hub.ts philosophy):
 * every route the register/briefing/hint pipeline touches, answered from
 * fixtures, with latency DIALS — a deliberately slow presence GET is what
 * makes "briefing not ready → skipped → next prompt gets it" deterministic
 * instead of a race. The capture suites keep the REAL in-process server
 * (capture-harness.ts); injection decisions need control, not realism.
 */
import { rejectedApproachCandidate } from "../../../connector-core/test/fixtures/hint-hub.ts";

export interface CannedHubLatency {
  presence: number;
  candidates: number;
}

export interface CannedHub {
  readonly url: string;
  readonly latency: CannedHubLatency;
  setCandidates(next: readonly unknown[]): void;
  stop(): void;
}

const sleep = (ms: number): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise((done) => {
        setTimeout(done, ms);
      });

export const startCannedHub = (): CannedHub => {
  const latency: CannedHubLatency = { presence: 0, candidates: 0 };
  let candidates: readonly unknown[] = [rejectedApproachCandidate()];
  const teammate = {
    sessionId: "cc_teammate",
    developerId: "dev_nick",
    developerName: "Nick",
    branch: "feat/refresh-fix",
    status: "implementing",
    lastHeartbeatAt: new Date().toISOString(),
    isSelf: false,
  };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/presence") {
        await sleep(latency.presence);
        return Response.json({ ok: true, data: { sessions: [teammate] } });
      }
      if (pathname === "/api/hints/candidates") {
        await sleep(latency.candidates);
        return Response.json({ ok: true, data: { candidates } });
      }
      if (pathname === "/api/work-contexts") {
        return Response.json({ ok: true, data: { workContexts: [] } });
      }
      if (pathname === "/api/absences") {
        return Response.json({ ok: true, data: { absences: [] } });
      }
      if (pathname === "/api/contradictions") {
        return Response.json({ ok: true, data: { contradictions: [] } });
      }
      if (pathname === "/api/solved-matches") {
        return Response.json({ ok: true, data: { matches: [] } });
      }
      if (pathname === "/api/drafts") {
        return Response.json({ ok: true, data: { drafts: [] } });
      }
      if (pathname === "/api/records") {
        const body = (await request.json()) as { records: readonly unknown[] };
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
      if (pathname === "/api/sessions") {
        const body = (await request.json()) as { id: string };
        return Response.json({
          ok: true,
          data: { session: { id: body.id, developerId: "dev_self" } },
        });
      }
      return Response.json({ ok: true, data: {} });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    latency,
    setCandidates: (next) => {
      candidates = next;
    },
    stop: () => {
      server.stop(true);
    },
  };
};
