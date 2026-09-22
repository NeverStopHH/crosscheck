/**
 * A CLONE'S READING of whether the code under some claims has moved, on its
 * way to the hub (1.0 spec 02 §3.3, §3.7).
 *
 * NOT AN ENVELOPE, and that is a rule rather than a convenience: a
 * revalidation can originate outside any agent session — `crosscheck
 * revalidate` runs from a terminal — and minting a session for it would put a
 * phantom teammate into presence, into every briefing and into the tripwire.
 * It carries no `seq` either; in the canonical event model it is unsequenced.
 *
 * TRUST MODEL, inherited from landed evidence: any member may report, because
 * the check is reproducible from any clone and only commit hashes — already
 * shared git history — travel. What the hub does NOT do is take the report's
 * word on the direction: `result: "unchanged"` can never overwrite a stored
 * `"changed"` (services/claim-revalidations.ts), because the developer bearer
 * key sits in plaintext in ~/.crosscheck/config.json and any agent on the
 * machine can read it. Without that rule the agent that wrote a claim could
 * mark its own stale claim current and keep it in teammates' prompts.
 */
import { z } from "zod";

import { COMMIT_SHA_PATTERN } from "./commit-sha.ts";
import {
  ClaimCommitBindingSchema,
  ClaimRevalidationBasisSchema,
  ClaimRevalidationResultSchema,
  ClaimValidityStateSchema,
} from "./enums.ts";
import { MAX_RECORD_ID_LENGTH, SAFE_ID_PATTERN } from "./question.ts";

/**
 * How many commits one downgrade may NAME. Five (spec 02 D6, default). The
 * COUNT is not capped — `touchingTotal` is measured — so the sentence reads
 * "8 commits have touched these files since — <5 shas>" rather than shrugging.
 *
 * Lives here rather than beside the git call because it bounds a WIRE array
 * and a stored jsonb column; connector-core/src/constants.ts re-exports it.
 */
export const MAX_CLAIM_TOUCHING_COMMITS = 5;

/**
 * Claims one report may carry: exactly as many as one diagnosis tree can hand
 * a reader (the hub's DIAGNOSIS_MAX_CLAIMS).
 *
 * NOT SMALLER, and the first value was. A pull measures GROUPS — the claims
 * sharing one commit and one file set — and a tree whose claims all sit on one
 * commit is ONE group holding every claim. The report still names each claim,
 * so a cap below the tree's own size refused the whole reading of any tree
 * past it: nothing recorded, every claim `unknown` on every pull, and the
 * only sign a sentence saying the hub did not record it.
 *
 * VERIFY: bun -e 'const s=await import("./packages/schema/src/claim-revalidation.ts");const d=await import("./packages/server/src/services/diagnosis.ts");console.log(s.MAX_CLAIM_REVALIDATION_ENTRIES === d.DIAGNOSIS_MAX_CLAIMS)'
 * PRINTS: true
 */
export const MAX_CLAIM_REVALIDATION_ENTRIES = 500;

const claimId = z
  .string()
  .min(1)
  .max(MAX_RECORD_ID_LENGTH)
  .regex(SAFE_ID_PATTERN);

const commitSha = z.string().regex(COMMIT_SHA_PATTERN);

export const ClaimRevalidationEntrySchema = z.looseObject({
  claimId,
  result: ClaimRevalidationResultSchema,
  basis: ClaimRevalidationBasisSchema,
  /** Which ref state the reading was taken against — context, not a key. */
  refCommit: commitSha,
  /** Newest-first, abbreviated, nothing else: no author, message or paths. */
  touchingCommits: z
    .array(commitSha)
    .max(MAX_CLAIM_TOUCHING_COMMITS)
    .default([]),
  /**
   * How many commits touched the surface in total. Null means "more than the
   * named ones, and the count could not be taken" — never a guess, and never
   * a number below `touchingCommits.length`.
   */
  touchingTotal: z.number().int().min(0).nullable().default(null),
});

