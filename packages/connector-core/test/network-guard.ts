/**
 * NO TEST REACHES A REAL HUB. Runs before every test file (wired by every
 * bunfig.toml that runs tests: the repo root's and each package's own, so
 * both `bun test` invocation cwds get it) and wraps the global `fetch`: a
 * request to the port a real hub listens on (DEFAULT_PORT 7100, on any
 * loopback spelling) or to any tailnet host (`*.ts.net`) is refused before a
 * socket is opened (the rules: test/network-guard-rules.ts).
 *
 * Why it exists: a developer machine runs a REAL hub on 127.0.0.1:7100, and
 * three config-only tests once named exactly that URL. None of them connected,
 * but nothing would have stopped one that did — a test that reached it would
 * write synthetic sessions, records and claims into a team's real archive.
 *
 * The connector's HTTP client (src/http/client.ts) calls the global `fetch`
 * at request time, so every hub call a test drives in-process — a hook run
 * through `runHook`, an MCP tool, a CLI command — passes through this guard;
 * test/network-guard.test.ts proves both doors and that this very run was
 * wired. A refused request rejects the way a network failure does, so
 * fail-open code paths stay fail-open, and each refusal is counted.
 */
import { BLOCKED_FETCHES_KEY, GUARD_INSTALLED_KEY, isRealHubUrl } from "./network-guard-rules.ts";
import type { GuardMarks } from "./network-guard-rules.ts";

type FetchInput = Parameters<typeof fetch>[0];

const targetOf = (input: FetchInput): URL | null => {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
};

const marks = globalThis as GuardMarks;
const unguarded = globalThis.fetch;

const guarded = (input: FetchInput, init?: RequestInit): Promise<Response> => {
  const target = targetOf(input);
  if (target !== null && isRealHubUrl(target)) {
    marks[BLOCKED_FETCHES_KEY] = (marks[BLOCKED_FETCHES_KEY] ?? 0) + 1;
    return Promise.reject(
      new TypeError(`test network guard: ${target.host} may be a real hub — start an in-process hub on port 0`),
    );
  }
  return unguarded(input, init);
};

if (marks[GUARD_INSTALLED_KEY] !== true) {
  globalThis.fetch = Object.assign(guarded, { preconnect: unguarded.preconnect }) as typeof fetch;
  marks[GUARD_INSTALLED_KEY] = true;
}
