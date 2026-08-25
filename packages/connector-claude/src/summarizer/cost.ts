/**
 * Summarizer cost, made visible (DESIGN.md §10 risk 7): the Stop hook books
 * every fire and its rough token estimate into the session state, and this
 * module sums what the LIVE sessions of one repo+hub have spent so
 * `crosscheck status` and `doctor` can print it. Session state is deleted at
 * SessionEnd, so this is per-LIVE-session visibility by design — the point
 * is that a running summarizer is never spending invisibly, not accounting.
 *
 * Every figure derived from CHARS_PER_TOKEN_ESTIMATE is an ESTIMATE, and
 * every surface printing one says so. WHAT IT COUNTS: the slice and the
 * prompt the Stop hook hands over, at ~4 chars/token — NOT the nested
 * claude's own system prompt, which is the larger share of a real call.
 * Measured 2026-08-21 on Claude Code 2.1.237 with the lean argv and the
 * doctor probe slice: the estimate says ~234 tokens; the CLI's usage
 * reports 6714 cached input + 187 output tokens (cost_usd 0.0028 on a
 * cache hit; the first, uncached call of the day creates that ~6.6k cache
 * at ~0.017). The line is a spend INDICATOR on the developer's quota —
 * "is this firing at all, and how often" — not a bill.
 */
import {
  DOCTOR_SUMMARIZER_MOSTLY_DEAD_MIN_FIRES,
  DOCTOR_SUMMARIZER_SILENT_FIRES_WARN,
  DOCTOR_ZOMBIE_STATE_WARN_HOURS,
  MINUTES_PER_HOUR,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
  STATUS_MAX_SESSION_STATES,
} from "@crosscheck/connector-core/constants.ts";
import { readJsonOrNull } from "@crosscheck/connector-core/config/paths.ts";
import {
  listSessionStateFiles,
  sessionSilentForMs,
} from "@crosscheck/connector-core/state/session-scan.ts";
import { SessionStateSchema } from "@crosscheck/connector-core/state/session-state.ts";

const MS_PER_HOUR = MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
/**
 * A state file whose session has not said anything for this long is not a
 * live session (state/session-scan.ts says why the age is measured from the
 * heartbeat or the start). ONE HOUR, the same threshold `doctor`'s zombie
 * count uses, and the number that made the trial's histogram readable: of 100
 * state files, 25 were under an hour old and 75 were not, while the cost line
 * called all fifty it happened to read "live sessions".
 */
const STALE_STATE_MS = DOCTOR_ZOMBIE_STATE_WARN_HOURS * MS_PER_HOUR;

export interface SummarizerCost {
  /** Live sessions of this repo+hub that were counted. */
  readonly sessions: number;
  /** Session-state files that EXIST — the denominator of "N of M". */
  readonly filesSeen: number;
  /** Files this bounded scan actually opened. */
  readonly filesRead: number;
  /** Files skipped because their session stopped heartbeating. */
  readonly staleSkipped: number;
  /** Files that would not parse — counted, never silently dropped. */
  readonly parseFailures: number;
  /**
   * Runs the model answered with neither a claim nor NONE (gate.ts
   * `withSummarizerUnparsed`). A PROMPT defect, which is why it is not folded
   * into `fails` — that one is the runner's.
   */
  readonly unparsedAnswers: number;
  /**
   * Intent captures booked this session. Written by `feat/session-intent`,
   * default 0 here, and printed only when > 0 — so that branch needs no edit
   * on this side.
   */
  readonly intentFires: number;
  readonly fires: number;
  /** Fires the model answered NONE — the gate's noise, counted honestly. */
  readonly nones: number;
  /** Fires that produced a spooled draft — the gate's signal. */
  readonly drafts: number;
  /**
   * Fires the RUNNER lost — binary missing, non-zero exit, deadline (trial
   * finding #14) — and one booked reason, already sanitized and bounded by
   * the writer (gate.ts withSummarizerFailure). Which live session's
   * failure is shown is scan order's choice; they all say the same thing
   * when the runner is broken, which is the case this exists for.
   */
  readonly fails: number;
  readonly lastFailure: string | null;
  /** Rough figure at ~4 chars/token — an estimate, never a bill. */
  readonly estimatedTokens: number;
}

