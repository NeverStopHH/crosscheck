/**
 * THE HISTORICAL SEED CORPUS: every seed a sweep of the spool simulation ever
 * found failing — the generator that drew it, the invariant it broke, the bug
 * in one line, and the commit that fixed it. PR CI replays every entry as a
 * fixed scenario (test/spool-simulation.test.ts), so a regression of any bug
 * here fails the pull request, whatever seed range the next sweep draws.
 *
 * A NEW FAILING SEED GOES HERE in the commit that fixes it, with the shrunk
 * events the sweep printed — or with `open` (and `racy`, for one that fails on
 * some interleavings only) until its fix lands: the sweep skips an open seed,
 * and its scenario is marked `failing`. A seed accepted as a documented
 * residual names that class in `residual`, and `fix` is the commit that
 * documented it (docs/1.0/loss-accounting.md).
 *
 * WHY THE EVENTS AND NOT ONLY THE SEED: a generator's draw for a seed changes
 * whenever the generator grows, so the seed alone would not replay the bug.
 * `generator` and `seed` say where it was found; `events` is what it was. The
 * seeds found before the generators split were drawn by `shipped` as it was
 * then (round 7's sweep, and its review's two-process, slow-hub and aged-home
 * extensions that became `shipped` in round 8).
 */
import type { Verdict } from "./sim-invariants.ts";
import { GENERATORS, scenarioOf } from "./sim-world.ts";
import type { GeneratorName, Run, SimEvent } from "./sim-world.ts";
import {
  abandon,
  age,
  crash,
  edit,
  end,
  fault,
  flush,
  hubEnd,
  intent,
  ioFail,
  oldFlush,
  par,
  recover,
  refuseWc,
  slow,
  start,
  VACATION,
  wake,
} from "./sim-events.ts";

/** The residual classes the sweep counts instead of failing on (test/spool-simulation.test.ts residualOf). */
export type ResidualClass = "I1u" | "L1";

export interface CorpusSeed {
  readonly seed: number;
  readonly generator: GeneratorName;
  /** The invariant it broke, or `checker` for a seed the invariants misread. */
  readonly invariant: Verdict["invariant"] | "checker";
  /** The bug, in one line. */
  readonly bug: string;
  /** The commit that fixed it, or for a residual the one that documented it. */
  readonly fix: string;
  readonly events: readonly SimEvent[];
  /** The residual classes its verdicts may fall in; none, for a bug that was fixed. */
  readonly residual?: readonly ResidualClass[];
  /** What its run must show beyond the invariants. */
  readonly shows?: (run: Run) => boolean;
  /** The fix it still waits for: the sweep skips the seed, and its scenario is marked failing. */
  readonly open?: string;
  /** Open, and failing on some interleavings only: skipped rather than marked failing. */
  readonly racy?: boolean;
}

/** The disk let nothing count the drop: the residual I1u happened, and nothing else. */
const counted = (run: Run): boolean => run.uncountable.count > 0;

