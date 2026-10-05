/**
 * WHY AN AGENT SHARES NOTHING — the one place every such cause is named.
 *
 * A correctly installed connector can still put nothing in front of a
 * teammate, and before this module each reason lived — if anywhere — on a
 * different doctor line, most of them PASS lines, all of them gone the moment
 * the session ended. The pilot's case: a developer with five work contexts
 * over two days, no shared claim and no derived intent, whose machine nobody
 * else could inspect. Every rule below is one condition under which the
 * pipeline (hook → detached worker → model → spool → hub → review_draft)
 * yields nothing, read off counters the workers already book:
 *
 *   disabled / child_marker  an off switch in the environment;
 *   no_backend               nothing on this PATH can run a model;
 *   cannot_start             the HOOKS could not start it (their PATH, not ours);
 *   runner_failing           every run that reported back failed;
 *   workers_silent           runs were started and none reported back;
 *   no_transcript            the host had no transcript to summarize;
 *   answers_refused          the model spoke and nothing it said was kept;
 *   gate_quiet               no turn ever read as a conclusion — nothing broken;
 *   intent_quiet             no session opened with a substantive prompt;
 *   drafts_unreviewed        drafts exist and nobody has confirmed one.
 *
 * Every detail reads "your agent shares nothing because …; fix: …" — the
 * reader is a developer whose teammates see nothing from them, and the line
 * has to be pasteable as the whole answer. The counters come from live
 * sessions AND from the ended ones state/derive-history.ts kept, so a doctor
 * run after the session closed can still say why.
 */
import {
  DEFAULT_BACKEND_BINARY,
  BACKEND_OVERRIDE_VAR,
  resolveDeriveBackend,
} from "../model/backend.ts";
import { SPAWN_FAILURE_LABEL } from "../model/runner.ts";
import { amountOf } from "../briefing/draft-backlog.ts";
import type { DraftCount } from "../briefing/draft-backlog.ts";
import { isDisabled, isSummarizerChild } from "../config/config.ts";
import type { Env } from "../config/paths.ts";
import {
  DOCTOR_SHARING_QUIET_INTENT_SESSIONS_WARN,
  DOCTOR_SHARING_QUIET_TURNS_WARN,
  DOCTOR_SHARING_SILENT_FIRES_WARN,
  DOCTOR_SUMMARIZER_REJECTED_WARN,
  DRAFT_NUDGE_MIN_AGE_HOURS,
  DRAFT_RETENTION_HORIZON_DAYS,
  INTENT_MIN_PROMPT_CHARS,
  MS_PER_DAY,
  SUMMARIZER_CHILD_ENV,
} from "../constants.ts";
import type { SessionState } from "../state/session-state.ts";

/** The derive counters of ONE session — what the history keeps of it. */
export type DeriveDigest = Pick<
  SessionState,
  | "stopTurnCount"
  | "summarizerFireCount"
  | "summarizerNoneCount"
  | "summarizerDraftCount"
  | "summarizerFailCount"
  | "summarizerLastFailure"
  | "summarizerRejectCount"
  | "summarizerUnreadableCount"
  | "summarizerNoSliceCount"
  | "summarizerLastNoSlice"
  | "intentFireCount"
  | "intentNoneCount"
  | "intentSetCount"
  | "intentFailCount"
  | "intentLastFailure"
>;

export const digestOf = (state: SessionState): DeriveDigest => ({
  stopTurnCount: state.stopTurnCount,
  summarizerFireCount: state.summarizerFireCount,
  summarizerNoneCount: state.summarizerNoneCount,
  summarizerDraftCount: state.summarizerDraftCount,
  summarizerFailCount: state.summarizerFailCount,
  summarizerLastFailure: state.summarizerLastFailure,
  summarizerRejectCount: state.summarizerRejectCount,
  summarizerUnreadableCount: state.summarizerUnreadableCount,
  summarizerNoSliceCount: state.summarizerNoSliceCount,
  summarizerLastNoSlice: state.summarizerLastNoSlice,
  intentFireCount: state.intentFireCount,
  intentNoneCount: state.intentNoneCount,
  intentSetCount: state.intentSetCount,
  intentFailCount: state.intentFailCount,
  intentLastFailure: state.intentLastFailure,
});

