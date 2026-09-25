/**
 * `doctor`'s "landed-change reasons" line (docs/1.0/landed-changes.md, step
 * 3, decision 7): whose commits on the landing branches the hub cannot put a
 * name to.
 *
 * A landed-change stop names the teammate work behind a commit only when the
 * hub knows the commit's author address. An address it does not know — very
 * often the one GitHub writes squash commits under, 12345+mike@users.noreply
 * .github.com — costs every stop about that person's work its why, and
 * nothing else says so. This line names those addresses with the .mailmap
 * line that maps each to its person once, for the whole team.
 *
 * READ FROM THIS CLONE: the landing branches' latest
 * DOCTOR_LANDED_AUTHORS_MAX_COMMITS commits — a count, never a date window:
 * `--since` DROPS a merged feature branch's commits for their old dates,
 * where a count only orders them by those dates, so in a busy repo a
 * long-lived branch merged just now can still sit past the count — author
 * addresses after .mailmap (`%aE`, exactly what the stop sends), the
 * reader's own (the stop's own rule) and bots' left out. PASS throughout: an outside contributor is no fault, and a
 * hub that does not answer is already another line's WARN.
 */
import {
  DOCTOR_LANDED_AUTHORS_GIT_TIMEOUT_MS,
  DOCTOR_LANDED_AUTHORS_MAX_COMMITS,
  DOCTOR_LANDED_AUTHORS_SHOWN,
} from "@crosscheck/connector-core/constants.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { getUnknownAuthors } from "@crosscheck/connector-core/http/hub.ts";
import { quietGitRunner, readOwnEmail } from "@crosscheck/connector-core/landed-changes/git-queries.ts";
import { readLandingBranches, resolveLandingRefs } from "@crosscheck/connector-core/landed-changes/landing-branches.ts";
import { LANDED_AUTHORS_MAX_EMAILS } from "@crosscheck/schema";

import type { Check } from "./doctor.ts";

const NAME = "landed-change reasons";
const HTTP_NOT_FOUND = 404;
const FIELD = "\x00";
const BOT = /\[bot\]/i;

const pass = (detail: string): Check => ({ level: "PASS", name: NAME, detail });

interface Author {
  readonly email: string;
  readonly name: string;
}

/** Distinct by address (case-insensitive), first spelling kept, in log order. */
const authorsOf = (log: string, own: string | null): readonly Author[] => {
  const seen = new Map<string, Author>();
  for (const line of log.split("\n")) {
    const [email = "", name = ""] = line.split(FIELD);
    const key = email.trim().toLowerCase();
    const isSkipped =
      !key.includes("@") || key === own || BOT.test(email) || BOT.test(name) || seen.has(key);
    if (!isSkipped) {
      seen.set(key, { email: email.trim(), name: name.trim() });
    }
  }
  return [...seen.values()];
};

const listed = (authors: readonly Author[]): string => {
  const shown = authors.slice(0, DOCTOR_LANDED_AUTHORS_SHOWN).map((author) => author.email);
  const rest = authors.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} (+${String(rest)} more)` : shown.join(", ");
};

const WHERE = (branches: string): string =>
  `in the last ${String(DOCTOR_LANDED_AUTHORS_MAX_COMMITS)} commits on ${branches}`;

const unknownLine = (unknown: readonly Author[], branches: string): string => {
  const first = unknown[0];
  const example = first === undefined ? "" : `${first.name || "Name"} <their Crosscheck address> <${first.email}>`;
  const count =
    unknown.length === 1 ? "1 commit address belongs" : `${String(unknown.length)} commit addresses belong`;
  return (
    `${count} to nobody on the hub (${WHERE(branches)}), so a stop for their landed changes names ` +
    `no work behind them: ` +
    `${listed(unknown)} — if they are teammates, map each in .mailmap to the address they use with ` +
    `Crosscheck, e.g. ${example}`
  );
};

export const checkLandedAuthors = async (repoRoot: string, hub: HubContext): Promise<Check> => {
  const refs = await resolveLandingRefs(repoRoot, await readLandingBranches(repoRoot));
  if (refs === null || refs.length === 0) {
    return pass("no landing branches in this clone to read commit authors from");
  }
  const branches = refs.map((ref) => ref.branch).join(", ");
  const run = quietGitRunner(repoRoot, DOCTOR_LANDED_AUTHORS_GIT_TIMEOUT_MS);
  const [log, own] = await Promise.all([
    run([
      "log",
      "--no-merges",
      `--max-count=${String(DOCTOR_LANDED_AUTHORS_MAX_COMMITS)}`,
      "--format=%aE%x00%aN",
      ...refs.map((ref) => ref.ref),
    ]),
    readOwnEmail({ root: repoRoot, file: "", run, isCancelled: () => false }),
  ]);
  if (log === null) {
    return pass("git did not answer, so the landing branches' commit authors were not checked");
  }
  const authors = authorsOf(log, own?.toLowerCase() ?? null);
  if (authors.length === 0) {
    return pass(`no commits by others ${WHERE(branches)}`);
  }
  const asked = authors.slice(0, LANDED_AUTHORS_MAX_EMAILS);
  // repoKey "" keeps this probe out of the sync record, like doctor's others.
  const answer = await getUnknownAuthors({ ...hub, repoKey: "" }, asked.map((author) => author.email));
  if (!answer.ok) {
    return pass(
      answer.status === HTTP_NOT_FOUND
        ? "this hub does not answer this yet — an older hub; its stops name no work behind landed changes"
        : "the hub did not answer, so the landing branches' commit authors were not checked",
    );
  }
  const unknownSet = new Set(answer.data.map((email) => email.toLowerCase()));
  const unknown = asked.filter((author) => unknownSet.has(author.email.toLowerCase()));
  return unknown.length === 0
    ? pass(
        `all ${String(asked.length)} commit authors ${WHERE(branches)} are known to the hub, ` +
          "so a stop can name their work",
      )
    : pass(unknownLine(unknown, branches));
};
