/**
 * EVERY TEST SERVER LISTENS ON THE ADDRESS ITS URL NAMES: 127.0.0.1.
 *
 * `Bun.serve({ port: 0 })` alone listens on the dual-stack wildcard
 * `*:<port>`, while the tests hand hooks, CLIs and MCP tools
 * `http://127.0.0.1:<port>`. On macOS any OTHER process may then bind
 * `127.0.0.1:<that port>` — a more specific address the wildcard does not
 * reserve — and it answers every new connection to the URL the test handed
 * out: six of six requests reached the other process when measured
 * (connector-claude test/landed-notice-author-hook.test.ts). With seven
 * suites, other agents' suites and a real hub sharing one machine, that is a
 * test talking to somebody else's server: a fast, rare, load-only red with
 * no behaviour wrong. Bound to 127.0.0.1 itself, a second bind there is
 * refused and a wildcard bind no longer takes the traffic.
 *
 * `serveLoopback` is `Bun.serve` with the hostname forced, same options, same
 * server object, so a call site changes its callee and nothing else; a site
 * that names no port gets an ephemeral one, never Bun's default 3000.
 * test/loopback-bind.test.ts fails on any test server bound another way.
 */

/** The one address a test server listens on, and the one its URL names. */
export const LOOPBACK_HOST = "127.0.0.1";

/** `Bun.serve`, bound to LOOPBACK_HOST whatever the options say. */
export const serveLoopback: typeof Bun.serve = ((options: Record<string, unknown>) =>
  Bun.serve({ port: 0, ...options, hostname: LOOPBACK_HOST } as Parameters<typeof Bun.serve>[0])) as unknown as typeof Bun.serve;

/** The URL a test hands out for a server `serveLoopback` started. */
export const loopbackUrl = (server: { readonly port: number | undefined }): string =>
  `http://${LOOPBACK_HOST}:${String(server.port)}`;
