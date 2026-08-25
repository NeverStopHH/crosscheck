/**
 * The ONE spelling of a question addressed to the reader (roadmap R2) — the
 * briefing's "Questions for you" block and, through the same fragment,
 * `list_open_questions`.
 *
 * WHY THIS BLOCK SHOWS A BODY when every other proactive block shows a
 * pointer. A question is not a finding: it asserts no cause, carries no
 * evidence, is never citable, and cannot anchor a theory — it is the same
 * title class the session intent sits in (DESIGN.md §4). And a pointer that
 * said only "Ken asked you something" would be UNANSWERABLE, which is the
 * exact failure every prior-art system warns about: an unanswered thread
 * nobody can act on is worse than no channel at all.
 *
 * It is still untrusted PROSE, from a teammate, landing unasked in a healthy
 * session — so it is sanitized and framed like every other body, and every
 * line carries at most one « » pair.
 *
 * NO DELIVERY RECORD, deliberately, and this is the one place the seen-set
 * rule does NOT apply. A hint is news and must not repeat; a question
 * addressed to you is a TODO and must repeat until you answer it or it
 * expires. `hint_deliveries` would turn "Ken is still waiting" into "Ken
 * asked once, three days ago, and you will never hear about it again".
 *
 * A render-layer module, registered in RENDER_LAYER_MODULES beside
 * intent.ts and render.ts.
 */
import { MAX_QUESTION_BODY_LENGTH } from "@crosscheck/schema";

import { DOCTOR_QUESTION_OPEN_WARN_DAYS, MS_PER_DAY } from "../constants.ts";
import type { InboxQuestion, QuestionCounts } from "../http/hub.ts";
import { bareUntrusted, safeId, sanitizeUntrusted } from "./sanitize.ts";

/** Bounded like a work-context title everywhere else on a briefing line. */
const MAX_QUESTION_CONTEXT_TITLE_CHARS = 80;

const UNKNOWN_ASKER = "a teammate";

const ageMsFrom = (iso: string, now: Date): number | null => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : now.getTime() - ms;
};

/**
 * How long the reader still has, in whole days, floored at "today". Days
 * rather than the shared `formatAge`: a TTL is read forwards ("I have until
 * Friday"), and "expires in 3h" on a 14-day window would only ever be true
 * for the last afternoon of one.
 */
export const formatExpiry = (expiresAt: string, now: Date): string | null => {
  const ageMs = ageMsFrom(expiresAt, now);
  if (ageMs === null) {
    return null;
  }
  const days = Math.floor(-ageMs / MS_PER_DAY);
  return days <= 0 ? "expires today" : `expires in ${String(days)}d`;
};

/**
 * One question, as the two lines a briefing shows: who asked and what it is
 * about on the first, the question itself and the exact call that answers it
 * on the second. Returned as ONE entry string so a budget that drops it drops
 * both halves — a question without its id cannot be answered.
 *
 * Null = a row this renderer will not vouch for (a body that sanitizes to
 * nothing, an id outside the allowlist, an unparseable timestamp): the same
 * rule every other line formatter in this package applies.
 */
export const formatQuestionEntry = (
  question: InboxQuestion,
  now: Date,
): string | null => {
  const id = safeId(question.id);
  const body = sanitizeUntrusted(question.body, MAX_QUESTION_BODY_LENGTH);
  const askedAgeMs = ageMsFrom(question.createdAt, now);
  const expiry = formatExpiry(question.expiresAt, now);
  if (
    id.length === 0 ||
    body.length === 0 ||
    askedAgeMs === null ||
    expiry === null
  ) {
    return null;
  }
  const asker = bareUntrusted(question.authorDeveloperName);
  const days = Math.floor(Math.max(0, askedAgeMs) / MS_PER_DAY);
  const asked = days === 0 ? "asked today" : `asked ${String(days)}d ago`;
  const facts = [
    `- ${asker.length === 0 ? UNKNOWN_ASKER : asker}`,
    asked,
    expiry,
  ];
  // The work-context title is the SECOND framed value, so it takes the first
  // line and the question body takes the second: one « » pair per line, the
  // framed-surface invariant this package holds everywhere.
  const contextId =
    question.workContextId === null || question.workContextId === undefined
      ? ""
      : safeId(question.workContextId);
  const title =
    question.workContextTitle === null ||
    question.workContextTitle === undefined
      ? ""
      : sanitizeUntrusted(
          question.workContextTitle,
          MAX_QUESTION_CONTEXT_TITLE_CHARS,
        );
  const about =
    contextId.length === 0 || title.length === 0
      ? ""
      : ` · about work context ${contextId}: «${title}»`;
  return `${facts.join(" · ")}${about}\n  asks: «${body}» · answer_question ${id}`;
};

/**
 * The counters, in ONE sentence both `crosscheck status` and `doctor` print
 * (roadmap R2 observability). Two surfaces stating the same facts in two
 * spellings is how they come to disagree, and the numbers are the whole
 * point: an asynchronous channel whose backlog is invisible is a channel
 * people stop trusting.
 *
 * No untrusted text reaches this function — every value is a number the hub
 * counted — so it is not a render surface, only the one place the words live.
 */
export const formatQuestionCounts = (
  counts: QuestionCounts,
  now: Date,
): string => {
  const oldestMs =
    counts.oldestToMeAt === null ? null : ageMsFrom(counts.oldestToMeAt, now);
  const oldest =
    oldestMs === null
      ? ""
      : ` (oldest ${String(Math.max(0, Math.floor(oldestMs / MS_PER_DAY)))}d)`;
  const toMe =
    counts.openToMe === 0
      ? "none open to you"
      : `${String(counts.openToMe)} open to you${oldest}`;
  const asked =
    counts.asked === 0
      ? "none asked"
      : `${String(counts.asked)} asked (${String(counts.askedAnswered)} answered)`;
  const expired =
    counts.askedExpired === 0
      ? []
      : [`${String(counts.askedExpired)} of yours expired unanswered`];
  return [toMe, asked, ...expired].join(" · ");
};

/**
 * The WARN path, so this counter is never PASS-only (the finding-#14 lesson).
 * TWO failures, and they are different people's problems: a question that has
 * been waiting on YOU past half its life, and a question YOU asked that
 * expired with no answer. Null = nothing to warn about.
 */
export const questionWarning = (
  counts: QuestionCounts,
  now: Date,
): string | null => {
  const oldestMs =
    counts.oldestToMeAt === null ? null : ageMsFrom(counts.oldestToMeAt, now);
  const oldestDays =
    oldestMs === null ? 0 : Math.floor(oldestMs / MS_PER_DAY);
  const stale =
    counts.openToMe > 0 && oldestDays >= DOCTOR_QUESTION_OPEN_WARN_DAYS
      ? [
          `a teammate has been waiting ${String(oldestDays)}d for an answer from you ` +
            "(list_open_questions shows what, answer_question replies)",
        ]
      : [];
  const expired =
    counts.askedExpired > 0
      ? [
          `${String(counts.askedExpired)} question${counts.askedExpired === 1 ? "" : "s"} ` +
            "you asked expired unanswered — nobody was told, and nothing retries",
        ]
      : [];
  const reasons = [...stale, ...expired];
  return reasons.length === 0 ? null : reasons.join("; ");
};
