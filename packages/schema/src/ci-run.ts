/**
 * THE CI WIRE (spec 05). One run of one lane at one commit, and the non-green
 * tests it saw.
 *
 * WHY THIS IS NOT AN ENVELOPE, stated here because the absence is the design.
 * `EnvelopeSchema` requires a producer — a developer, an agent kind and a
 * session — and CI has none of the three. Minting a synthetic session so a CI
 * report could travel the existing route would put a teammate in the graph who
 * does not exist, and a phantom teammate is the one thing the absence machinery
 * must never invent. So this body goes to its own route, carries no producer,
 * and never touches the spool. Ground truth §8.4a generalised the refusal: a
 * 1.0 record that can originate outside an agent session gets its own route.
 *
 * THE LANE IS THE ONLY UNIT THAT MAY BE COMPARED:
 *
 *   lane = (repo, provider, workflow, job, leg, ref)
 *
 * A `macos-latest` red and an `ubuntu-latest` green are TWO FACTS, never one
 * contradiction. This repo's own CI keeps both legs precisely because they
 * disagree — an inode-reuse bug reproduced 20 times out of 20 on Linux and 0
 * out of 20 on macOS — so a model that merges them would have hidden the only
 * signal that mattered. `leg` is `""` when a job has no matrix; `ref` is in the
 * key because a base window interleaving a PR branch with `main` means nothing.
 *
 * NON-GREEN ROWS ONLY, AND THAT IS A CONTRACT RATHER THAN AN OPTIMISATION.
 * Measured on this repo: 275 test files and 2 555 line-start declarations. Two
 * legs at ~2.5k rows an attempt against a 100-row ingest batch is ~50 round
 * trips to say "everything passed". So a run row ASSERTS *these are all the
 * non-green tests I ran* — and that assertion is usable only when the run
 * completed. A `truncated` run can never establish that any test was green,
 * which is the rule that "nothing" and "no answer" are different facts, applied
 * to a suite. `skipped` is stored rather than dropped, because a test that
 * stops running looks green to any rule built on absence.
 */
import { z } from "zod";

import { COMMIT_SHA_PATTERN } from "./landed-evidence.ts";

/**
 * Every provider that has a reporter. A provider absent from this list is
 * `unavailable` on the coverage surface and says so out loud — never
 * `unknown`, which would read as "nothing has arrived yet" for a repo where
 * nothing ever can.
 */
export const CI_PROVIDERS = ["github_actions"] as const;

/**
 * Providers a reader would expect to find here, SHIPPED OR NOT.
 *
 * `CI_PROVIDERS` is what this hub can ingest; this is what somebody looking
 * for their platform would search for. The difference between the two lists
 * is what `crosscheck doctor` prints as a documented refusal (spec 05 §8.1)
 * rather than leaving as a silence a GitLab team reads as "not set up yet".
 *
 * DERIVED, NOT WRITTEN OUT: the day a second provider ships it moves into
 * CI_PROVIDERS and the doctor line stops printing on its own, because the
 * list grew — not because somebody remembered to delete a sentence.
 */
export const CI_KNOWN_PROVIDERS = ["github_actions", "gitlab_ci"] as const;

/**
 * `same_job` is a second run of the failed files on the SAME runner;
 * `new_attempt` is the provider's re-run button on a fresh one. Both are
 * same-commit re-runs and both can confirm, but WHICH one is recorded, because
 * a `same_job` re-run cannot rule out host state.
 */
export const CI_RERUN_KINDS = ["none", "same_job", "new_attempt"] as const;

/**
 * `truncated` is a run whose test list hit the row cap; `crashed` is an
 * infrastructure failure. Neither may ever establish that a test was green,
 * and a crashed run produces no behaviour delta at all — an infrastructure
 * failure is not a fact about a commit.
 */
export const CI_RUN_OUTCOMES = ["completed", "truncated", "crashed"] as const;

export const CI_TEST_STATUSES = ["failed", "errored", "skipped"] as const;

/**
 * THE THREE WIRE BOUNDS, inherited by name rather than tuned.
 *
 * Each matches a bound #50 already argued for, so a reader asking "why 300?"
 * finds one answer instead of two: a test id is bounded like a pin path, a lane
 * field like a pin surface, and a run's row list like a pin sweep's update
 * list. Spec 05 §3.8 names these three beside the four hub-side constants, so a
 * sibling spec looking for "05's constants" finds all seven in one place — a
 * constant another spec cannot find is one it will re-mint.
 */
export const MAX_CI_TEST_ID_CHARS = 300;
export const MAX_CI_LANE_FIELD_CHARS = 120;
export const CI_MAX_TEST_ROWS = 200;

