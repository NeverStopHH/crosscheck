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

import {
  DOCTOR_QUESTION_OPEN_WARN_DAYS,
  MAX_BRIEFING_QUESTION_CHARS,
  MS_PER_DAY,
  QUESTION_EXPIRY_REPORT_DAYS,
} from "../constants.ts";
import type { InboxQuestion, QuestionCounts } from "../http/hub.ts";
import { fitEntries } from "./fit.ts";
import {
  bareUntrusted,
  safeId,
  sanitizeUntrusted,
  spanRedactedUntrusted,
} from "./sanitize.ts";

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
  // BODY class, not label class (audit row M14): a question IS its text, and
  // "you must", "override" and "disregard" are ordinary words in one. Blanking
  // the whole body left the target a marker they could not answer and the
  // asker a question that expired for no reason either of them could see.
  const body = spanRedactedUntrusted(question.body, MAX_QUESTION_BODY_LENGTH);
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
  //
  // THE TITLE LEADS AND THE ID FOLLOWS AS A CALL. "about work context wc_…:"
  // put a 22-character token the reader can do nothing with — it is never an
  // argument of answer_question — in the most readable position on the line,
  // announced by a jargon noun. Naming the call that reads it turns the same
  // id into the next action, which is the only thing that earns a bare id a
  // place on a briefing line at 23:00.
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
      : ` · about «${title}» (get_diagnosis ${contextId})`;
  return `${facts.join(" · ")}${about}\n  asks: «${body}» · answer_question ${id}`;
};

/**
 * As many whole entries as MAX_BRIEFING_QUESTION_CHARS holds, in order.
 *
 * DROPPED, NEVER TRUNCATED, and never fewer than one: a cut question cannot
 * be answered, which is the failure this block exists to prevent, while a
 * question left for `list_open_questions` can. The first entry is admitted
 * whatever it costs — a briefing that shows "somebody is waiting and I will
 * not tell you who" would be worse than a long line — and the section's
 * "+N more not shown" then carries the rest.
 *
 * The reducer itself lives in briefing/fit.ts: the ghost block needs the same
 * arithmetic for the same reason, and a second copy of it would be a second
 * place for "drop whole, keep the first" to be weakened. What stays here is
 * this block's own DEFAULT — the questions budget — so no caller has to
 * remember which constant belongs to which section.
 */
export const fitQuestionEntries = (
  entries: readonly string[],
  maxChars: number = MAX_BRIEFING_QUESTION_CHARS,
): readonly string[] => fitEntries(entries, maxChars);

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
  // The WINDOW is named, not implied: the hub reports an expired question for
  // one further TTL and then stops, and a bare "1 of yours expired" leaves the
  // reader to guess whether that means ever or lately.
  const expired =
    counts.askedExpired === 0
      ? []
      : [
          `${String(counts.askedExpired)} of yours expired unanswered in the last ` +
            `${String(QUESTION_EXPIRY_REPORT_DAYS)} days`,
        ];
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
  // THE PERSON, not "a teammate": this is the sentence somebody reads at 23:00
  // before shutting the laptop, and with four teammates the nameless version
  // has no next action cheaper than starting an agent session. BARE untrusted
  // like every other teammate name on a rendered line; a name that does not
  // survive the sanitizer falls back to the wording that names nobody, because
  // a warning with a mangled name is worse than a warning with none.
  const asker =
    counts.oldestToMeFrom === null || counts.oldestToMeFrom === undefined
      ? ""
      : bareUntrusted(counts.oldestToMeFrom);
  const who = asker.length === 0 ? "a teammate has" : `${asker} has`;
  const stale =
    counts.openToMe > 0 && oldestDays >= DOCTOR_QUESTION_OPEN_WARN_DAYS
      ? [
          `${who} been waiting ${String(oldestDays)}d for an answer — ` +
            "list_open_questions shows the question and its id, " +
            "answer_question <id> sends the reply",
        ]
      : [];
  // NO RESTATEMENT. `formatQuestionCounts` has already said how many expired,
  // and the composed line is `<counts> — <warning>`: repeating the count here
  // made one fact read as two problems. What this half adds is the only
  // recovery there is, which the old sentence never named.
  const expired =
    counts.askedExpired > 0
      ? [
          "nobody was told and nothing retries — ask again if you still need the answer",
        ]
      : [];
  const reasons = [...stale, ...expired];
  return reasons.length === 0 ? null : reasons.join("; ");
};
