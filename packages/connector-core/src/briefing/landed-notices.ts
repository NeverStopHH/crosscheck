/**
 * The ONE spelling of an author's notice (docs/1.0/landed-changes.md, step
 * 4): a teammate's edit stopped at the reader's own landed change. The
 * briefing's block and the prompt's notice (hints/render.ts) both print it
 * through here.
 *
 * TOLD ONCE, unlike a question: a notice is news, not a TODO, so what the
 * emitted text names is marked told (flows/briefing.ts, flows/hint.ts) — and
 * ONLY what it names: `commitIds` are the rows on the text, so a commit past
 * MAX_LANDED_NOTICE_COMMITS_SHOWN waits for the next briefing or prompt.
 *
 * Untrusted: the reader's name and the file are bare fields; the commit
 * subject is the author's own words, but it reaches the author through the
 * READER's connector, so it is quoted data, one « » pair per line.
 *
 * A render-layer module, registered in RENDER_LAYER_MODULES.
 */
import {
  LANDED_NOTICE_SUBJECT_CHARS,
  MAX_BRIEFING_LANDED_NOTICE_CHARS,
  MAX_LANDED_NOTICE_COMMITS_SHOWN,
} from "../constants.ts";
import type { LandedNotice } from "../http/hub.ts";
import { formatAge } from "./age.ts";
import { fitEntries } from "./fit.ts";
import { bareUntrusted, safeId, sanitizeUntrusted } from "./sanitize.ts";

export const LANDED_NOTICE_SECTION_HEADER = "Teammates ran into your landed changes (each notice is shown once):";

/** A path is a bare field on a line that already carries a name and an age. */
const PATH_CHARS = 120;
const SHORT_SHA_CHARS = 7;

type NoticeCommit = LandedNotice["commits"][number];

export interface RenderedLandedNotice {
  readonly text: string;
  /** The hub rows the text names: the only ones a delivery may mark told. */
  readonly commitIds: readonly string[];
}

/** How a commit line speaks of the reader: by name, or as "they" when the name is unknown. */
interface ReaderWords {
  readonly checkout: string;
  readonly has: string;
}

const readerWords = (name: string): ReaderWords =>
  name.length === 0
    ? { checkout: "their checkout", has: "they already have it" }
    : { checkout: `${name}'s checkout`, has: `${name} already has it` };

const commitLine = (commit: NoticeCommit, reader: ReaderWords): string | null => {
  const sha = safeId(commit.sha).slice(0, SHORT_SHA_CHARS);
  if (sha.length === 0) {
    return null;
  }
  const subject = sanitizeUntrusted(commit.subject, LANDED_NOTICE_SUBJECT_CHARS);
  const label = subject.length === 0 ? sha : `${sha} «${subject}»`;
  return commit.missing
    ? `  ${label}: missing from ${reader.checkout}`
    : `  ${label}: ${reader.has}; it landed recently`;
};

/**
 * "2h ago", or "at an unknown time" — a future instant counts as unknown, the
 * rule every hint line follows (hints/render.ts `ageLabel`): a clamped "0s
 * ago" would be a guess dressed as a measurement.
 */
const stoppedLabel = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) || ms > now.getTime() ? "at an unknown time" : `${formatAge(now.getTime() - ms)} ago`;
};

/**
 * One notice as one entry: who ran into it, before editing which file, and
 * how long ago, then a line per named commit — missing from the reader's
 * checkout (it can be undone) or already there (it can still be edited
 * over; decision 8). One entry string, so a budget that drops it drops it
 * whole. Null when nothing on it can be named.
 */
export const formatLandedNoticeEntry = (notice: LandedNotice, now: Date): RenderedLandedNotice | null => {
  const name = bareUntrusted(notice.readerName);
  const path = bareUntrusted(notice.path, PATH_CHARS);
  const reader = readerWords(name);
  const named = notice.commits.slice(0, MAX_LANDED_NOTICE_COMMITS_SHOWN).flatMap((commit) => {
    const line = commitLine(commit, reader);
    return line === null ? [] : [{ line, id: commit.id }];
  });
  if (path.length === 0 || named.length === 0) {
    return null;
  }
  const rest = Math.max(0, notice.commits.length - MAX_LANDED_NOTICE_COMMITS_SHOWN);
  const lead = name.length === 0 ? "A teammate" : name;
  const changes = notice.commits.length === 1 ? "change" : "changes";
  return {
    text: [
      `- ${lead} ran into your landed ${changes} before editing ${path}, ${stoppedLabel(notice.stoppedAt, now)}:`,
      ...named.map((entry) => entry.line),
      ...(rest > 0 ? [`  (+${String(rest)} more, shown next time)`] : []),
    ].join("\n"),
    commitIds: named.map((entry) => entry.id),
  };
};

/**
 * As many whole entries as MAX_BRIEFING_LANDED_NOTICE_CHARS holds, in order
 * (briefing/fit.ts): an entry left out is not told, and waits.
 */
export const fitLandedNoticeEntries = (entries: readonly string[]): readonly string[] =>
  fitEntries(entries, MAX_BRIEFING_LANDED_NOTICE_CHARS);
