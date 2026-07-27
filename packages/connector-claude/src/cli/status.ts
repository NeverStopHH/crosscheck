import { EXIT_OK, EXIT_UNREACHABLE } from "../constants.ts";
import { loadConfig } from "../config/config.ts";
import { repoKey } from "../config/paths.ts";
import type { Env } from "../config/paths.ts";
import { formatAge } from "../briefing/render.ts";
import { resolveRepoIdentity } from "../git/repo-identity.ts";
import { getPresence } from "../http/hub.ts";
import { readDropSummary, readUnrecordedDrop } from "../spool/drops.ts";
import { spoolDepth } from "../spool/files.ts";
import { readSyncState } from "../state/sync-state.ts";
import type { CliResult } from "./login.ts";

const ageOrNever = (iso: string | null, now: Date): string => {
  if (iso === null) {
    return "never";
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "never" : `${formatAge(now.getTime() - ms)} ago`;
};

export const runStatus = async (
  env: Env,
  cwd: string,
): Promise<CliResult> => {
  const identity = await resolveRepoIdentity(cwd);
  const config = await loadConfig({
    env,
    repoRoot: identity?.root,
  });
  if (config === null) {
    return {
      stdout: "not configured — run `crosscheck login <hubUrl>`\n",
      exitCode: EXIT_OK,
    };
  }
  if (identity === null) {
    return {
      stdout: `hub: ${config.hubUrl}\nrepo: not a git repository\n`,
      exitCode: EXIT_OK,
    };
  }

  const now = new Date();
  const key = repoKey(config.hubUrl, identity.repoId);
  const sync = await readSyncState(config.home, key);
  const depth = await spoolDepth(config.home, key);
  const drops = await readDropSummary(config.home, key);
  // A batch the ledger itself could not take is recorded as a marker, not a count,
  // so the summed total understates it. `doctor` says the same; both must agree.
  const unrecorded = await readUnrecordedDrop(config.home, key);
  const presence = await getPresence(
    {
      hubUrl: config.hubUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      home: config.home,
      repoKey: key,
      now: () => now,
    },
    identity.repoId,
  );

  const teammates = presence.ok
    ? presence.data
        .filter((entry) => entry.isSelf !== true)
        .map((entry) => `  - ${entry.developerName} · ${entry.branch} · ${entry.status}`)
    : ["  (hub unreachable)"];

  return {
    stdout: [
      `hub: ${config.hubUrl}`,
      `repo: ${identity.repoId} (${identity.branch})`,
      `developer: ${config.developerName ?? "unknown"} (${config.developerId ?? "unknown"})`,
      "teammates:",
      ...(teammates.length === 0 ? ["  (none)"] : teammates),
      `spool: ${depth} pending, ${drops.records} dropped${unrecorded === null ? "" : " (lower bound — at least one batch its ledger could not take)"}`,
      `last sync: ${ageOrNever(sync.lastOkAt, now)}`,
      "",
    ].join("\n"),
    exitCode: presence.ok ? EXIT_OK : EXIT_UNREACHABLE,
  };
};
