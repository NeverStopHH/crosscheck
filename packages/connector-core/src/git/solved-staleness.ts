/**
 * THE VOCABULARY OF THE SOLVED BLOCK'S FILE DRIFT — and nothing else any
 * more. The function that used to compute it lived here and is gone; spec 02
 * §5 is why, and this header is the note that keeps it gone.
 *
 * `checkSolvedFileDrift` asked git `rev-list --count --since=<solvedAt>`: a
 * WALL CLOCK over commit dates. Spec 02's revalidation leg asks
 * `observedAtCommit..<defaultRef>`: ANCESTRY. Both ran on one `get_diagnosis`
 * pull, over one clone, and both printed — four lines apart in one document,
 * with no precedence rule between them. That is two live staleness
 * definitions, which is exactly what CCB-2 forbids.
 *
 * THEY DISAGREE ON THE MOST ORDINARY GIT WORKFLOW THERE IS. A feature branch
 * merged into the default branch keeps its original committer dates, so
 * `--since` never sees those commits while the range does. Measured on a
 * purpose-built clone: `--since` answered 0 and the range answered one
 * commit, for the same file, from the same clone, on the same pull.
 *
 * AND THE CLOCK SENTENCE WAS THE REASSURING ONE. A reader going top-down met
 * "have not changed on the default branch" first and could act on a root
 * cause whose code had been rewritten — a wrong-axis measurement
 * STRENGTHENING a conclusion, which principle 5 forbids outright.
 *
 * The block's drift is now DERIVED from the revalidation record
 * (`fileDriftFromValidity` in mcp/tools/get-diagnosis.ts), so it costs no git
 * call of its own and cannot contradict the claims printed beside it. The
 * three states survive because the renderer still needs three sentences.
 *
 * DO NOT PUT A SECOND COMPUTATION BACK HERE. `staleness-axis.test.ts` walks
 * every src module for a clock-shaped git argument and fails the build on
 * one; that test is CCB-2's guard, and this file is the first place a
 * well-meaning change would restore the axis.
 */

/**
 * Three honest answers, never two: "unknown" is a first-class state because
 * the derivation is fail-open — a solved tree whose drift could not be
 * determined must say so, not read as current.
 */
export type SolvedFileDrift = "changed" | "unchanged" | "unknown";
