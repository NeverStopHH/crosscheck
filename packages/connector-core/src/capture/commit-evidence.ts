import type { CommitAuthorEvidence, Envelope } from "@crosscheck/schema";
import {
  MAX_COMMIT_CLOCK_SKEW_MS,
  MAX_COMMIT_EVIDENCE_AUTHORS,
} from "@crosscheck/schema";

import {
  COMMIT_EVIDENCE_GIT_TIMEOUT_MS,
  COMMIT_EVIDENCE_MAX_COMMITS,
  COMMIT_EVIDENCE_WINDOW_DAYS,
  MS_PER_DAY,
} from "../constants.ts";
import { runGit } from "../git/git.ts";
import { buildEnvelope } from "./records.ts";
import type { Producer } from "./records.ts";

/**
 * git's field separator for the log format below. Nothing guarantees an ident
 * cannot smuggle one in: a line carrying an extra separator splits into the
 * wrong number of fields and parseLogLine drops it — that author's evidence is
 * lost for this scan, never garbled. Fail-safe: a missed report, not a false
 * one.
 */
const FIELD_SEPARATOR = "\u001f";

/** `%ae<US>%an<US>%aI`: author email, author name, author date, one per line. */
const LOG_FORMAT = `%ae%x1f%an%x1f%aI`;

interface LogEntry {
  readonly email: string;
  readonly name: string;
  readonly authoredAtMs: number;
}

const parseLogLine = (line: string): LogEntry | null => {
  const [email, name, authoredAt] = line.split(FIELD_SEPARATOR);
  if (email === undefined || name === undefined || authoredAt === undefined) {
    return null;
  }
  const authoredAtMs = Date.parse(authoredAt);
  if (Number.isNaN(authoredAtMs) || email.length === 0 || name.length === 0) {
    return null;
  }
  return { email: email.toLowerCase(), name, authoredAtMs };
};

/**
 * Authors that are automation, not teammates. A `[bot]` author commits
 * continuously and can never have an agent session, so its absence line would
 * squat the briefing forever; GitHub's default privacy alias is skipped for
 * the adjacent reason — no hub member registers under it, so evidence carrying
 * it can only ever surface a real, possibly connected teammate as
 * "unconnected" (squash-merges through the GitHub UI author as the alias).
 * Skipping is fail-safe: a missed finding, never a false one.
 */
const BOT_AUTHOR_NAME_SUFFIX = "[bot]";
const GITHUB_NOREPLY_EMAIL_SUFFIX = "@users.noreply.github.com";

const isAutomationAuthor = (entry: LogEntry): boolean =>
  entry.name.endsWith(BOT_AUTHOR_NAME_SUFFIX) ||
  entry.email.endsWith(GITHUB_NOREPLY_EMAIL_SUFFIX);

const mergeEntry = (
  existing: CommitAuthorEvidence | undefined,
  entry: LogEntry,
): CommitAuthorEvidence => {
  if (existing === undefined) {
    return {
      name: entry.name,
      email: entry.email,
      latestCommitAt: new Date(entry.authoredAtMs).toISOString(),
      commitCount: 1,
    };
  }
  const isNewer = entry.authoredAtMs > Date.parse(existing.latestCommitAt);
  return {
    // The newest commit's spelling of the name wins, matching the timestamp.
    name: isNewer ? entry.name : existing.name,
    email: existing.email,
    latestCommitAt: isNewer
      ? new Date(entry.authoredAtMs).toISOString()
      : existing.latestCommitAt,
    commitCount: existing.commitCount + 1,
  };
};

/**
 * Recent commit authorship of the repo at `root`, aggregated per author email
 * (lowercased — the hub's matching key), newest commit first.
 *
 * This is the Tier-0 evidence absence detection rests on: a
 * commit proves a teammate worked whether or not their connector ever ran, so
 * it is exactly the signal that survives "hooks fail open silently".
 *
 * BOUNDED THREE TIMES, because it runs on the SessionStart path: a hard
 * `--max-count` on commits scanned, a `--since` window, and its own git
 * timeout (COMMIT_EVIDENCE_GIT_TIMEOUT_MS — like drift, a slow git loses the
 * evidence, never the briefing). `commitCount` is therefore a floor, not a
 * census, on repos busier than the scan cap.
 *
 * `--all` rather than HEAD: a teammate's pushed-but-unmerged work lives on
 * fetched remote-tracking refs, and HEAD alone would only ever see the
 * reader's own line of history.
 *
 * The author DATE (%aI) is the timestamp, and the in-code window filter is
 * authoritative — `--since` filters on commit date, which a rebase by someone
 * else moves forward; author date stays with the person who did the work. The
 * same field difference cuts the other way for a cherry-pick or import whose
 * author date is recent but whose commit date is old: `--since` excludes it
 * before this filter sees it — a silent under-report, never a false finding.
 *
 * The window is bounded on BOTH ends: behind by COMMIT_EVIDENCE_WINDOW_DAYS,
 * ahead by MAX_COMMIT_CLOCK_SKEW_MS. An author date is author-controlled free
 * text, and the hub keeps the newest commit timestamp per author, so a date
 * far enough ahead would otherwise be shipped by every teammate's scan and
 * stored as the newest commit until it "happened". Beyond ordinary clock skew,
 * a future date is a forgery or a broken clock — either way, not evidence.
 *
 * Null = no evidence (not a repo, git missing or slow, nothing in the window
 * parseable). Callers skip the record; fail open.
 */
export const collectCommitEvidence = async (
  root: string,
  now: Date,
): Promise<readonly CommitAuthorEvidence[] | null> => {
  const windowStartMs = now.getTime() - COMMIT_EVIDENCE_WINDOW_DAYS * MS_PER_DAY;
  const maxAuthoredAtMs = now.getTime() + MAX_COMMIT_CLOCK_SKEW_MS;
  const output = await runGit(
    [
      "log",
      "--all",
      `--since=${new Date(windowStartMs).toISOString()}`,
      `--max-count=${COMMIT_EVIDENCE_MAX_COMMITS}`,
      `--format=${LOG_FORMAT}`,
    ],
    root,
    COMMIT_EVIDENCE_GIT_TIMEOUT_MS,
  );
  if (output === null) {
    return null;
  }
  const entries = output
    .split("\n")
    .flatMap((line) => {
      const parsed = parseLogLine(line);
      return parsed === null ? [] : [parsed];
    })
    .filter(
      (entry) =>
        entry.authoredAtMs >= windowStartMs &&
        entry.authoredAtMs <= maxAuthoredAtMs &&
        !isAutomationAuthor(entry),
    );
  if (entries.length === 0) {
    return null;
  }
  const byEmail = new Map<string, CommitAuthorEvidence>();
  for (const entry of entries) {
    byEmail.set(entry.email, mergeEntry(byEmail.get(entry.email), entry));
  }
  return [...byEmail.values()]
    .sort(
      (left, right) =>
        Date.parse(right.latestCommitAt) - Date.parse(left.latestCommitAt),
    )
    .slice(0, MAX_COMMIT_EVIDENCE_AUTHORS);
};

/** The wire envelope the spool ships to the hub's cx-envelope ingest. */
export const commitEvidenceRecord = (
  repoId: string,
  authors: readonly CommitAuthorEvidence[],
  producer: Producer,
  now: Date,
): Envelope =>
  buildEnvelope(
    "commit_evidence",
    {
      repo: repoId,
      collectedAt: now.toISOString(),
      windowDays: COMMIT_EVIDENCE_WINDOW_DAYS,
      authors,
    },
    producer,
    now,
  );
