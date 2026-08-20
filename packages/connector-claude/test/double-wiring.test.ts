/**
 * Double wiring, exactly-once (finding #11): a folder can carry BOTH
 * project-scoped crosscheck hooks and the user-level ones `init --global`
 * installs. Claude Code runs an identical handler defined in more than one
 * settings file once (code.claude.com/docs/en/hooks, "If you define the
 * same handler in more than one settings file, it runs once") — but the
 * two wirings can spell the launcher differently (a teammate's committed
 * PATH form vs. this machine's absolute entry path), and differing
 * spellings BOTH run. Capture must stay exactly-once anyway.
 *
 * What carries it, proven here rather than assumed:
 *   - the FIRST invocation registers (claimSessionState — the
 *     recovery-race machinery) and spools ONE work context;
 *   - the SECOND invocation of the same event with the same payload finds
 *     the state file, sees the target in the seen-set, and appends
 *     NOTHING;
 *   - the hub is idempotent for replays that race past the seen-set
 *     (server records.test.ts pins duplicate targets and byte-identical
 *     claim replays as `duplicate`, `onConflictDoNothing` on the unique
 *     constraint), so even two PARALLEL fires that both pass the read
 *     collapse to one row at ingest.
 *
 * Proven red by mutation: disabling the seen-set check in
 * flows/capture-targets.ts (`seen.has` → `false`) makes the second fire
 * append a duplicate target and this test fail — that mutation is
 * catalogued in connector-core/scripts/mutation-check.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const TIMEOUT_MS = "4000";

const paths: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const startHub = (): { readonly url: string; registers: () => number } => {
  let registers = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/sessions" && request.method === "POST") {
        registers += 1;
        return Response.json({
          ok: true,
          data: { session: { id: "cc_dw-uuid", developerId: "dev_dw" } },
        });
      }
      return Response.json({ ok: true, data: {} });
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  return { url: `http://127.0.0.1:${server.port}`, registers: () => registers };
};

const postToolUsePayload = (repo: string): string =>
  JSON.stringify({
    session_id: "dw-uuid",
    cwd: repo,
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: `${repo}/src/limiter.ts` },
    tool_response: {},
  });

describe("the same hook event fired through both wirings", () => {
  test("post-tool-use twice: one work context, one target, one register", async () => {
    // Arrange: a connected repo (committed .crosscheck.json), no state file
    // yet — the first fire takes the recovery path, the second is the
    // double-wired duplicate
    const repo = await makeRepo("double-wire", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("double-wire");
    paths.push(repo, home);
    await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");
    const hub = startHub();
    await writeFile(
      join(repo, ".crosscheck.json"),
      `${JSON.stringify({ hubUrl: hub.url }, null, 2)}\n`,
      "utf8",
    );
    const env: Env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    };
    const payload = postToolUsePayload(repo);

    // Act: the exact double-fire Claude Code produces when the project and
    // user settings spell the launcher differently
    const first = await runHook("post-tool-use", payload, env);
    const second = await runHook("post-tool-use", payload, env);

    // Assert: exactly-once everywhere it counts
    expect(first).toBe("");
    expect(second).toBe("");
    expect(hub.registers()).toBe(1);
    const records = (await readSpoolLines(home, repoKey(hub.url, REPO_ID))).map(
      (line) => JSON.parse(line) as { kind: string; body?: { value?: string } },
    );
    expect(records.filter((record) => record.kind === "work_context")).toHaveLength(1);
    expect(
      records.filter(
        (record) =>
          record.kind === "target" && record.body?.value === "src/limiter.ts",
      ),
    ).toHaveLength(1);
  });
});