/** Round 7's sweep, while it was being written (c656f728). */
const ROUND_7_SWEEP: readonly CorpusSeed[] = [
  { seed: 8, generator: "shipped", invariant: "I2", fix: "c656f728", bug: "a SessionStart whose ladder climbed past an ended life left its records to be filed into it", events: [start(0), hubEnd(0), fault("records503", 2, 0), edit(0), start(0)] },
  { seed: 10, generator: "shipped", invariant: "I4", fix: "c656f728", bug: "a SessionStart re-fire put back the status set_intent had set", events: [start(0), intent(0, "done"), start(0)] },
  { seed: 10, generator: "shipped", invariant: "I4", fix: "c656f728", bug: "shrunk with a crash: set_intent killed after the hub took its post, before its state write", events: [start(0), crash(1, "before"), intent(0, "done"), start(0)] },
  { seed: 46, generator: "shipped", invariant: "I1", fix: "c656f728", bug: "a crash right after an append, on a life the hub ended", events: [start(0), hubEnd(0), crash(2, "after"), edit(0)] },
  { seed: 99, generator: "shipped", invariant: "I1", fix: "c656f728", bug: "records the hub took whose answer was lost, refused on a re-send (a residual the invariant allows)", events: [start(0), fault("recordsLate", 2, 2), edit(0), edit(0), edit(0), hubEnd(0)] },
  { seed: 113, generator: "shipped", invariant: "I3", fix: "c656f728", bug: "a SessionStart killed between its register and its state split the session's epoch", events: [crash(3, "before"), start(0), start(0)] },
  { seed: 115, generator: "shipped", invariant: "I2", fix: "c656f728", bug: "an end only a sibling saw, and a successor delivering into it (a residual the invariant allows)", events: [start(0), fault("records503", 2, 0), hubEnd(0), edit(0), abandon(0)] },
  { seed: 349, generator: "shipped", invariant: "I4", fix: "c656f728", bug: "the work context a register spooled reverted the status set_intent set first", events: [crash(6, "after"), start(0), intent(0, "implementing")] },
  { seed: 500, generator: "shipped", invariant: "I2", fix: "c656f728", bug: "a life the hub said ended, with no heal past it, was filed into by a successor", events: [start(0), fault("registersDown", 2, 0), hubEnd(0), edit(0), edit(0), fault("recordsLate", 2, 0), end(0)] },
  { seed: 772, generator: "shipped", invariant: "I2", fix: "c656f728", bug: "a moved life's debt was paid into it after the hub ended it", events: [start(0), fault("records503", 2, 1), hubEnd(0), edit(0), hubEnd(0)] },
  { seed: 1020, generator: "shipped", invariant: "I4", fix: "c656f728", bug: "set_intent put the old status back after a post whose answer was lost", events: [start(0), fault("recordsLate", 1, 1), fault("records503", 1, 0), intent(0, "done"), intent(0, "done"), intent(0, "blocked")] },
  { seed: 1033, generator: "shipped", invariant: "I2", fix: "c656f728", bug: "set_intent refused as ended told nobody, and a successor filed into the life", events: [fault("records503", 2, 0), start(1), hubEnd(1), start(2), intent(1, "blocked"), abandon(1)] },
  { seed: 1161, generator: "shipped", invariant: "I1", fix: "c656f728", bug: "a work context the hub took unheard, then withheld (a residual the invariant allows)", events: [fault("recordsLate", 1, 0), start(1), hubEnd(1), start(1)] },
  { seed: 2385, generator: "shipped", invariant: "I1", fix: "c656f728", bug: "a crash armed before a host goes quiet kills the next connector step, not the host", events: [start(0), crash(2, "after"), edit(0), crash(1, "after"), abandon(0)] },
  { seed: 3062, generator: "shipped", invariant: "I4", fix: "c656f728", bug: "a spooled work context sent after SessionEnd reverted the status set_intent set", events: [crash(7, "after"), start(0), fault("records503", 1, 1), intent(0, "blocked"), crash(1, "after"), start(0), end(0)] },
  { seed: 3098, generator: "shipped", invariant: "I4", fix: "c656f728", bug: "the same, with the work context the register spooled", events: [fault("records503", 1, 1), crash(6, "after"), start(0), intent(0, "done"), end(0)] },
  { seed: 4337, generator: "shipped", invariant: "I4", fix: "c656f728", bug: "set_intent killed after writing its status into the state", events: [start(1), intent(1, "done"), crash(1, "after"), intent(1, "implementing"), start(1)] },
  { seed: 7019, generator: "shipped", invariant: "I2", fix: "c656f728", bug: "the deferred end ended a life whose work context was still owed", events: [start(0), hubEnd(0), fault("records503", 2, 2), intent(0, "blocked"), edit(0), intent(0, "reviewing")] },
];

