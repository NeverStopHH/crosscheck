import { EXIT_OK, EXIT_UNREACHABLE, STATUS_MAX_ABSENCE_LINES } from "../constants.ts";
import { loadConfig } from "../config/config.ts";
import { repoKey } from "../config/paths.ts";
import type { Env } from "../config/paths.ts";
import { formatAbsenceLine, formatAge } from "../briefing/render.ts";
import { resolveRepoIdentity } from "../git/repo-identity.ts";
import { getAbsences, getPresence, getPrivacySettings } from "../http/hub.ts";
import { presenceStateLine } from "./privacy.ts";
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
  const hubCtx = {
    hubUrl: config.hubUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    home: config.home,
    repoKey: key,
    now: () => now,
  };
  const presence = await getPresence(hubCtx, identity.repoId);
  // Absence findings share the briefing's line formatter, so both surfaces
  // state the same facts the same way. A hub without the endpoint (or any
  // failure) simply prints no section — same fail-open as the briefing.
  const absences = await getAbsences(hubCtx, identity.repoId);
  // Own privacy state (DESIGN.md §2.1) — so "why can't anyone see me" and
  // "why do I never see Robin" are answered here instead of chasing ghosts.
  // An older hub without the endpoint prints no lines, same fail-open.
  const privacy = await getPrivacySettings(hubCtx);
  const privacyLines = privacy.ok
    ? [
        presenceStateLine(privacy.data.presenceOptOut),
        `muted: ${
          privacy.data.mutes.length === 0
            ? "(none)"
            : privacy.data.mutes.map((mute) => mute.name).join(", ")
        }`,
      ]
    : [];
  const absenceLines = (absences.ok ? absences.data : [])
    .slice(0, STATUS_MAX_ABSENCE_LINES)
    .flatMap((entry) => {
      const line = formatAbsenceLine(entry, now);
      return line === null ? [] : [`  ${line}`];
    });

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
      ...privacyLines,
      "teammates:",
      ...(teammates.length === 0 ? ["  (none)"] : teammates),
      ...(absenceLines.length === 0
        ? []
        : ["commit authors without a recent session:", ...absenceLines]),
      `spool: ${depth} pending, ${drops.records} dropped${unrecorded === null ? "" : " (lower bound — at least one batch its ledger could not take)"}`,
      `last sync: ${ageOrNever(sync.lastOkAt, now)}`,
      "",
    ].join("\n"),
    exitCode: presence.ok ? EXIT_OK : EXIT_UNREACHABLE,
  };
};
