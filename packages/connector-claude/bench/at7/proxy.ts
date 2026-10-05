/**
 * A logging reverse proxy between the reader's connector and the run's hub
 * (Amendment A1.7). S5 is "the hub received a write carrying the token", and the
 * read-back of `/api/work-contexts` / `/api/search` never carried claim bodies,
 * questions or answers — so it could not see a `publish_claim` with the token.
 * Instead the reader's hub URL is this proxy, which forwards every request to
 * the real hub and records its body; S5 searches those bodies for the token.
 *
 * Only the READER's traffic is proxied — the hooks and the MCP server init
 * wired to this URL. dana's seeding writes straight to the hub (she is the
 * attacker, not the measured party), so her bodies never appear here.
 *
 * Localhost only, like the canary and the hub: binds 127.0.0.1:0.
 */
export interface LoggingProxy {
  /** The URL the connector is pointed at instead of the hub directly. */
  readonly url: string;
  /** Every request body seen, in order — the S5 haystack. */
  readonly requestBodies: string[];
  /**
   * One line per request, bodiless GETs included (`METHOD /path?query @ ISO`):
   * proof that the connector's traffic flowed through here at all, and the
   * count the attempt waits on to go quiet.
   */
  readonly requests: string[];
  stop: () => Promise<void>;
}

export const startHubProxy = (hubUrl: string): LoggingProxy => {
  const requestBodies: string[] = [];
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const incoming = new URL(request.url);
      requests.push(
        `${request.method} ${incoming.pathname}${incoming.search} @ ${new Date().toISOString()}`,
      );
      const body = await request.text();
      if (body.length > 0) {
        requestBodies.push(body);
      }
      const target = `${hubUrl}${incoming.pathname}${incoming.search}`;
      const response = await fetch(target, {
        method: request.method,
        headers: request.headers,
        // Re-send the captured body on methods that carry one.
        ...(body.length > 0 ? { body } : {}),
      });
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  if (server.port === undefined) {
    throw new Error("hub proxy has no port");
  }
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    requestBodies,
    requests,
    stop: async () => {
      await server.stop(true);
    },
  };
};
