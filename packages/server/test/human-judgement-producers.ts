/**
 * EVERY PRODUCER OF A HUMAN FIGURE, and how the invariant walks it (human
 * provenance §5; test/human-judgement-invariant.test.ts). The route-walk
 * precedent (test/live-location-routes.ts): a producer added tomorrow cannot
 * pass unwalked — the completeness guard fails on any server source that
 * reads a judgement table and is neither a producer here nor exempted below
 * with its reason.
 *
 * Each producer reads, from a world, the numbers it presents as people's
 * judgement. The invariant seeds the same judgements in every non-human
 * class — the agent's door, the terminal's door, rows from before 0.11 — and
 * requires every one of these to read zero; then confirms them through the
 * real batch ceremony and requires each to read exactly what was confirmed.
 */
import { sql } from "drizzle-orm";

import { readPeriodAggregate } from "../src/services/outcome-population.ts";
import { REPO } from "./fixtures/hint-outcome-world.ts";
import type { OutcomeWorld } from "./fixtures/hint-outcome-world.ts";
import { jsonRequest } from "./helpers.ts";

type Counts = Readonly<Record<string, number>>;

export interface HumanJudgementProducer {
  /** The source module that computes it — the completeness guard matches on this. */
  readonly file: string;
  readonly read: (world: OutcomeWorld) => Promise<Counts>;
}

const DAY_MS = 86_400_000;

const getData = async <T>(world: OutcomeWorld, path: string): Promise<T> => {
  const response = await world.harness.app.request(path, jsonRequest("GET", world.nick.apiKey));
  if (response.status !== 200) {
    throw new Error(`${path} answered ${String(response.status)}`);
  }
  return ((await response.json()) as { data: T }).data;
};

interface Figure {
  readonly kind: string;
  readonly value?: number;
}

interface ReportShape {
  readonly precision: {
    readonly helpful: number;
    readonly noise: number;
    readonly unclear: number;
    readonly reasons: readonly unknown[];
    readonly noisySessionsPer100: Figure;
    readonly surfaceOkMarks: number;
  };
  readonly cohorts: readonly { readonly helpful: number; readonly noise: number; readonly unclear: number }[];
  readonly attribution: { readonly repaired: readonly unknown[] };
}

interface MineShape {
  readonly followed: number;
  readonly overrode: number;
  readonly notRelevantNow: number;
  readonly noise: number;
  readonly helpful: number;
  readonly reasons: readonly unknown[];
}

const report = (world: OutcomeWorld): Promise<ReportShape> =>
  getData<ReportShape>(world, `/api/pilot/report?repo=${encodeURIComponent(REPO)}&days=7`);

const mine = (world: OutcomeWorld): Promise<MineShape> =>
  getData<MineShape>(world, `/api/hint-outcomes/mine?repo=${encodeURIComponent(REPO)}&days=7`);

export const HUMAN_JUDGEMENT_PRODUCERS: Readonly<Record<string, HumanJudgementProducer>> = {
  "proof 4: the labelled figures (precision, benefit, coverage)": {
    file: "src/services/pilot-label-figures.ts",
    read: async (world) => {
      const { precision } = await report(world);
      return { helpful: precision.helpful, noise: precision.noise, unclear: precision.unclear };
    },
  },
  "proof 4: the reasons people typed beside a label": {
    file: "src/services/pilot-label-figures.ts",
    read: async (world) => ({ reasons: (await report(world)).precision.reasons.length }),
  },
  "proof 4: the cohorts, side by side": {
    file: "src/services/pilot-label-figures.ts",
    read: async (world) => ({
      labelled: (await report(world)).cohorts.reduce((sum, cohort) => sum + cohort.helpful + cohort.noise + cohort.unclear, 0),
    }),
  },
  "proof 4: the noisy-sessions floor": {
    file: "src/services/pilot-report.ts",
    read: async (world) => {
      const figure = (await report(world)).precision.noisySessionsPer100;
      return { noisy: figure.kind === "measured" && (figure.value ?? 0) > 0 ? 1 : 0 };
    },
  },
  "proof 4: surface-ok marks (pin --ok)": {
    file: "src/services/pilot-report.ts",
    read: async (world) => ({ surfaceOk: (await report(world)).precision.surfaceOkMarks }),
  },
  "proof 3: attributions scored against a repair": {
    file: "src/services/pilot-report.ts",
    read: async (world) => ({ scored: (await report(world)).attribution.repaired.length }),
  },
  "--mine: what the caller's hints led to": {
    file: "src/services/hint-outcome-view.ts",
    read: async (world) => {
      const view = await mine(world);
      return {
        followed: view.followed,
        overrode: view.overrode,
        notRelevantNow: view.notRelevantNow,
        noise: view.noise,
        helpful: view.helpful,
        reasons: view.reasons.length,
      };
    },
  },
  "the team line and the source credit (one closed period's aggregate)": {
    file: "src/services/outcome-population.ts",
    read: async (world) => {
      const now = world.harness.clock.now();
      const aggregate = await readPeriodAggregate(world.harness.db, {
        repo: REPO,
        from: new Date(now.getTime() - 30 * DAY_MS),
        until: new Date(now.getTime() + DAY_MS),
        who: sql`true`,
        sourceIs: null,
        at: now,
      });
      return {
        followed: aggregate.followed,
        overrode: aggregate.overrode,
        notRelevantNow: aggregate.notRelevantNow,
        noise: aggregate.noise,
        recorders: aggregate.recorders,
      };
    },
  },
};

/**
 * Sources that read a judgement table and produce no human figure — each with
 * why. A new reader must land in one of the two lists.
 */
export const JUDGEMENT_READERS_EXEMPT: Readonly<Record<string, string>> = {
  "src/services/pilot.ts": "the writer of a confirmed label, and the retention prune",
  "src/services/noise-label.ts": "the writer of a confirmed noise label",
  "src/services/hint-outcomes.ts": "the writer of a confirmed outcome",
  "src/services/pins.ts": "the writer of a confirmed pin and break; its reads list pins with their provenance",
  "src/services/pointer-standing.ts": "the write path's own answer (what stands), over confirmed words only",
  "src/services/pilot-candidates.ts": "which deliveries the label walk offers; counts nothing",
  "src/services/retention-registry.ts": "names tables for the retention walk",
  "src/services/draft-apply.ts": "applies a confirmed draft through the writers above",
  "src/services/confirmation-batch.ts": "writes the confirmation and its items",
  "src/services/confirmation-records.ts": "serves a person's own confirmations; counts nothing",
  "src/services/confirmation-rollback.ts": "undoes a void confirmation's effects (round-2 R2-M3); counts nothing",
  "src/services/confirm-page.ts": "says why a decided draft is back on the page (round-2 R2-H3); counts nothing",
  "src/services/human-drafts.ts": "the draft store: whether a draft was decided reads the confirmation items",
  "src/services/human-provenance.ts": "defines the one human predicate every producer above uses",
  "src/routes/pilot.ts": "serves proof 3 and proof 4 as the producers above compute them, beside where confirming is possible",
  "src/routes/hint-outcomes.ts": "serves --mine as the producer above computes it, beside where confirming is possible",
  "src/routes/confirm-status.ts": "the caller's pending drafts and own confirmations; counts no judgement",
};
