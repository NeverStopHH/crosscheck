/**
 * A hub that can answer BOTH injection surfaces at once — the briefing's
 * presence GET and the hint flow's candidates GET — which is exactly what a
 * briefing-vs-hint precedence pin needs: with both on offer, the hook after
 * a late registration must choose the briefing and never even ask for
 * candidates.
 *
 * EXTRACTED VERBATIM from connector-claude/test/briefing-parity.test.ts when
 * the cursor connector grew the same deferred-briefing surface: one hub, two
 * connectors, so the precedence both suites pin is proven against identical
 * canned answers (the hint-hub/slow-hub fixture pattern, one more member).
 */
import { rejectedApproachCandidate } from "./hint-hub.ts";

export interface ParityHubCalls {
  candidates: number;
  presence: number;
  records: number;
  other: number;
}

export interface ParityHub {
  readonly url: string;
  readonly calls: ParityHubCalls;
  readonly stop: () => void;
}

export const startParityHub = (teammateName: string): ParityHub => {
  const calls: ParityHubCalls = { candidates: 0, presence: 0, records: 0, other: 0 };
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/hints/candidates") {
        calls.candidates += 1;
        return Response.json({
          ok: true,
          data: { candidates: [rejectedApproachCandidate()] },
        });
      }
      if (pathname === "/api/presence") {
        calls.presence += 1;
        return Response.json({
          ok: true,
          data: {
            sessions: [
              {
                sessionId: "cc_other",
                developerId: "dev_other",
                developerName: teammateName,
                branch: "feat/rate-limit",
                status: "implementing",
                lastHeartbeatAt: new Date().toISOString(),
                isSelf: false,
              },
            ],
          },
        });
      }
      if (pathname === "/api/work-contexts") {
        return Response.json({ ok: true, data: { workContexts: [] } });
      }
      if (pathname === "/api/records") {
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
      calls.other += 1;
      return Response.json({
        ok: true,
        data: { session: { id: "cc_x", developerId: "dev_self" } },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: () => {
      server.stop(true);
    },
  };
};