/**
 * The developer's own unreviewed drafts on this repo, counted over the WHOLE
 * backlog the hub reports (briefing/draft-backlog.ts) — exact from a hub that
 * counts it, floors from an older one whose listing stopped at its cap.
 */
export interface OwnDraftsFact {
  readonly size: DraftCount;
  /** Of those, the ones that waited DRAFT_NUDGE_MIN_AGE_HOURS. */
  readonly due: DraftCount;
  /** Of those, the ones past DRAFT_RETENTION_HORIZON_DAYS — said, and kept. */
  readonly pastHorizon: DraftCount;
  /** The oldest draft's age, when known. */
  readonly oldestAgeMs: number | null;
}

export interface SharingInput {
  /** The environment doctor runs with — its off switches and its PATH. */
  readonly env: Env;
  /** Digests of the live sessions of this repo + hub, newest first. */
  readonly live: readonly DeriveDigest[];
  /** Digests of ended sessions the history kept, newest first. */
  readonly ended: readonly DeriveDigest[];
  /** Null when the hub did not answer — no claim about drafts is made then. */
  readonly drafts: OwnDraftsFact | null;
}

export type SharingCause =
  | "disabled"
  | "child_marker"
  | "no_backend"
  | "cannot_start"
  | "runner_failing"
  | "workers_silent"
  | "no_transcript"
  | "answers_refused"
  | "gate_quiet"
  | "intent_quiet"
  | "drafts_unreviewed";

export interface SharingFinding {
  readonly cause: SharingCause;
  /** The doctor WARN: "your agent shares nothing because …; fix: …". */
  readonly detail: string;
  /** The `crosscheck status` one-liner. */
  readonly short: string;
}

interface Totals {
  readonly sessions: number;
  readonly turns: number;
  readonly fires: number;
  readonly outcomes: number;
  readonly answered: number;
  readonly drafts: number;
  readonly fails: number;
  readonly lastFailure: string | null;
  readonly refused: number;
  readonly noSlice: number;
  readonly lastNoSlice: string | null;
  readonly intentFires: number;
  readonly intentsSet: number;
}

const sumOf = (digests: readonly DeriveDigest[], pick: (digest: DeriveDigest) => number): number =>
  digests.reduce((sum, digest) => sum + pick(digest), 0);

const firstOf = (values: readonly (string | null)[]): string | null =>
  values.find((value): value is string => value !== null) ?? null;

const totalsOf = (digests: readonly DeriveDigest[]): Totals => {
  const nones = sumOf(digests, (d) => d.summarizerNoneCount + d.intentNoneCount);
  const drafts = sumOf(digests, (d) => d.summarizerDraftCount);
  const intentsSet = sumOf(digests, (d) => d.intentSetCount);
  const fails = sumOf(digests, (d) => d.summarizerFailCount + d.intentFailCount);
  const refused = sumOf(digests, (d) => d.summarizerRejectCount + d.summarizerUnreadableCount);
  return {
    sessions: digests.length,
    turns: sumOf(digests, (d) => d.stopTurnCount),
    fires: sumOf(digests, (d) => d.summarizerFireCount + d.intentFireCount),
    outcomes: nones + drafts + intentsSet + fails + refused,
    answered: nones + drafts + intentsSet,
    drafts,
    fails,
    lastFailure: firstOf(digests.flatMap((d) => [d.summarizerLastFailure, d.intentLastFailure])),
    refused,
    noSlice: sumOf(digests, (d) => d.summarizerNoSliceCount),
    lastNoSlice: firstOf(digests.map((d) => d.summarizerLastNoSlice)),
    intentFires: sumOf(digests, (d) => d.intentFireCount),
    intentsSet,
  };
};

const finding = (cause: SharingCause, detail: string, short: string): SharingFinding => ({
  cause,
  detail,
  short,
});

type Rule = (input: SharingInput, totals: Totals) => SharingFinding | null;

const disabledRule: Rule = (input) =>
  isDisabled(input.env)
    ? finding(
        "disabled",
        "your agent shares nothing because CROSSCHECK_DISABLED is set in this environment, and every crosscheck hook exits on it; " +
          "fix: unset it here and in the environment your editor starts with",
        "nothing — CROSSCHECK_DISABLED is set",
      )
    : null;

