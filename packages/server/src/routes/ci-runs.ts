/**
 * /api/ci-runs — what CI saw, keyed to a commit (spec 05 §3.7).
 *
 *   POST /api/ci-runs                    a reporter files one run  (CI token)
 *   GET  /api/ci-runs?repo=&commit=      what this hub holds       (any member)
 *   GET  /api/ci-runs/verdict?…          what it MEANS             (any member)
 *
 * THE VERDICT IS THE HUB'S, NOT THE CALLER'S. The raw route above hands back
 * runs and rows, and a connector could in principle count them itself — which
 * is exactly what must not happen. `ciBehaviorDeltas` is a five-rung ladder
 * whose ORDER is the contract, and a second implementation anywhere would be a
 * second ladder with none of its refusals. One authority, one answer, and the
 * reason travels with it.
 *
 * A ROUTE OF ITS OWN, NOT A RECORD KIND, and the reason is a refusal rather
 * than a convenience. `/api/records` carries an envelope, and an envelope
 * requires a producer: a developer, an agent kind and a session. CI has none
 * of the three. Minting a synthetic session so a CI report could travel that
 * road would put a teammate in the graph who does not exist — the phantom
 * teammate the absence machinery must never invent, because every "who was
 * working on this" answer would then include a robot nobody can ask.
 *
 * WRITE IS A TOKEN, READ IS A MEMBER — the team-settings asymmetry, and here
 * it carries an extra argument. The write token is NOT the admin token: that
 * one also flips `pin_policy` and `suspect_attribution`, and a CI secret is
 * readable by every workflow in the repository. One token, one capability.
 * Read is open because a coverage qualifier nobody can look behind is a
 * qualifier nobody can check.
 */
import { Hono } from "hono";
import { z } from "zod";
import { CiRunReportSchema, MAX_CI_LANE_FIELD_CHARS } from "@crosscheck/schema";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import { developerAuth, requireCiToken } from "../middleware/auth.ts";
import { readCiCoverage } from "../services/ci-coverage.ts";
import { ciBehaviorDeltas } from "../services/ci-delta.ts";
import {
  ingestCiRun,
  readCiRuns,
  readCiTestResults,
} from "../services/ci-runs.ts";
import type { AppDeps, AppEnv } from "../types.ts";

const ReadQuerySchema = z.object({
  repo: z.string().min(1),
  commit: z.string().min(1),
});

/**
 * The verdict query, which additionally needs the caller's idea of the
 * repository's default branch.
 *
 * THE HUB HOLDS NO REPOSITORY, so it cannot know which ref is default and must
 * not guess — inferring it from whichever ref reported most would be a second
 * unverifiable label. The caller has a clone and knows. It is used only to
 * borrow a base window when a feature branch has none of its own, and every
 * delta says whether it borrowed (`baseWindowSource`), so a reader who
 * disagrees with the caller's answer can see that it was used.
 */
const VerdictQuerySchema = ReadQuerySchema.extend({
  defaultRef: z.string().min(1).max(MAX_CI_LANE_FIELD_CHARS).default("main"),
});

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_CONFLICT = 409;

export const ciRunsRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();

  router.post("/", requireCiToken(deps.ciToken), async (c) => {
    const parsed = CiRunReportSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const outcome = await ingestCiRun(deps, parsed.data);
    if (outcome.status === "rejected") {
      // 409, not 400: the body is well formed and the refusal is about the
      // hub's own state — the named target run is absent, or belongs to a
      // different lane. A reporter that retried on 400 would retry forever.
      return fail(
        c,
        HTTP_CONFLICT,
        "ci_run_rejected",
        outcome.issues?.join("; ") ?? "rejected",
      );
    }
    return ok(
      c,
      { id: outcome.id, status: outcome.status },
      outcome.status === "accepted" ? HTTP_CREATED : HTTP_OK,
    );
  });

  router.get("/", developerAuth(deps), async (c) => {
    const parsed = ReadQuerySchema.safeParse({
      repo: c.req.query("repo"),
      commit: c.req.query("commit"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const runs = await readCiRuns(deps.db, parsed.data.repo, parsed.data.commit);
    return ok(c, {
      runs: await Promise.all(
        runs.map(async (run) => ({
          ...run,
          startedAt: run.startedAt.toISOString(),
          collectedAt: run.collectedAt.toISOString(),
          results: await readCiTestResults(deps.db, run.id),
        })),
      ),
    });
  });

  /**
   * Coverage plus one delta per non-green test, for one commit.
   *
   * BOTH IN ONE ANSWER, because they are read together and separately they
   * mislead. A `confirmed` delta beside `coverage: incomplete` means something
   * different from the same delta beside `complete` — in the first, lanes this
   * hub expected never reported, so the run that confirmed it may not be the
   * whole story. Two calls would let a surface render one without the other.
   */
  router.get("/verdict", developerAuth(deps), async (c) => {
    const parsed = VerdictQuerySchema.safeParse({
      repo: c.req.query("repo"),
      commit: c.req.query("commit"),
      defaultRef: c.req.query("defaultRef") ?? undefined,
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const { repo, commit, defaultRef } = parsed.data;
    const now = deps.now();
    const coverage = await readCiCoverage({
      db: deps.db,
      repo,
      commitSha: commit,
      defaultRef,
      now,
    });
    // ONE DELTA LIST PER LANE, flattened. The lanes come from the runs this
    // commit actually has; a lane that never reported has no non-green test to
    // have a verdict about, and its silence is what `coverage` reports.
    const runs = await readCiRuns(deps.db, repo, commit);
    const lanes = new Map<string, { provider: string; workflow: string; job: string; leg: string; ref: string }>();
    for (const run of runs) {
      if (run.rerunKind !== "none") {
        continue;
      }
      lanes.set(
        `${run.provider}\u0000${run.workflow}\u0000${run.job}\u0000${run.leg}\u0000${run.ref}`,
        run,
      );
    }
    const deltas = [];
    for (const lane of lanes.values()) {
      deltas.push(
        ...(await ciBehaviorDeltas({
          db: deps.db,
          lane: {
            repo,
            provider: lane.provider as "github_actions",
            workflow: lane.workflow,
            job: lane.job,
            leg: lane.leg,
            ref: lane.ref,
          },
          defaultRef,
          commitSha: commit,
          now,
        })),
      );
    }
    return ok(c, { coverage, deltas });
  });

  return router;
};
