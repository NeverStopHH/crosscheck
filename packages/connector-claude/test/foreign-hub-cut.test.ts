/**
 * A HOOK THE BUDGET CUTS IN A REPO OF ANOTHER HUB (integration review of
 * batch 2, M2) — the review's probe, the other way round.
 *
 * A repo whose `.crosscheck.json` names a hub the developer's key does not
 * belong to captures nothing: every hook there is refused, the key stays home
 * (core config/key-binding.ts). But when the budget won before the hook knew
 * its repo, the unresolved-owner rule asked only whether a `.crosscheck.json`
 * exists, so the bait repo counted as connected: an unkeyed `hook_timed_out`
 * and a briefing omission were charged to EVERY repo of the machine — and
 * travelled to the developer's own hub as `telemetry_lost` — while the
 * session read "no briefing … the hub or git did not answer" instead of the
 * line saying it reports to no hub from here. A bait repo with a slow git
 * set it off on purpose.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoKey } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { readBriefingOmissions } from "@crosscheck/connector-core/state/briefing-omissions.ts";
import { lossLedgerPath } from "@crosscheck/connector-core/state/loss-ledger.ts";
import { readTelemetryLossReport } from "@crosscheck/connector-core/spool/loss-report.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const OWN_HUB = "http://127.0.0.1:1";
const FOREIGN_HUB = "http://127.0.0.1:2";
const OWN_REPO_ID = "github.com/acme/api";
/** Long enough that a 1 ms budget never waits out a single git spawn. */
const SLOW_GIT_SECONDS = 1;
/** The child that runs a hook with a slow git (fixtures/run-hook-in-child.ts says why). */
const RUN_HOOK_IN_CHILD = join(import.meta.dir, "fixtures", "run-hook-in-child.ts");

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** SessionStart with a never-settling handler, git slowed so the budget wins before prepare resolves. */
const runCutSessionStart = async (stdin: string, env: Env): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-foreign-slow-git-"));
  paths.push(dir);
  const realGit = Bun.which("git");
  if (realGit === null) {
    throw new Error("git is not on PATH");
  }
  await writeFile(join(dir, "git"), `#!/bin/sh\nsleep ${String(SLOW_GIT_SECONDS)}\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const child = Bun.spawn({
    cmd: [process.execPath, RUN_HOOK_IN_CHILD, "session-start", stdin, JSON.stringify(env)],
    env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) {
    throw new Error(`the hook child failed: ${await new Response(child.stderr).text()}`);
  }
  return out;
};

/** A developer logged in to OWN_HUB, and a repo whose committed config names `repoHub`. */
const setup = async (label: string, repoHub: string): Promise<{ readonly home: string; readonly env: Env; readonly stdin: string }> => {
  const repo = await makeRepo(label, { remote: "git@github.com:evil/bait.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  await saveConfig(home, { version: 1, hubUrl: OWN_HUB, apiKey: "stored-key", keyOrigin: OWN_HUB });
  await writeFile(join(repo, ".crosscheck.json"), `${JSON.stringify({ hubUrl: repoHub })}\n`, "utf8");
  return {
    home,
    env: { CROSSCHECK_HOME: home, CROSSCHECK_TIMEOUT_MS: "1" },
    stdin: JSON.stringify({ session_id: `${label}-uuid`, cwd: repo, hook_event_name: "SessionStart", source: "startup" }),
  };
};

describe("a budget cut in a repo of another hub (review batch 2, M2)", () => {
  test("is charged to no repo of the machine, and the session still reads why nothing is reported", async () => {
    // Arrange
    const { home, env, stdin } = await setup("foreign-cut", FOREIGN_HUB);

    // Act
    const out = await runCutSessionStart(stdin, env);

    // Assert: nothing booked anywhere, and the foreign-hub line, not the slow-hub one.
    const ownKey = repoKey(OWN_HUB, OWN_REPO_ID);
    expect(await Bun.file(lossLedgerPath(home)).exists()).toBe(false);
    expect((await readTelemetryLossReport(home, ownKey)).total).toBe(0);
    expect((await readBriefingOmissions(home, ownKey, new Date())).total).toBe(0);
    expect(out).toContain("crosscheck is not reporting from here");
    expect(out).toContain(OWN_HUB);
    expect(out).not.toContain("no briefing this session");
  });

  test("control: the same cut in a repo of the developer's own hub is still charged and said", async () => {
    // Arrange
    const { home, env, stdin } = await setup("foreign-cut-own", OWN_HUB);

    // Act
    const out = await runCutSessionStart(stdin, env);

    // Assert
    const ownKey = repoKey(OWN_HUB, OWN_REPO_ID);
    expect((await readBriefingOmissions(home, ownKey, new Date())).byReason.budget).toBe(1);
    expect(out).toContain("no briefing this session");
  });
});