const childMarkerRule: Rule = (input) =>
  isSummarizerChild(input.env)
    ? finding(
        "child_marker",
        `your agent shares nothing because ${SUMMARIZER_CHILD_ENV} is set in this environment — the marker crosscheck puts on its own model worker, under which every hook stays silent; ` +
          "fix: unset it (it leaked out of a worker's environment into this shell or its profile)",
        `nothing — ${SUMMARIZER_CHILD_ENV} leaked into this environment`,
      )
    : null;

const noBackendRule: Rule = (input) =>
  resolveDeriveBackend(input.env).kind === "absent"
    ? finding(
        "no_backend",
        `your agent shares nothing derived because no model backend is reachable: ${DEFAULT_BACKEND_BINARY} is not on this PATH and ${BACKEND_OVERRIDE_VAR} is unset, ` +
          "so no draft and no intent can be written (capture, hints and the briefing are unaffected); " +
          `fix: install the Claude Code CLI and run \`${DEFAULT_BACKEND_BINARY}\` once to log in, or set ${BACKEND_OVERRIDE_VAR} to a wrapper (docs/FOREIGN-MODELS.md)`,
        `no drafts or intents — no model backend (${DEFAULT_BACKEND_BINARY} not on PATH)`,
      )
    : null;

const isSpawnFailure = (totals: Totals): boolean =>
  totals.lastFailure?.startsWith(SPAWN_FAILURE_LABEL) === true;

/**
 * Only where THIS shell resolves a backend: then the hooks' failure to start
 * one is the editor's environment, and saying so is the diagnosis. Where this
 * shell has none either, no_backend already is the whole story and its fix
 * is the one that applies.
 */
const cannotStartRule: Rule = (input, totals) =>
  isSpawnFailure(totals) && resolveDeriveBackend(input.env).kind !== "absent"
    ? finding(
        "cannot_start",
        `your agent shares nothing because the hooks could not start the model (${String(totals.fails)} failed; last: ${totals.lastFailure ?? "unknown"}) — ` +
          "the editor starts its hooks in an environment where that binary cannot be found, though this shell finds it; " +
          `fix: set ${BACKEND_OVERRIDE_VAR} to the absolute path \`command -v ${DEFAULT_BACKEND_BINARY}\` prints, in the environment your editor starts with, or start the editor from this shell`,
        `no drafts or intents — the hooks cannot start ${DEFAULT_BACKEND_BINARY} (their PATH)`,
      )
    : null;

const runnerFailingRule: Rule = (_input, totals) =>
  totals.fails > 0 && totals.answered === 0 && !isSpawnFailure(totals)
    ? finding(
        "runner_failing",
        `your agent shares nothing because every model run that reported back failed (${String(totals.fails)} failed; last: ${totals.lastFailure ?? "unknown"}); ` +
          `fix: run \`${DEFAULT_BACKEND_BINARY} -p hi\` as this user to see the same error — usually a login (\`${DEFAULT_BACKEND_BINARY}\` once) or an outdated CLI — the summarizer runner check probes it`,
        `no drafts or intents — every model run failed (last: ${totals.lastFailure ?? "unknown"})`,
      )
    : null;

const workersSilentRule: Rule = (_input, totals) =>
  totals.fires >= DOCTOR_SHARING_SILENT_FIRES_WARN && totals.outcomes === 0
    ? finding(
        "workers_silent",
        `your agent shares nothing because ${String(totals.fires)} model runs were started and not one reported back: the detached worker did not start, or died with the hook that spawned it; ` +
          "fix: run the summarizer runner check below — if it passes, the host is killing the hook's children, so send this doctor output to whoever runs your crosscheck",
        `no drafts or intents — ${String(totals.fires)} model runs never reported back`,
      )
    : null;

const noTranscriptRule: Rule = (_input, totals) =>
  totals.noSlice > 0 && totals.drafts === 0
    ? finding(
        "no_transcript",
        `your agent drafts nothing because ${String(totals.noSlice)} of its turns had no transcript to summarize (last: ${totals.lastNoSlice ?? "unknown"}); ` +
          "fix: if that says no transcript, turn conversation transcripts on in Cursor (its hooks send transcript_path null while they are off); any other reason means the transcript format moved — send this line",
        `no drafts — ${String(totals.noSlice)} turns had no transcript`,
      )
    : null;

