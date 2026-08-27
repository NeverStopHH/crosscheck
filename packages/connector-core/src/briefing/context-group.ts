/**
 * ONE LINE PER TEAMMATE in the briefing's "Teammate work contexts" section,
 * not one line per context (audit row M15-rest).
 *
 * WHAT WENT WRONG WITHOUT IT. A work context is created at SessionStart, one
 * per session, so a teammate running three worktrees — or restarting their
 * agent three times on the same branch — owns three contexts with the same
 * title, and the section is bounded at MAX_CONTEXTS = 5 lines sorted by age.
 * One busy teammate therefore filled the whole section with three spellings of
 * the same sentence, and the second teammate, working somewhere else entirely,
 * never reached the briefing at all. Presence had this fixed from the start
 * (`groupTeammates` in briefing/render.ts groups sessions per developer); this
 * section is the same information one layer down and never did.
 *
 * WHAT THIS ADOPTS. GitHub's notification inbox and the Slack GitHub app both
 * group by the ENTITY and then say how many events they folded in ("3 new
 * reviews on your PR"), rather than printing one row per event; the digest
 * literature calls the grouping key the thing the reader would act on. Here
 * the reader acts on a PERSON — they open that person's tree, or they ask them
 * — so the person is the key and the count rides on the line. What is
 * deliberately NOT adopted is the digest's other habit, aggregating until the
 * line stops naming anything specific: the title of the ONE context this
 * teammate is most likely to be asked about is still printed in full, because
 * "Ken has 3 work contexts" is a sentence nobody can act on.
 *
 * WHICH CONTEXT SPEAKS FOR THE TEAMMATE, in order:
 *   1. one with recorded work — a claim or a captured target. A context with
 *      neither is a session that started and did nothing, and it is the one
 *      most likely to be the freshest, because starting a session is what
 *      creates it. Preferring substance is what stops an empty shell from
 *      speaking for a teammate who has a real investigation open beside it.
 *   2. among those, the freshest by the same activity timestamp the line
 *      renders as its age.
 *   3. and, so the answer never depends on the order rows arrived in, the
 *      lexicographically smaller title.
 *
 * IT IS PURE DATA. Nothing here renders, frames or sanitizes: the caller hands
 * in titles that are ALREADY sanitized and non-empty, and gets back which row
 * to print and how many it stands for. That is why this module is not in the
 * §4.4 render-surface registry — it names no render identifier and emits no
 * text — and the reason it is a module at all rather than three more branches
 * inside `renderContextSection` is that the rules above are worth testing
 * without a briefing around them.
 */

/** What grouping needs from a row; the caller may carry anything else along. */
export interface GroupableContext {
  readonly developerId: string;
  /** Already sanitized and non-empty — the caller drops the rest. */
  readonly title: string;
  readonly ageMs: number;
  /** A claim or a captured target: this session did something. */
  readonly hasRecordedWork: boolean;
}

export interface DeveloperContextGroup<T extends GroupableContext> {
  /** The row that speaks for this teammate. */
  readonly shown: T;
  /**
   * How many DISTINCT OTHER titles this teammate has in the window. Distinct,
   * because the same branch open in two worktrees is one piece of work seen
   * twice and counting it twice would overstate what the reader is not seeing.
   */
  readonly collapsed: number;
}

interface Accumulator<T extends GroupableContext> {
  readonly shown: T;
  readonly titles: ReadonlySet<string>;
}

/**
 * True when `candidate` should speak for the developer instead of `current`.
 * Order-independent by construction: every comparison is a total order on the
 * row's own fields, so the same set of rows in any order groups identically.
 */
const speaksInstead = <T extends GroupableContext>(
  candidate: T,
  current: T,
): boolean => {
  if (candidate.hasRecordedWork !== current.hasRecordedWork) {
    return candidate.hasRecordedWork;
  }
  if (candidate.ageMs !== current.ageMs) {
    return candidate.ageMs < current.ageMs;
  }
  return candidate.title < current.title;
};

/**
 * One group per developer, freshest teammate first — the same order the
 * presence section uses, and the same tie-break on the title so two teammates
 * whose rows carry the identical timestamp do not swap places between runs.
 */
export const groupContextsByDeveloper = <T extends GroupableContext>(
  entries: readonly T[],
): readonly DeveloperContextGroup<T>[] => {
  const groups = new Map<string, Accumulator<T>>();
  for (const entry of entries) {
    const existing = groups.get(entry.developerId);
    if (existing === undefined) {
      groups.set(entry.developerId, {
        shown: entry,
        titles: new Set([entry.title]),
      });
      continue;
    }
    groups.set(entry.developerId, {
      shown: speaksInstead(entry, existing.shown) ? entry : existing.shown,
      titles: new Set([...existing.titles, entry.title]),
    });
  }
  return [...groups.values()]
    .map((group) => ({
      shown: group.shown,
      collapsed: group.titles.size - 1,
    }))
    .sort(
      (left, right) =>
        left.shown.ageMs - right.shown.ageMs ||
        (left.shown.title < right.shown.title ? -1 : 1),
    );
};
