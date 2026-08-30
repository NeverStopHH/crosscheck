import { EXIT_OK, EXIT_UNREACHABLE, STATUS_MAX_ABSENCE_LINES } from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { renderIntent } from "@crosscheck/connector-core/briefing/intent.ts";
import { formatQuestionCounts } from "@crosscheck/connector-core/briefing/questions.ts";
import { formatSolvedCounts } from "@crosscheck/connector-core/hints/precision.ts";
import { formatAbsenceLine, formatAge } from "@crosscheck/connector-core/briefing/render.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import {
  getAbsences,
  getPins,
  getPresence,
  getPrivacySettings,
  getQuestions,
  getSolvedMatchCounts,
  getTeamSettings,
} from "@crosscheck/connector-core/http/hub.ts";
import { resolveDenylist } from "@crosscheck/connector-core/capture/denylist.ts";
import { pinStatusLines } from "./pin-observability.ts";
import { presenceStateLine } from "./privacy.ts";
import { readDropSummary, readUnrecordedDrop } from "@crosscheck/connector-core/spool/drops.ts";
import {
  formatForeignDropLine,
  readForeignRepoDrops,
} from "@crosscheck/connector-core/state/foreign-drops.ts";
import { spoolDepth } from "@crosscheck/connector-core/spool/files.ts";
import { readSyncState } from "@crosscheck/connector-core/state/sync-state.ts";
import { readLiveSessionStates } from "@crosscheck/connector-core/state/session-state.ts";
import {
  formatConferenceCost,
  readConferenceCost,
} from "@crosscheck/connector-core/state/conference-cost.ts";
import {
  formatGhostCost,
  formatIntentCost,
  formatSummarizerCost,
  summarizeGhostCost,
  summarizeIntentCost,
  summarizeSummarizerCost,
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
  // Cost visibility (DESIGN.md §10 risk 7): local facts, printed whether or
  // not the hub answers. THREE model-cost lines out of ONE scan of the
  // session-state directory — the summarizer's estimate, the derived-intent
  // fires and the ghost checks — because this is a surface a human runs by
  // hand and three passes over the same files is a cost nobody asked for.
  const liveStates = await readLiveSessionStates(
    config.home,
    config.hubUrl,
    identity.repoId,
  );
  const summarizerCost = summarizeSummarizerCost(liveStates);
  // The derived-intent fires and what came of them (trial finding #16):
  // one Haiku call per session state, the outcome split so a fire that
  // landed nothing is never an invisible number.
  const intentCost = summarizeIntentCost(liveStates);
  // The ghost checks (VISION.md §3): the free deterministic notices first,
  // then the gated model half with the not-called count named, so a quiet
  // team never reads as a broken runner.
  const ghostCost = summarizeGhostCost(liveStates);
  // The conference counters (VISION.md §2). A LOCAL file rather than session
  // state: a conference is a command, often run from a scheduler at 03:00,
  // and its numbers must survive on a machine with no live session at all.
  const conferenceCost = await readConferenceCost(config.home, key);
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
  // The question channel's backlog (roadmap R2), both directions. A hub too
  // old to serve it, or an unreachable one, simply prints no line — the same
  // fail-open every other hub-fed line here has.
  const questions = await getQuestions(hubCtx, identity.repoId);
  const questionLines = questions.ok
    ? [`questions: ${formatQuestionCounts(questions.data.counts, now)}`]
    : [];
  // The solved-pointer precision loop (VISION.md §1): what this repo's
  // "solved before" lines actually earned. A hub too old to answer, or an
  // unreachable one, simply prints no line — the same fail-open every other
  // hub-fed line here has. The noun is what the rows ARE — every delivered
  // pointer at a tree that is solved today, including an ordinary teammate
  // pointer — and not this feature's name, which would be a superset
  // labelled as one surface (hints/precision.ts says why).
  const solvedCounts = await getSolvedMatchCounts(hubCtx, identity.repoId);
  const solvedLines = solvedCounts.ok
    ? [`solved-tree pointers: ${formatSolvedCounts(solvedCounts.data)}`]
    : [];
  // The regression guard's coverage (Stage 1). THE DENOMINATOR IS THE LINE:
  // a pin count without "nothing else is watched" beside it reads as
  // protection of a repo nobody pinned. An unreachable hub prints UNKNOWN
  // rather than nothing, because a missing line is the one reading this
  // feature may never produce — silence that looks like safety.
  const pins = await getPins(hubCtx, identity.repoId);
  const teamSettings = await getTeamSettings(hubCtx, identity.repoId);
  const pinLines = pins.ok
    ? pinStatusLines(
        pins.data,
        // The EFFECTIVE list, defaults included — the shadowing question is
        // about what actually suppresses capture, not about what this
        // developer added to it.
        resolveDenylist(config.denylist ?? undefined),
        teamSettings.ok ? teamSettings.data : null,
        now,
      )
    : [
        "pins: coverage UNKNOWN — the hub did not answer, so nothing here says what is watched",
      ];
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

  // Teammate lines through the render layer: name, branch and status are
  // hub-served, teammate-written short fields printed BARE on a ·-separated
  // line, so they take the BARE class (bareUntrusted — no minting a second
  // field; the MCP claim lines' rule), and the session's intent — WHAT they
  // are doing, trial finding #16 — is the one framed fragment every surface
  // spells (briefing/intent.ts).
  const teammates = presence.ok
    ? presence.data
        .filter((entry) => entry.isSelf !== true)
        .map((entry) => {
          const facts = [
            `  - ${bareUntrusted(entry.developerName)}`,
            bareUntrusted(entry.branch),
            bareUntrusted(entry.status),
          ];
          const intent = renderIntent(entry.intent);
          return [...facts, ...(intent === null ? [] : [intent])].join(" · ");
        })
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
      ...questionLines,
      ...solvedLines,
      ...pinLines,
      `summarizer: ${formatSummarizerCost(summarizerCost)}`,
      `intent: ${formatIntentCost(intentCost)}`,
      `ghost checks: ${formatGhostCost(ghostCost)}`,
      `conference: ${formatConferenceCost(conferenceCost, now)}`,
      `last sync: ${ageOrNever(sync.lastOkAt, now)}`,
      "",
    ].join("\n"),
    exitCode: presence.ok ? EXIT_OK : EXIT_UNREACHABLE,
  };
};
