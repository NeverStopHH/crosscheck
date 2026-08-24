import { EXIT_OK, EXIT_UNREACHABLE, STATUS_MAX_ABSENCE_LINES } from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { formatAbsenceLine, formatAge } from "@crosscheck/connector-core/briefing/render.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import {
  getAbsences,
  getHintStats,
  getPresence,
  getPrivacySettings,
} from "@crosscheck/connector-core/http/hub.ts";
import { presenceStateLine } from "./privacy.ts";
import { readDropSummary, readUnrecordedDrop } from "@crosscheck/connector-core/spool/drops.ts";
import {
  formatForeignDropLine,
  readForeignRepoDrops,
} from "@crosscheck/connector-core/state/foreign-drops.ts";
import { spoolDepth } from "@crosscheck/connector-core/spool/files.ts";
import { readSyncState } from "@crosscheck/connector-core/state/sync-state.ts";
import {
  formatSummarizerCost,
  readSummarizerCost,
} from "@crosscheck/connector-claude";
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
  // Cost visibility (DESIGN.md §10 risk 7): a local fact, printed whether or
  // not the hub answers; the figure is an estimate and the line says so.
  const summarizerCost = await readSummarizerCost(
    config.home,
    config.hubUrl,
    identity.repoId,
  );
  const drops = await readDropSummary(config.home, key);
  // A batch the ledger itself could not take is recorded as a marker, not a count,
  // so the summed total understates it. `doctor` says the same; both must agree.
  const unrecorded = await readUnrecordedDrop(config.home, key);
  // Foreign-repo drops (trial finding #9): a multi-repo workspace's second
  // connected repo goes silent under first-wins, and this line is where a
  // human finds out. Machine-wide (the dropping session is bound to the
  // OTHER repo), zero prints nothing, doctor says the same sentence.
  const foreignDrops = await readForeignRepoDrops(config.home);
  const foreignDropLines =
    foreignDrops.drops === 0
      ? []
      : [`foreign-repo drops: ${formatForeignDropLine(foreignDrops)}`];
  // repoKey "" so this command's own three reads do not stamp the sync record
  // it is about to print (trial finding H5): with the real key, `status` wrote
  // `lastOkAt` and then reported it, so the age it showed was always its own.
  // The capture stamp was never at risk — reads are not capture-marked
  // (http/hub.ts) — but `last capture sync` is read beside `lastSyncAt`, and a
  // surface that reports its own writes teaches nobody anything.
  const hubCtx = {
    hubUrl: config.hubUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    home: config.home,
    repoKey: "",
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
  // Whether hints are reaching anybody on this repo (trial finding M1).
  // `claims` is the load-bearing number: the selector only ever proposes
  // claims, so a repo with none delivers nothing however good the ranking is.
  // An older hub 404s the endpoint and this prints no line at all — the same
  // fail-open the absence and privacy sections above use.
  const hintStats = await getHintStats(hubCtx, identity.repoId);
  const hintLines = hintStats.ok
    ? [
        `hints: delivered ${String(hintStats.data.delivered)} (pulled ${String(hintStats.data.pulled)}) · claims on this repo ${String(hintStats.data.claims)}`,
      ]
    : [];
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
  // The caller's OWN linked emails (trial finding #7) — self data, so the
  // addresses print here while doctor sticks to counts. An older hub sends
  // no field (empty list): no line.
  const emailLines =
    privacy.ok && privacy.data.emails.length > 0
      ? [
          `emails: ${privacy.data.emails
            .map((entry) => (entry.isPrimary ? `${entry.email} (primary)` : entry.email))
            .join(", ")}`,
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
      ...emailLines,
      ...privacyLines,
      "teammates:",
      ...(teammates.length === 0 ? ["  (none)"] : teammates),
      ...(absenceLines.length === 0
        ? []
        : ["commit authors without a recent session:", ...absenceLines]),
      `spool: ${depth} pending, ${drops.records} dropped${unrecorded === null ? "" : " (lower bound — at least one batch its ledger could not take)"}`,
      ...foreignDropLines,
      ...hintLines,
      `summarizer: ${formatSummarizerCost(summarizerCost)}`,
      // The CAPTURE stamp, not `lastOkAt`: only register/heartbeat/records/end
      // move it, so this age is the hook path's and not this command's (H5).
      `last capture sync: ${ageOrNever(sync.lastCaptureOkAt, now)}`,
      "",
    ].join("\n"),
    exitCode: presence.ok ? EXIT_OK : EXIT_UNREACHABLE,
  };
};