const NO_COST: SummarizerCost = {
  sessions: 0,
  filesSeen: 0,
  filesRead: 0,
  staleSkipped: 0,
  parseFailures: 0,
  unparsedAnswers: 0,
  intentFires: 0,
  fires: 0,
  nones: 0,
  drafts: 0,
  fails: 0,
  lastFailure: null,
  estimatedTokens: 0,
};

/**
 * Bounded scan of the session-state directory — NEWEST FIRST, and the bound
 * is now visible in the output.
 *
 * It used to be `readdir` → `.filter(.json)` → `.slice(0, 50)`, in bun's OS
 * order, which is neither alphabetical nor chronological. On the trial machine
 * that read an arbitrary 50 of 100 files and printed
 * `13 runs (1 NONE, 2 drafts) … across 50 live sessions` while the full set
 * said 27 runs, 3 NONEs and 3 drafts — and the line said "50 live sessions"
 * rather than "50 of 100", so nothing in it suggested a subset had been read.
 * `isSummarizerSilentlyDead` then judged the same arbitrary subset, which is
 * how a WARN could fire or stay silent depending on where the scan landed.
 *
 * Three changes, in order: sort by mtime before the bound (state/session-scan.ts),
 * skip files whose session stopped heartbeating instead of calling them live,
 * and carry `filesSeen`/`filesRead`/`staleSkipped` so the line can say what it
 * looked at.
 */
export const readSummarizerCost = async (
  home: string,
  hubUrl: string,
  repoId: string,
  now: Date = new Date(),
): Promise<SummarizerCost> => {
  const listing = await listSessionStateFiles(home, STATUS_MAX_SESSION_STATES);
  if (listing.filesSeen === 0) {
    return NO_COST;
  }
  const parsed = await Promise.all(
    listing.files.map(async (file) => ({
      // The mtime travels with the parse: a session's silence is measured off
      // its own file's last write as well as its heartbeat (session-scan.ts).
      mtimeMs: file.mtimeMs,
      result: SessionStateSchema.safeParse(await readJsonOrNull(file.path)),
    })),
  );
  const base: SummarizerCost = {
    ...NO_COST,
    filesSeen: listing.filesSeen,
    filesRead: listing.files.length,
    parseFailures: parsed.filter((entry) => !entry.result.success).length,
  };
  return parsed
    .flatMap((entry) =>
      entry.result.success
        ? [{ mtimeMs: entry.mtimeMs, state: entry.result.data }]
        : [],
    )
    .filter(({ state }) => state.hubUrl === hubUrl && state.repoId === repoId)
    .reduce<SummarizerCost>((total, { mtimeMs, state }) => {
      const ageMs = sessionSilentForMs(state, mtimeMs, now.getTime());
      if (ageMs !== null && ageMs > STALE_STATE_MS) {
        // Counted, not dropped: "3 stale skipped" is the number that would
        // have told the trial its cost line was reading corpses.
        return { ...total, staleSkipped: total.staleSkipped + 1 };
      }
      return {
        ...total,
        sessions: total.sessions + 1,
        fires: total.fires + state.summarizerFireCount,
        nones: total.nones + state.summarizerNoneCount,
        drafts: total.drafts + state.summarizerDraftCount,
        fails: total.fails + state.summarizerFailCount,
        unparsedAnswers:
          total.unparsedAnswers + state.summarizerUnparsedCount,
        intentFires: total.intentFires + state.intentFireCount,
        lastFailure: state.summarizerLastFailure ?? total.lastFailure,
        estimatedTokens:
          total.estimatedTokens + state.summarizerEstimatedTokens,
      };
    }, base);
};

