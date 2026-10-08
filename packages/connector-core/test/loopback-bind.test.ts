/**
 * NO TEST SERVER LISTENS ANYWHERE BUT THE ADDRESS ITS URL NAMES.
 *
 * Every test hub used to be `Bun.serve({ port: 0 })` — the dual-stack
 * wildcard — handed to hooks as `http://127.0.0.1:<port>`, and on this
 * platform another process may bind `127.0.0.1:<that port>` afterwards and
 * answer every new connection (fixtures/loopback-serve.ts says what was
 * measured). The fix is one helper, `serveLoopback`; this file keeps it the
 * fix:
 *
 *   - THE SCAN: every `Bun.serve(` and `Bun.listen(` under any package's
 *     test/ tree either IS the helper, or names a `hostname` in its own
 *     options (the inline form fix/false-landed-stamp used for its three
 *     tests is accepted, so the two branches merge as they are). A bare
 *     wildcard bind fails here with its file and line.
 *   - THE BIND: a server the helper started cannot be bound over by another
 *     process — the property the scan stands in for, measured, not assumed.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { LOOPBACK_HOST, loopbackUrl, serveLoopback } from "./fixtures/loopback-serve.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const PACKAGES = join(REPO_ROOT, "packages");
const HELPER = join(import.meta.dir, "fixtures", "loopback-serve.ts");
const BIND_CALL = /Bun\.(serve|listen)\(/g;

const testFiles = (): readonly string[] =>
  readdirSync(PACKAGES).flatMap((pkg) => {
    const root = join(PACKAGES, pkg, "test");
    try {
      return readdirSync(root, { recursive: true })
        .map(String)
        .filter((path) => path.endsWith(".ts") && !path.includes("node_modules"))
        .map((path) => join(root, path));
    } catch {
      return [];
    }
  });

/** The call's argument text, from its `(` to the matching `)`. */
const argumentsAt = (source: string, open: number): string => {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return source.slice(open);
};

/** `file:line` for every bind that names no hostname of its own. */
const wildcardBinds = (): readonly string[] =>
  testFiles()
    .filter((file) => file !== HELPER && file !== import.meta.path)
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(BIND_CALL)].flatMap((match) => {
        // A comment that QUOTES the call (`Bun.serve({ port: 0 })` explained
        // in prose) binds nothing.
        const lineStart = source.lastIndexOf("\n", match.index) + 1;
        if (/^\s*(\*|\/\/|\/\*)/.test(source.slice(lineStart, match.index))) {
          return [];
        }
        const options = argumentsAt(source, (match.index ?? 0) + match[0].length - 1);
        if (/\bhostname\s*:/.test(options)) {
          return [];
        }
        const line = source.slice(0, match.index).split("\n").length;
        return [`${relative(REPO_ROOT, file)}:${String(line)}`];
      });
    });

/** Whether ANOTHER process may bind `host:port`: "bound" or "refused". */
const bindFromAnotherProcess = (host: string, port: number): string => {
  const probe = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `try { Bun.serve({ port: ${String(port)}, hostname: "${host}", fetch: () => new Response("") }); console.log("bound"); } catch { console.log("refused"); } process.exit(0);`,
    ],
    // The test's own env, so the network guard's preload and scrub reach the
    // child (connector-core test/network-guard.test.ts, round 3 F-M3).
    env: { ...process.env },
    timeout: 20_000,
  });
  return new TextDecoder().decode(probe.stdout).trim();
};

describe("test servers bind the address their URL names", () => {
  test("no test file binds a server to the wildcard", () => {
    // Assert: the list names each offender, so a red says where
    expect(wildcardBinds()).toEqual([]);
  });

  test("the scan sees the test trees at all", () => {
    // A scan that found no files would pass the test above vacuously.
    const files = testFiles();
    expect(files.length).toBeGreaterThan(400);
    expect(files.some((file) => file.endsWith(join("connector-core", "test", "fixtures", "hint-hub.ts")))).toBe(true);
  });

  test("a server the helper started cannot be bound over by another process", () => {
    // Arrange
    const server = serveLoopback({ port: 0, fetch: () => new Response("ours") });

    // Act
    const answer = bindFromAnotherProcess(LOOPBACK_HOST, server.port ?? 0);
    server.stop(true);

    // Assert: refused — every request to the URL below reaches THIS server
    expect(answer).toBe("refused");
    expect(loopbackUrl(server)).toBe(`http://127.0.0.1:${String(server.port)}`);
  });
});
