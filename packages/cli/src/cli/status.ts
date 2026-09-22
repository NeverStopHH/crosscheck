import {
  EXIT_OK,
  EXIT_UNREACHABLE,
  STATUS_MAX_ABSENCE_LINES,
  STATUS_SESSION_IDLE_HOURS,
  TRIPWIRE_MODE_ENV,
  TRIPWIRE_MODE_NOTICE,
} from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { resolveTripwireMode } from "@crosscheck/connector-core/config/tripwire.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { renderIntent } from "@crosscheck/connector-core/briefing/intent.ts";
import { formatQuestionCounts } from "@crosscheck/connector-core/briefing/questions.ts";
import { formatSolvedCounts } from "@crosscheck/connector-core/hints/precision.ts";
import { formatAbsenceLine, formatAge } from "@crosscheck/connector-core/briefing/render.ts";
import {
  HUB_UNREACHABLE_CLAUSE,
  coverageClause,
} from "@crosscheck/connector-core/coverage/render.ts";
import { UNKNOWN_COVERAGE } from "@crosscheck/connector-core/http/coverage.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import { CI_STATUS_MAX_LINES } from "@crosscheck/connector-core/constants.ts";
import { MAX_CI_TEST_ID_CHARS } from "@crosscheck/schema";
import { getCiVerdict } from "@crosscheck/connector-core/http/hub.ts";
import type {
  CiBehaviorDelta,
  CiCoverage,
} from "@crosscheck/connector-core/http/hub.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import {
  getAbsences,
  getHintStats,
  getPins,
  getPresence,
  getPrivacySettings,
  getQuestions,
  getSolvedMatchCounts,
  getTeamSettings,
} from "@crosscheck/connector-core/http/hub.ts";
import { resolveDenylist } from "@crosscheck/connector-core/capture/denylist.ts";
import { readCaptureHealth } from "@crosscheck/connector-core/state/capture-health.ts";
import type { CaptureHealth } from "@crosscheck/connector-core/state/capture-health.ts";
import type { HintStats, HubResult } from "@crosscheck/connector-core/http/hub.ts";
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
  formatGitLaneCost,
  summarizeGitLaneCost,
} from "@crosscheck/connector-core/state/git-lane-cost.ts";
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

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Capture visibility (trial findings #17/#18/#20): targets this repo's open
 * sessions actually spooled, the touches that resolved against no root of
 * this repo, and — when edits fired and NOTHING landed — that fact, pointing
 * at `doctor`, whose capture check prints the per-session diagnosis. Local
 * facts, printed whether or not the hub answers.
 *
 * OPEN, not live: a state file lives until SessionEnd deletes it, and the
 * trial found most sessions never end. The ones silent past
 * STATUS_SESSION_IDLE_HOURS are named as idle rather than counted as running.
 *
 * The outside-root count is the ONLY surface for a session that drops many
 * and still captures one: the doctor WARN needs ZERO targets, and the doctor
 * capture line states drop counts only in its "path did not resolve" branch.
 * Every optional clause prints nothing at zero, exactly like the
 * `foreign-repo drops:` line above — and the read cut appears only when it
 * actually bit, so a normal home's line is unchanged.
 */
const targetsLine = (health: CaptureHealth, now: Date): string => {
  const last =
    health.lastTargetAt === null ? "" : ` (last ${ageOrNever(health.lastTargetAt, now)})`;
  const outside =
    health.outsideDrops === 0
      ? ""
      : ` · outside-root drops ${String(health.outsideDrops)}`;
  const idle =
    health.idleSessions === 0
      ? ""
      : ` · ${String(health.idleSessions)} idle >${String(STATUS_SESSION_IDLE_HOURS)}h`;
  const cut =
    health.statesRead >= health.statesTotal
      ? ""
      : ` · read ${String(health.statesRead)} of ${String(health.statesTotal)} state files`;
  const unparsed =
    health.statesUnparsed === 0
      ? ""
      : ` · ${plural(health.statesUnparsed, "unreadable state file")}`;
  const dead =
    health.fires > 0 && health.targets === 0
      ? ` — ${plural(health.fires, "edit-tool fire")}, none captured: see \`crosscheck doctor\``
      : "";
  return `targets: ${String(health.targets)} captured by ${plural(health.sessions.length, "open session")}${last}${outside}${idle}${cut}${unparsed}${dead}`;
};

/**
 * Hint visibility (#19/#20/M1): delivered = the live sessions' seen-sets here;
 * the hub's delivered/pulled over its bounded window when it answers (an
 * older hub has no /api/hints/stats — "not measured", never a guess);
 * candidates = what the hub returned for this repo's prompts; and the repo's
 * claim count, which is the load-bearing one — the selector only ever
 * proposes claims, so a repo with none delivers nothing however good the
 * ranking is, and `delivered 0` alone reads like a tuning problem. It sits
 * OUTSIDE the window clause because the hub does not window it.
 */
const hintsLine = (health: CaptureHealth, stats: HubResult<HintStats>): string => {
  const hubPart = stats.ok
    ? `hub ${String(stats.data.windowDays)}d: ${String(stats.data.delivered)} delivered, ${String(stats.data.pulled)} pulled`
    : "pulled: not measured";
  // Printed only when the hub SAYS it: an older hub omits the field, and a
  // fabricated "0 claims" is exactly the false structural verdict the number
  // exists to prevent.
  const claims =
    stats.ok && stats.data.claims !== undefined
      ? ` · claims on this repo ${String(stats.data.claims)}`
      : "";
  return `hints: delivered ${String(health.hintsDelivered)} (${hubPart}), candidates ${String(health.hintCandidatesSeen)}${claims}`;
};

/** The Q2 knob, visible: which PreToolUse decision this machine's hooks emit. */
const tripwireLine = (env: Env): string => {
  const mode = resolveTripwireMode(env);
  return mode === TRIPWIRE_MODE_NOTICE
    ? `tripwire: ${mode} (${TRIPWIRE_MODE_ENV}=${mode} — additionalContext only, never asks)`
    : `tripwire: ${mode}`;
};


/**
 * WHAT CI SAID ABOUT THE COMMIT THIS CLONE IS ON (spec 05 §5).
 *
 * ONE LINE PER NON-GREEN TEST, and each carries its REASON rather than only
 * its verdict. "3 tests failing" is a number a reader can do nothing with:
 * whether to look at their own commit, at a flaky test, or at nothing yet is
 * the entire question, and the ladder already answered it.
 *
 * THE TEST NAME IS SOMEBODY ELSE'S TEXT. It comes out of a repository, and a
 * fork pull request can name a test anything at all — so it travels through
 * `bareUntrusted` like a teammate's branch name two blocks down, bounded and
 * control-stripped, before it reaches a terminal.
 *
 * SILENCE IS SAID, NOT SKIPPED. A repo whose CI never reports prints the
 * `unavailable` sentence rather than nothing: a missing line reads exactly
 * like a green suite, which is the absence AT-10 refuses.
 */
const CI_STATE_CLAUSES: Readonly<Record<string, string>> = {
  unavailable: "not reported here — no CI reporter is configured for this repo",
  unknown: "nothing has arrived for this commit yet",
  incomplete: "some expected lanes have not reported, or a verdict is pending",
  complete: "every expected lane reported",
};

/** Renderer-owned words. A reason a reader cannot act on is a reason wasted. */
const CI_REASON_CLAUSES: Readonly<Record<string, string>> = {
  insufficient_base:
    "this hub has not seen enough of that lane yet to tell a break from a flake",
  not_stably_green: "it was already failing before this commit",
  awaiting_rerun: "nobody has re-run it on this commit yet",
  rerun_green: "it passed on a re-run of this same commit — flaky, not this commit",
  rerun_red: "it failed again on a re-run of this same commit",
};

export const ciLines = (
  verdict: { coverage: CiCoverage; deltas: readonly CiBehaviorDelta[] } | null,
): readonly string[] => {
  if (verdict === null) {
    // THE HUB DID NOT ANSWER, which is not the same as CI having nothing to
    // say. Naming the difference keeps a round trip that failed from reading
    // as a suite that passed.
    return ["ci: not measured — the hub did not answer"];
  }
  const { coverage, deltas } = verdict;
  const head = `ci: ${CI_STATE_CLAUSES[coverage.state] ?? "state not reported"}`;
  const counted =
    coverage.state === "complete" || coverage.state === "incomplete"
      ? `${head} (${String(coverage.lanesReported)}/${String(coverage.lanesExpected)} lanes)`
      : head;
  if (deltas.length === 0) {
    return [counted];
  }
  const shown = deltas.slice(0, CI_STATUS_MAX_LINES);
  const hidden = deltas.length - shown.length;
  return [
    counted,
    ...shown.map((delta) => {
      const name = bareUntrusted(delta.testId, MAX_CI_TEST_ID_CHARS);
      const reason = CI_REASON_CLAUSES[delta.reason] ?? "reason not reported";
      return `  - ${name.length === 0 ? "(a test name with nothing printable in it)" : name} — ${delta.delta}: ${reason}`;
    }),
    // A SILENTLY SHORTER LIST IS THE ABSENCE THIS PROJECT REFUSES, and the
    // ones that fall off are the ones a reader would act on last — so the cut
    // is said rather than hidden behind a tidy list.
    ...(hidden > 0 ? [`  (+${String(hidden)} more not shown)`] : []),
  ];
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
  const intentCost = summarizeIntentCost(liveStates.states);
  // The ghost checks (VISION.md §3): the free deterministic notices first,
  // then the gated model half with the not-called count named, so a quiet
  // team never reads as a broken runner.
  const ghostCost = summarizeGhostCost(liveStates.states);
  // The regression guard's SECOND evidence lane (Stage 1). Printed beside the
  // other per-session counters and out of the same one scan: a lane whose
  // skips are never shown is a blind spot `suspect` answers out of.
  const gitLaneCost = summarizeGitLaneCost(liveStates.states);
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
  // Capture + hint health (#17/#18/#20): the counters PostToolUse and the
  // prompt hook book, summed over this repo's live sessions on this machine.
  const captureHealth = await readCaptureHealth(
    config.home,
    config.hubUrl,
    identity.repoId,
  );
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
  // WHAT CI SAID ABOUT THE COMMIT THIS CLONE IS ON. `identity.baseCommit` is
  // this checkout's HEAD — the commit a developer standing here would ask
  // about — and the default-branch answer travels from the same clone,
  // because the hub holds no repository and must not guess which ref is
  // default. FAIL-OPEN like every hub read here: a hub that cannot answer
  // costs this block its lines and never the command.
  const ciVerdict = await getCiVerdict(
    hubCtx,
    identity.repoId,
    identity.baseCommit,
    identity.branch ?? "main",
  );
  const ciStatusLines = ciLines(ciVerdict.ok ? ciVerdict.data : null);
  // The hub's delivered/pulled window and this repo's claim count (#20/M1) —
  // fail-open like every hub read: a hub that cannot answer costs the hub half
  // of the hints line, never the local half.
  const hintStats = await getHintStats(hubCtx, identity.repoId);
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
  const absenceLines = (absences.ok ? absences.data.absences : [])
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
      // AT-9, and it renders UNCONDITIONALLY — including "Coverage unknown"
      // from a hub that reports none. A person ran this command and is
      // reading every line below it; an omitted qualifier is the one thing
      // that would read as "all clear". It sits above every fact about the
      // team for the same reason the briefing's does: it says how far the
      // rest can be trusted. `coverageClause`, not `coverageNote`, because
      // the soft annotation rule governs answers nobody asked for.
      //
      // AND A REFUSED CONNECTION IS NOT AN OLD HUB. The failure kind is in
      // hand here (http/client.ts), the pins line below already uses it, and
      // doctor branches on it — collapsing it into the record would print a
      // sentence about what this hub reports beside "(hub unreachable)", and
      // name a cause the reader cannot act on.
      //
      // NO `coverage:` KEY. The clause is a SENTENCE that names its own
      // subject — "Coverage incomplete: …" — so a key in front of it made
      // this the only line in the command to say its subject twice and the
      // only one carrying two colons. The briefing prints the same sentence
      // unprefixed; one fact spelled one way on both surfaces.
      absences.ok
        ? coverageClause(absences.data.coverage, now)
        : absences.kind === "network"
          ? HUB_UNREACHABLE_CLAUSE
          : coverageClause(UNKNOWN_COVERAGE, now),
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
      ...ciStatusLines,
      targetsLine(captureHealth, now),
      hintsLine(captureHealth, hintStats),
      tripwireLine(env),
      `summarizer: ${formatSummarizerCost(summarizerCost)}`,
      `intent: ${formatIntentCost(intentCost)}`,
      `ghost checks: ${formatGhostCost(ghostCost)}`,
      `git evidence lane: ${formatGitLaneCost(gitLaneCost)}`,
      `conference: ${formatConferenceCost(conferenceCost, now)}`,
      // The CAPTURE stamp, not `lastOkAt`: only register/heartbeat/records/end
      // move it, so this age is the hook path's and not this command's (H5).
      `last capture sync: ${ageOrNever(sync.lastCaptureOkAt, now)}`,
      "",
    ].join("\n"),
    exitCode: presence.ok ? EXIT_OK : EXIT_UNREACHABLE,
  };
};