/**
 * The one spelling of the cost fact both CLI surfaces print. The outcome
 * split (trial finding #12's measuring stick) rides in the middle: NONE is
 * the gate's noise, drafts its signal, failures the runner's own losses
 * with the last booked reason (trial finding #14), and any gap left to the
 * run count is a drop or unparseable output — figures the trial reads side
 * by side.
 */
const scanPart = (cost: SummarizerCost): string => {
  const stale =
    cost.staleSkipped === 0
      ? ""
      : ` (${String(cost.staleSkipped)} stale skipped)`;
  const unreadable =
    cost.parseFailures === 0
      ? ""
      : ` (${String(cost.parseFailures)} unreadable)`;
  return `${String(cost.filesRead)} of ${String(cost.filesSeen)} session state file${cost.filesSeen === 1 ? "" : "s"}${stale}${unreadable}`;
};

export const formatSummarizerCost = (cost: SummarizerCost): string => {
  if (cost.filesSeen === 0) {
    return "no live sessions";
  }
  if (cost.sessions === 0) {
    // Files exist but none of them belongs to a LIVE session of this repo —
    // which used to read "no live sessions" whether the directory was empty
    // or held a hundred corpses. The count is the difference.
    return `no live sessions — ${scanPart(cost)}`;
  }
  const draftsPart =
    cost.drafts === 1 ? "1 draft" : `${String(cost.drafts)} drafts`;
  const lastPart =
    cost.lastFailure === null ? "" : `: last "${cost.lastFailure}"`;
  const failsPart =
    cost.fails === 0 ? "" : `, ${String(cost.fails)} failed${lastPart}`;
  const unparsedPart =
    cost.unparsedAnswers === 0
      ? ""
      : `, ${String(cost.unparsedAnswers)} unparsed`;
  // Printed only when non-zero, so `feat/session-intent` can start writing
  // the counter without this line changing for anyone who is not.
  const intentPart =
    cost.intentFires === 0
      ? ""
      : `, ${String(cost.intentFires)} intent captures`;
  return (
    `${String(cost.fires)} runs (${String(cost.nones)} NONE, ${draftsPart}${failsPart}${unparsedPart}${intentPart}), ` +
    `~${String(cost.estimatedTokens)} tokens (estimate) across ${scanPart(cost)}`
  );
};

/**
 * The finding-#14 signature: fires enough to mean it, and not ONE answered
 * — no NONE, no draft. Below DOCTOR_SUMMARIZER_SILENT_FIRES_WARN a lost
 * run is noise; from it on, fail-open has become silently dead and doctor
 * must say so (DESIGN.md §4: "fail-open must never mean silently dead").
 */
export const isSummarizerSilentlyDead = (cost: SummarizerCost): boolean => {
  if (cost.fires < DOCTOR_SUMMARIZER_SILENT_FIRES_WARN) {
    return false;
  }
  if (cost.nones + cost.drafts === 0) {
    return true;
  }
  // The SECOND signature (trial finding M5). The original condition needs
  // every single answer to be missing, so a run where a handful answered and
  // the rest vanished read PASS — and "the rest" is the interesting half:
  // 21 of 27 fires on the trial machine were unexplained, booked as neither
  // NONE, draft, runner failure nor unparsed answer. When more than half the
  // fires end in that remainder, fail-open has become mostly-dead, which is
  // the state DESIGN.md §4 says must never be silent.
  //
  // Its own, higher floor (DOCTOR_SUMMARIZER_MOSTLY_DEAD_MIN_FIRES): a draft
  // dropped by the echo, secret or contract gates books nothing and is a
  // normal outcome, so at three fires two of them would be enough to fire
  // this on a healthy machine.
  if (cost.fires < DOCTOR_SUMMARIZER_MOSTLY_DEAD_MIN_FIRES) {
    return false;
  }
  const explained =
    cost.nones + cost.drafts + cost.fails + cost.unparsedAnswers;
  return cost.fires - explained > cost.fires / 2;
};
