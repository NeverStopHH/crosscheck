/**
 * The statusline's own render marker (trial finding H7).
 *
 * `doctor` printed `PASS statusline registered` from a textual check of
 * `.claude/settings.json` — and the statusline is a terminal-TUI feature.
 * Every live session of the trial ran `--output-format stream-json` under the
 * VS Code extension, where Claude Code never calls it at all, so the
 * registration was perfect and the function had not run in days. Nothing
 * recorded a render (`grep -rn 'lastRender' packages/*​/src` found nothing),
 * which is why the surface could not tell the two apart.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";

import { runStatusline } from "../src/index.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { readStatuslineRendered } from "@crosscheck/connector-core/state/fired-markers.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "statusline-marker-uuid";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  for (const path of paths) {
    // The read-only case below chmods a subdirectory; restore it or the
    // cleanup cannot remove the tree it made.
    await chmod(join(path, "state"), 0o700).catch(() => undefined);
    await chmod(path, 0o700).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
  }
  paths.length = 0;
});

const acceptingHub = (): string => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true, data: { sessions: [] } }),
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const fixture = async (): Promise<{
  readonly repo: string;
  readonly home: string;
  readonly key: string;
  readonly env: Record<string, string>;
}> => {
  const repo = await makeRepo("statusline-marker", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("statusline-marker");
  paths.push(repo, home);
  const hubUrl = acceptingHub();
  return {
    repo,
    home,
    key: repoKey(hubUrl, REPO_ID),
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

const stdinFor = (repo: string): string =>
  JSON.stringify({ session_id: SESSION_ID, cwd: repo });

describe("statusline render marker", () => {
  test("a render records a parseable lastRenderedAt", async () => {
    // Arrange
    const { repo, home, key, env } = await fixture();

    // Act
    const line = await runStatusline(stdinFor(repo), env);

    // Assert: the line is still returned, and the fact is now on disk
    expect(line.startsWith("cx ")).toBe(true);
    const rendered = await readStatuslineRendered(home, key);
    expect(rendered).not.toBeNull();
    expect(Number.isNaN(Date.parse(rendered ?? ""))).toBe(false);
  });

  test("a statusline that resolves nothing records nothing", async () => {
    // Arrange: a cwd that is not a connected repo
    const { home, key, env } = await fixture();
    const elsewhere = await makeHome("statusline-marker-elsewhere");
    paths.push(elsewhere);

    // Act
    const line = await runStatusline(
      JSON.stringify({ session_id: SESSION_ID, cwd: elsewhere }),
      env,
    );

    // Assert
    expect(line).toBe("");
    expect(await readStatuslineRendered(home, key)).toBeNull();
  });

  test("a home the marker cannot be written to still gets its line", async () => {
    // Arrange: read-only home — the marker write must lose, never the line
    const { repo, home, env } = await fixture();
    const first = await runStatusline(stdinFor(repo), env);
    expect(first.startsWith("cx ")).toBe(true);
    await chmod(join(home, "state"), 0o500);

    // Act
    const line = await runStatusline(stdinFor(repo), env);

    // Assert
    expect(line.startsWith("cx ")).toBe(true);
  });
});