/** The round-7 review's extended sweep: two processes at once, a slow hub, an aged home (round 8's fixes). */
const ROUND_7_REVIEW: readonly CorpusSeed[] = [
  { seed: 455, generator: "shipped", invariant: "I2", fix: "8bfa2906", bug: "H1: an ended life's straggler, its host dead a week, sent into it by a successor", events: [start(1), hubEnd(1), fault("registersDown", 1, 1), start(0), edit(1), par(edit(0), edit(1)), age(1)] },
  { seed: 10005, generator: "shipped", invariant: "I2", fix: "8bfa2906", bug: "H1: the same after a crash", events: [start(0), hubEnd(0), crash(4, "before"), edit(0), age(0)] },
  { seed: 11379, generator: "shipped", invariant: "I2", fix: "8bfa2906", bug: "H1: the same behind a slow hub", events: [start(0), hubEnd(0), slow(1400, 2, 0), edit(0), intent(0, "blocked"), edit(0), age(0)] },
  { seed: 782, generator: "shipped", invariant: "I2", fix: "afec0c55", bug: "M1: a reload's re-fire beside SessionEnd, then set_intent beside it, filed past the end", events: [start(0), fault("records503", 2, 1), fault("recordsLate", 1, 0), par(start(0), end(0)), par(intent(0, "implementing"), end(0))] },
  { seed: 10895, generator: "shipped", invariant: "I4", fix: "cf496cff", bug: "M3: a reaped host's work context reverted the status set_intent set", events: [crash(7, "before"), start(1), intent(1, "done"), fault("registersDown", 2, 0), age(1), start(0)] },
  { seed: 184, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1: set_intent beside a SessionStart re-fire", events: [start(0), par(intent(0, "implementing"), start(0))] },
  { seed: 1255, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1: the same, the other way round", events: [start(1), refuseWc(0), par(intent(1, "blocked"), start(1))] },
  { seed: 1384, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1: a re-fire beside set_intent", events: [start(0), par(start(0), intent(0, "implementing"))] },
  { seed: 1605, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1: the same on a second conversation", events: [start(1), par(start(1), intent(1, "implementing"))] },
  { seed: 1715, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1: a re-fire beside set_intent blocked", events: [start(0), par(start(0), intent(0, "blocked"))] },
  { seed: 11151, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1: set_intent beside a re-fire, then a crash", events: [start(0), par(intent(0, "blocked"), start(0)), crash(7, "before")] },
  { seed: 11274, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1: a re-fire beside set_intent, another re-fire, a crash", events: [start(1), par(start(1), intent(1, "blocked")), start(1), crash(4, "after")] },
  { seed: 11362, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1: set_intent done beside a re-fire", events: [start(0), par(intent(0, "done"), start(0))] },
  { seed: 11645, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1: a re-fire beside set_intent implementing", events: [start(0), par(start(0), intent(0, "implementing"))] },
  { seed: 10102, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1, production timing: set_intent beside a re-fire", events: [start(1), par(intent(1, "implementing"), start(1))] },
  { seed: 11955, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1, production timing: set_intent done beside a re-fire", events: [start(1), par(intent(1, "done"), start(1))] },
  { seed: 1035, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1, production timing: set_intent beside a re-fire, a second conversation open", events: [start(0), start(1), edit(0), par(intent(0, "done"), start(0))] },
  { seed: 1501, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1, production timing: set_intent blocked beside a re-fire after an edit", events: [start(0), edit(0), par(intent(0, "blocked"), start(0))] },
  { seed: 912, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1, production timing: a re-fire beside set_intent behind a slow hub", events: [start(0), edit(0), slow(1700, 1, 1), edit(0), par(start(0), intent(0, "blocked"))] },
  { seed: 1494, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1, production timing: a re-fire beside set_intent after a crashed start", events: [start(0), crash(1, "before"), edit(0), par(start(0), intent(0, "done"))] },
  { seed: 11268, generator: "shipped", invariant: "I4", fix: "a197bec9", bug: "L1, production timing: a re-fire beside set_intent, then a flush beside an edit", events: [start(0), par(start(0), intent(0, "blocked")), par(edit(0), flush(0))] },
  { seed: 134, generator: "shipped", invariant: "I3", fix: "33c6e54c", bug: "L2: two SessionStarts of one host session at once, a register refused", events: [fault("registersDown", 2, 1), par(start(1), start(1))] },
  { seed: 1933, generator: "shipped", invariant: "I3", fix: "33c6e54c", bug: "L2: a SessionStart beside a SessionEnd after a crashed end", events: [start(0), crash(4, "before"), end(0), par(start(0), end(0))] },
  { seed: 11285, generator: "shipped", invariant: "I3", fix: "33c6e54c", bug: "L2: two SessionStarts at once after a crash, registers refused", events: [crash(1, "before"), fault("registersDown", 2, 2), par(start(0), start(0))] },
  { seed: 11683, generator: "shipped", invariant: "I3", fix: "33c6e54c", bug: "L2: an edit beside a resume after an ended life", events: [start(0), hubEnd(0), crash(3, "after"), start(0), end(0), par(edit(0), start(0))] },
  { seed: 11974, generator: "shipped", invariant: "I3", fix: "33c6e54c", bug: "L2, production timing: a resume onto the life a heal's unheard register opened, behind a slow hub", events: [start(0), slow(600, 1, 1), hubEnd(0), edit(0), end(0), par(start(0), end(0))] },
  { seed: 1018, generator: "shipped", invariant: "checker", fix: "5600e4d0", bug: "SessionEnd beside a successor's SessionStart, read as live", events: [start(1), fault("records503", 2, 0), edit(1), par(end(1), start(0))] },
  { seed: 1034, generator: "shipped", invariant: "checker", fix: "5600e4d0", bug: "two SessionEnds at once, read as live", events: [start(1), start(0), fault("recordsLate", 2, 1), edit(1), edit(1), par(end(1), end(0))] },
  { seed: 10009, generator: "shipped", invariant: "checker", fix: "5600e4d0", bug: "production timing: a resume beside a successor's drain of its ended spool, read as live", events: [start(0), start(1), fault("records503", 1, 2), edit(1), edit(0), edit(1), fault("recordsLate", 1, 0), end(1), par(edit(0), start(1))] },
];

/** The round-8 review's io, sleep and focus sweeps, and round 9's own (round 9's fixes and residuals). */
const ROUND_8_REVIEW: readonly CorpusSeed[] = [
  { seed: 3, generator: "sleep", invariant: "I3", fix: "2452cfee", bug: "M2: a first life asleep a week, resumed after another conversation started", events: [start(0), VACATION, start(2), wake(0), start(0)] },
  { seed: 365, generator: "sleep", invariant: "I3", fix: "2452cfee", bug: "M2: a recovery after a crashed resume of an ended life", events: [start(0), end(0), crash(2, "after"), start(0), recover(0)] },
  { seed: 935, generator: "sleep", invariant: "I3", fix: "2452cfee", bug: "M2: a recovery after the end of a life the hub ended", events: [start(0), crash(7, "before"), hubEnd(0), edit(0), end(0), recover(0)] },
  { seed: 936, generator: "sleep", invariant: "I3", fix: "2452cfee", bug: "M2: a recovery after a resume killed after its third write", events: [start(0), end(0), crash(3, "after"), start(0), recover(0)] },
  { seed: 1955, generator: "sleep", invariant: "I3", fix: "2452cfee", bug: "M2: a recovery after a resume killed before its third write", events: [start(0), end(0), crash(3, "before"), start(0), recover(0)] },
  { seed: 361, generator: "focus", invariant: "I3", fix: "2452cfee", bug: "L4: SessionEnd beside a re-fire behind a slow hub", events: [start(1), slow(600, 2, 1), edit(1), fault("records503", 2, 1), par(flush(1), intent(1, "done")), par(end(1), start(1))] },
  { seed: 662, generator: "focus", invariant: "I3", fix: "2452cfee", bug: "L4: a start beside an end, twice, behind a slow hub", events: [par(start(0), end(0)), slow(1700, 1, 2), par(start(0), flush(0)), fault("recordsLate", 2, 1), edit(0), par(end(0), start(0)), edit(0)] },
  { seed: 1811, generator: "focus", invariant: "I3", fix: "2452cfee", bug: "L4: the generated scenario, a re-fire beside its own SessionEnd", events: scenarioOf(1811, GENERATORS.focus) },
  { seed: 18, generator: "focus", invariant: "I4", fix: "cffa2b1a", residual: ["L1"], bug: "two set_intents of one conversation at once behind a slow hub", events: [start(0), par(intent(0, "blocked"), start(0)), slow(1700, 1, 1), par(intent(0, "done"), intent(0, "blocked"))] },
  { seed: 313, generator: "focus", invariant: "I4", fix: "cffa2b1a", residual: ["L1"], bug: "the generated scenario, two set_intents of one conversation at once", events: scenarioOf(313, GENERATORS.focus) },
  { seed: 399, generator: "focus", invariant: "I4", fix: "cffa2b1a", residual: ["L1"], bug: "SessionEnd beside set_intent behind a slow hub", events: [start(0), par(intent(0, "done"), flush(0)), slow(1400, 2, 0), par(end(0), intent(0, "implementing"))] },
  { seed: 1786, generator: "focus", invariant: "I4", fix: "cffa2b1a", residual: ["L1"], bug: "two set_intents of one conversation at once, answers lost", events: [start(0), par(edit(0), intent(0, "done")), fault("recordsLate", 2, 2), edit(0), par(intent(0, "implementing"), intent(0, "done"))] },
  { seed: 1791, generator: "focus", invariant: "I4", fix: "cffa2b1a", residual: ["L1"], bug: "set_intent beside a re-fire and an end behind a slow hub", events: [start(0), par(start(0), intent(0, "blocked")), slow(600, 2, 2), par(intent(0, "implementing"), start(0)), par(end(0), intent(0, "implementing"))] },
  { seed: 270, generator: "focus", invariant: "I4", fix: "cffa2b1a", residual: ["L1"], bug: "found by round 9's sweep: the generated scenario, set_intent beside set_intent or its SessionEnd", events: scenarioOf(270, GENERATORS.focus) },
  ...[
    { seed: 112, events: [start(1), ioFail(3, 6), hubEnd(1), edit(1)] },
    { seed: 252, events: [ioFail(8, 17), refuseWc(1), par(start(1), edit(1))] },
    { seed: 894, events: [start(0), start(2), fault("records503", 2, 1), edit(2), hubEnd(2), edit(0), edit(2), ioFail(1, 5), oldFlush(2)] },
    { seed: 924, events: [refuseWc(0), start(0), ioFail(3, 8), edit(0)] },
    { seed: 940, events: [start(1), hubEnd(1), ioFail(5, 29), par(edit(1), end(0))] },
    { seed: 950, events: [start(0), slow(1400, 2, 2), hubEnd(0), start(2), edit(0), edit(2), ioFail(3, 29), edit(0)] },
    { seed: 1022, events: [start(0), hubEnd(0), ioFail(4, 11), edit(0)] },
    { seed: 1359, events: [start(2), ioFail(5, 14), hubEnd(2), edit(2)] },
    { seed: 1957, events: [crash(5, "before"), start(0), ioFail(4, 7), edit(0)] },
  ].map(
    ({ seed, events }): CorpusSeed => ({
      seed,
      generator: "io",
      invariant: "I1u",
      fix: "e469c45d",
      residual: ["I1u"],
      bug: "a drop the disk refused to write down, ledger line and marker both, and nothing else",
      events,
      shows: counted,
    }),
  ),
  { seed: 1993, generator: "io", invariant: "I1", fix: "79c959d6", bug: "found by round 9's sweep: a record the hub held, in a batch whose heal stayed pending, withheld once its conversation was over", events: scenarioOf(1993, GENERATORS.io) },
];

/**
 * L7's last word, again (first found by feat/topic-contexts' topics sweep,
 * seed 416, and fixed there in 7322b132; searched for here in `sleep`): a
 * set_intent post whose answer was lost — the hub took it — then one failing
 * back to the status the hub last acknowledged. The state and the
 * acknowledgement agreed, so neither SessionEnd nor, for a host that died,
 * session-reap sent the work context, and the hub ended on the lost post's
 * status.
 */
const L7_LAST_WORD: readonly CorpusSeed[] = [
  {
    seed: 10478,
    generator: "sleep",
    invariant: "I4",
    fix: "7322b132",
    bug: "L7: a set_intent post taken unheard, then one failing back to the acknowledged status, and SessionEnd sent nothing",
    events: [start(1), intent(1, "blocked"), fault("recordsLate", 2, 0), intent(1, "done"), fault("records503", 1, 0), intent(1, "blocked")],
  },
  {
    seed: 10478,
    generator: "sleep",
    invariant: "I4",
    fix: "7322b132",
    bug: "L7: the same on a host that then died, its reaped state's last word never sent",
    events: [start(1), intent(1, "blocked"), fault("recordsLate", 2, 0), intent(1, "done"), fault("records503", 1, 0), intent(1, "blocked"), age(1)],
  },
  { seed: 10478, generator: "sleep", invariant: "I4", fix: "7322b132", bug: "the generated scenario", events: scenarioOf(10478, GENERATORS.sleep) },
];

export const SEED_CORPUS: readonly CorpusSeed[] = [...ROUND_7_SWEEP, ...ROUND_7_REVIEW, ...ROUND_8_REVIEW, ...L7_LAST_WORD];

/** A corpus entry as its fixed scenario's title names it. */
export const corpusName = (entry: CorpusSeed): string =>
  `${entry.generator} seed ${String(entry.seed)} (${entry.invariant}${entry.residual === undefined ? "" : `, residual ${entry.residual.join("+")}`}): ${entry.bug}`;
