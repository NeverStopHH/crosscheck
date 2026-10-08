/**
 * THE HOLD-OUT ACCEPTANCE PROTOCOL (DESIGN.md §4; hold-out review round 3,
 * decision 12). The corpus gates are training data and hold the line already
 * won; a review round is MEASURED on a fresh hold-out — prompts and trees its
 * author never saw — driven through the same pipeline, and accepted only when
 * every HARD rate below holds:
 *
 *   - content-free rows hinted   ≤ HOLDOUT_CONTENT_FREE_HINT_MAX_RATE of the content-free rows;
 *   - task rows floored          ≤ HOLDOUT_TASK_FLOOR_MAX_RATE of the task rows (no hub call made);
 *   - WRONG-TREE SUBSTANCE       ≤ HOLDOUT_WRONG_TREE_SUBSTANCE_MAX_RATE of the task rows: a task
 *     row shown a teammate's finding from a tree other than the one it is about
 *     (round 3: "token refresh fails after key rotation" was pushed a rate-limit
 *     decision). A pointer to the wrong tree costs a glance; a body from it
 *     costs trust, so only the body is a hard rate.
 *
 * And one SOFT rate, reported and never failed on: content-free rows that
 * still REACHED the hub (a call, whatever it returned), against
 * HOLDOUT_REACHED_HUB_SOFT_TARGET. The owner's hard rule is "no hint"; the
 * reach is the cost of the rules that keep dialect and long status reports
 * from hinting without a word list per dialect.
 */

/** Content-free rows of a fresh hold-out that may be hinted. */
export const HOLDOUT_CONTENT_FREE_HINT_MAX_RATE = 0.02;
/** Task rows of a fresh hold-out the connector may judge content-free. */
export const HOLDOUT_TASK_FLOOR_MAX_RATE = 0.03;
/** Task rows of a fresh hold-out that may be shown substance from another tree than their own. */
export const HOLDOUT_WRONG_TREE_SUBSTANCE_MAX_RATE = 0.02;
/** SOFT: content-free rows of a fresh hold-out that reach the hub at all. Reported, never failed on. */
export const HOLDOUT_REACHED_HUB_SOFT_TARGET = 0.25;