const answersRefusedRule: Rule = (_input, totals) =>
  totals.refused >= DOCTOR_SUMMARIZER_REJECTED_WARN && totals.drafts === 0
    ? finding(
        "answers_refused",
        `your agent drafts nothing because the model answered ${String(totals.refused)} times and nothing it said was kept (refused by a gate, or unreadable); ` +
          `fix: the summarizer cost line names the gate — if ${BACKEND_OVERRIDE_VAR} points at another model, see docs/FOREIGN-MODELS.md`,
        `no drafts — ${String(totals.refused)} model answers were refused or unreadable`,
      )
    : null;

const gateQuietRule: Rule = (_input, totals) =>
  totals.turns >= DOCTOR_SHARING_QUIET_TURNS_WARN && totals.fires - totals.intentFires === 0 && totals.noSlice === 0
    ? finding(
        "gate_quiet",
        `your agent drafts nothing because none of its ${String(totals.turns)} finished turns read as a conclusion to the Tier-1 gate (a test or an error beside hypothesis language, or a stated verdict beside work it did), so the summarizer never ran; ` +
          "fix: nothing is broken — have the agent publish_claim what it concluded, or ask it to state its conclusion in words",
        `no drafts — none of ${String(totals.turns)} turns read as a conclusion`,
      )
    : null;

const intentQuietRule: Rule = (_input, totals) =>
  totals.sessions >= DOCTOR_SHARING_QUIET_INTENT_SESSIONS_WARN && totals.intentFires === 0
    ? finding(
        "intent_quiet",
        `your agent derives no intent because none of its ${String(totals.sessions)} sessions opened with a substantive prompt (${String(INTENT_MIN_PROMPT_CHARS)}+ characters, not a slash command or a bare yes); ` +
          "fix: nothing is broken — the agent can state its plan with set_intent",
        `no intents — no session opened with a substantive prompt`,
      )
    : null;

const oldestClause = (ageMs: number | null): string =>
  ageMs === null ? "" : `, the oldest captured ${String(Math.floor(ageMs / MS_PER_DAY))} days ago`;

const draftsUnreviewedRule: Rule = (input) => {
  const drafts = input.drafts;
  if (drafts === null || drafts.due.count === 0) {
    return null;
  }
  const old =
    drafts.pastHorizon.count === 0
      ? ""
      : ` and ${amountOf(drafts.pastHorizon)} past ${String(DRAFT_RETENTION_HORIZON_DAYS)} days (kept: crosscheck never deletes a draft)`;
  return finding(
    "drafts_unreviewed",
    `teammates see none of your agent's findings because ${amountOf(drafts.size)} of your own drafts on this repo await review${oldestClause(drafts.oldestAgeMs)}, ` +
      `${amountOf(drafts.due)} of them for over ${String(DRAFT_NUDGE_MIN_AGE_HOURS)}h${old} — a draft is shown to nobody until it is confirmed; ` +
      "fix: ask your agent to settle them with review_draft (it is asked once per session, and must ask you before anything is published)",
    `${amountOf(drafts.size)} own drafts await review — teammates see none of them (review_draft)`,
  );
};

/** Order is the reading order: what stops everything, then what stops a part. */
const RULES: readonly Rule[] = [
  disabledRule,
  childMarkerRule,
  noBackendRule,
  cannotStartRule,
  runnerFailingRule,
  workersSilentRule,
  noTranscriptRule,
  answersRefusedRule,
  gateQuietRule,
  intentQuietRule,
  draftsUnreviewedRule,
];

export const sharingFindings = (input: SharingInput): readonly SharingFinding[] => {
  const totals = totalsOf([...input.live, ...input.ended]);
  return RULES.flatMap((rule) => {
    const found = rule(input, totals);
    return found === null ? [] : [found];
  });
};

/** The PASS line: what was read, so "nothing found" is a measurement. */
export const sharingSummary = (input: SharingInput): string => {
  const totals = totalsOf([...input.live, ...input.ended]);
  if (totals.sessions === 0) {
    return "no session on this repo has been recorded on this machine yet — open one, then run doctor again";
  }
  const unreviewed =
    input.drafts === null ? "" : `, ${amountOf(input.drafts.size)} own drafts unreviewed`;
  return (
    `${String(input.live.length)} live and ${String(input.ended.length)} recently ended session${totals.sessions === 1 ? "" : "s"}: ` +
    `${String(totals.drafts)} drafts and ${String(totals.intentsSet)} intents derived${unreviewed} — nothing found that keeps this agent from sharing`
  );
};