/** `run_attempt` is 1-based at every provider that has the concept. */
const MIN_RUN_ATTEMPT = 1;

/** An opaque provider handle, kept only so a human can open the log. */
const MAX_EXTERNAL_RUN_ID_CHARS = 120;

const laneField = z.string().max(MAX_CI_LANE_FIELD_CHARS);

export const CiProviderSchema = z.enum(CI_PROVIDERS);
export const CiRerunKindSchema = z.enum(CI_RERUN_KINDS);
export const CiRunOutcomeSchema = z.enum(CI_RUN_OUTCOMES);
export const CiTestStatusSchema = z.enum(CI_TEST_STATUSES);

/**
 * One non-green test. No message, no stack, no output — ever.
 *
 * A failure message quotes source text, and content-derived text arriving at
 * the hub from a machine nobody owns is what the data-minimisation refusal
 * forbids. The reporter reads `<failure>` for PRESENCE only. What a reader
 * needs in order to act is the id and the lane; the log lives behind
 * `external_run_id` and stays there.
 */
export const CiTestResultSchema = z.looseObject({
  testId: z.string().min(1).max(MAX_CI_TEST_ID_CHARS),
  status: CiTestStatusSchema,
  durationMs: z.number().int().min(0),
});

export type CiTestResult = z.infer<typeof CiTestResultSchema>;

/**
 * The lane, as it travels. `leg` and `ref` are required rather than optional:
 * an absent `leg` and an empty one would be two spellings of the same lane, and
 * two spellings of one lane is a base window that silently splits in half.
 */
export const CiLaneSchema = z.looseObject({
  repo: z.string().min(1).max(MAX_CI_LANE_FIELD_CHARS),
  provider: CiProviderSchema,
  workflow: z.string().min(1).max(MAX_CI_LANE_FIELD_CHARS),
  job: z.string().min(1).max(MAX_CI_LANE_FIELD_CHARS),
  /** `""` when the job has no matrix — a real value, not a missing one. */
  leg: laneField,
  ref: z.string().min(1).max(MAX_CI_LANE_FIELD_CHARS),
});

export type CiLane = z.infer<typeof CiLaneSchema>;

export const CiRunReportSchema = CiLaneSchema.extend({
  /**
   * THE HEAD SHA, NEVER A PULL REQUEST'S MERGE SHA. The hub holds no
   * repository and cannot tell the two apart, so this is the reporter's
   * obligation and the reporter's test — a merge sha joins no session's base
   * commit and no landed-evidence sha, and produces a silent zero-join that
   * looks exactly like "CI has not run yet".
   */
  commitSha: z.string().regex(COMMIT_SHA_PATTERN),
  runAttempt: z.number().int().min(MIN_RUN_ATTEMPT),
  externalRunId: z.string().min(1).max(MAX_EXTERNAL_RUN_ID_CHARS),
  rerunKind: CiRerunKindSchema,
  /**
   * The run this one re-runs. The hub refuses a target whose lane or commit
   * differs: a re-run of a DIFFERENT commit is not a re-run, and accepting one
   * would let a green run somewhere else clear a red one here.
   */
  rerunOf: z.string().min(1).nullable(),
  outcome: CiRunOutcomeSchema,
  tests: z.number().int().min(0),
  failures: z.number().int().min(0),
  skipped: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  startedAt: z.iso.datetime(),
  collectedAt: z.iso.datetime(),
  /**
   * How many `(file, chain, name)` triples appeared more than once and were
   * therefore DROPPED — both of them, never the first.
   *
   * A positional ordinal would be stable only until somebody reordered the
   * file, and a test that cannot be identified cannot carry a verdict. The
   * count is on the wire so doctor can print it: a silently shorter list is
   * the absence this whole project exists to refuse.
   */
  ambiguousDropped: z.number().int().min(0),
  results: z.array(CiTestResultSchema).max(CI_MAX_TEST_ROWS),
})
  .refine((body) => body.failures <= body.tests, {
    message: "failures cannot exceed tests",
  })
  .refine((body) => body.skipped <= body.tests, {
    message: "skipped cannot exceed tests",
  })
  .refine((body) => (body.rerunKind === "none") === (body.rerunOf === null), {
    message:
      "rerunOf must be present exactly when rerunKind is a re-run, and absent when it is not",
  })
  .refine(
    (body) =>
      body.outcome !== "completed" || body.results.length < CI_MAX_TEST_ROWS,
    {
      message:
        "a run that filled the row cap cannot report `completed` — it is `truncated`",
    },
  );

export type CiRunReport = z.infer<typeof CiRunReportSchema>;