export const ClaimRevalidationReportSchema = z
  .looseObject({
    repo: z.string().min(1),
    entries: z
      .array(ClaimRevalidationEntrySchema)
      .min(1)
      .max(MAX_CLAIM_REVALIDATION_ENTRIES),
    /**
     * THE CUT, reported rather than hidden (spec 02 CCB-9). `total` is how
     * many distinct (commit, path-set) groups the tree had; `revalidated` is
     * how many fitted inside the caller's bound. A bound spent silently is a
     * measurement claiming more than it made.
     */
    revalidated: z.number().int().min(0),
    total: z.number().int().min(0),
  })
  .check((ctx) => {
    const report = ctx.value;
    if (report.revalidated > report.total) {
      ctx.issues.push({
        code: "custom",
        message: "revalidated may not exceed total",
        input: report.revalidated,
        path: ["revalidated"],
      });
    }
    for (const [index, entry] of report.entries.entries()) {
      if (
        entry.touchingTotal !== null &&
        entry.touchingTotal < entry.touchingCommits.length
      ) {
        ctx.issues.push({
          code: "custom",
          message: "touchingTotal may not be below the commits it names",
          input: entry.touchingTotal,
          path: ["entries", index, "touchingTotal"],
        });
      }
      if (entry.result !== "changed" && entry.touchingCommits.length > 0) {
        ctx.issues.push({
          code: "custom",
          message: "only a changed result may name commits",
          input: entry.touchingCommits,
          path: ["entries", index, "touchingCommits"],
        });
      }
      // AND THE MIRROR, which the first draft left out. CCB-3's own text says
      // the test fails if a downgrade "says `changed` naming nothing", because
      // individual commit identity is the whole of AT-2 — the downgrade has to
      // name the commits that caused it.
      //
      // Leaving it out is worse than a mislabel, because of the rule this spec
      // is proudest of: once `changed` is stored, the downgrade-only `setWhere`
      // refuses every honest `unchanged` FOREVER. An evidence-free downgrade
      // therefore removes a claim from the unsolicited substance lane
      // permanently, and the only way back is to author a new claim.
      //
      // It sits inside the spec's own stated threat model. This route is
      // developerAuth, and §3.3 says that key "sits in plaintext in
      // ~/.crosscheck/config.json" where "any agent on the machine can read"
      // it. The whole downgrade-only rule was built around that adversary and
      // the opposite direction was left open: one POST per claim is a silent
      // denial-of-substance primitive against a teammate's whole knowledge
      // base.
      //
      // The rendered sentence was dishonest too. With no names the renderer
      // falls back to "commits have touched these files since" — asserting
      // commits while naming none, and in the measured case while the report's
      // own total said zero.
      if (entry.result === "changed" && entry.touchingCommits.length === 0) {
        ctx.issues.push({
          code: "custom",
          message:
            "a changed result must name at least one commit — a downgrade " +
            "that names nothing cannot be checked and cannot be undone",
          input: entry.touchingCommits,
          path: ["entries", index, "touchingCommits"],
        });
      }
    }
  });

export type ClaimRevalidationEntry = z.infer<typeof ClaimRevalidationEntrySchema>;
export type ClaimRevalidationReport = z.infer<typeof ClaimRevalidationReportSchema>;

/**
 * The derived record every claim-bearing surface carries beside the claim.
 *
 * Shipped rather than recomputed: the hub holds the edges and the
 * revalidation rows, the connector holds neither, and a connector that
 * re-derived a state from three fields would be the second definition this
 * whole spec exists to prevent.
 */
export const ClaimValiditySchema = z.looseObject({
  state: ClaimValidityStateSchema,
  observedAtCommit: z.string().nullable(),
  commitBinding: ClaimCommitBindingSchema,
  basis: ClaimRevalidationBasisSchema.nullable(),
  touchingCommits: z.array(commitSha).max(MAX_CLAIM_TOUCHING_COMMITS).default([]),
  touchingTotal: z.number().int().min(0).nullable().default(null),
  /**
   * THE REF STATE THE READING WAS TAKEN AGAINST, and it has to travel because
   * the sentence built from it would otherwise claim more than was measured.
   *
   * `unchanged` is measured as `<observedAt>..<default ref>` against the
   * remote-tracking ref THIS CLONE HAPPENS TO HOLD. Nothing fetches on the
   * revalidation path and no local signal can date that ref: a freshly cloned
   * repository has neither a reflog for it nor a FETCH_HEAD, so "how stale is
   * this copy" is a question with no honest local answer. Inventing one would
   * be exactly the manufactured evidence principle 5 forbids.
   *
   * What CAN be stated is what was actually compared. The row has carried this
   * column since the feature landed and no surface rendered it, so a reader
   * was told "those files have not changed since" while a teammate's rewrite
   * from this morning sat in a commit the clone had never fetched.
   *
   * Null on a reading whose ref could not be resolved at all.
   *
   * SHA-SHAPED ON THE WIRE, not free text, and the injection corpus is why.
   * Its own note says the validity record's only free-text slot is the claim
   * id — "every other field is an enum, a hex-shaped sha or a small integer,
   * so the claim-id slot is where an attacker would aim". An unbounded string
   * here would have opened a second slot the corpus does not plant in, which
   * is how a corpus goes blind without ever failing.
   */
  refCommit: commitSha.nullable().default(null),
  lastRevalidatedAt: z.string().nullable(),
  supersededByClaimId: z.string().nullable(),
});

export type ClaimValidity = z.infer<typeof ClaimValiditySchema>;
