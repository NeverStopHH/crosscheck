/**
 * THE HUB'S FLOOR AND THE CONNECTOR'S RECOUNT GIVE THE SAME VERDICTS (DESIGN.md
 * §4; hold-out review round 3, follow-up). Against a hub too old to count —
 * 0.10.0 — the connector recounts the floor itself, and the two used to
 * drift: the recount matched as written, knew no long-prompt floor and took
 * "shows" for a topic. Both now call one function (`@crosscheck/schema`
 * content-floor.ts); this pins everything AROUND it — which terms each side
 * counts, which it knows, which statements it reads — by running every row of
 * the corpus gate through both, against every corpus tree:
 *
 *   - the HUB'S floor: the seeded corpus hub's own services, its database
 *     deciding which words are known and which claims are visible;
 *   - the CONNECTOR'S recount: the same trees as an old hub ships them, every
 *     claim on the wire, drafts included — the recount must refuse those
 *     itself.
 *
 * One deliberate equality: 0.10.0's wire carries no description, so each
 * tree's title here carries its description too — this test compares the
 * RULE and its inputs, not what an old hub chose to send.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { contentFloorOf, hubFloorTermsOf } from "@crosscheck/server";
import { HINT_MIN_SHARED_TERMS, humanPromptText, promptTerms, statementMatch } from "@crosscheck/schema";

import { CORPUS_TREES, PROMPT_CORPUS } from "../../schema/test/fixtures/prompt-corpus.ts";
import type { CorpusTree } from "../../schema/test/fixtures/prompt-corpus.ts";
import { clearsRecountedFloor, recountFloorTermsOf } from "../src/hints/select.ts";
import type { HintClaimCandidate, HintContextCandidate } from "../src/http/hub.ts";
import { CORPUS_REPO_ID, startCorpusHub } from "./fixtures/corpus-hub.ts";
import type { CorpusHub } from "./fixtures/corpus-hub.ts";

const SEEDED_AT = "2026-10-05T10:00:00.000Z";
const OWNER_ID = "dev_ken";

/** One claim of a corpus tree, as an old hub ships it. */
const wireClaim = (tree: CorpusTree, body: string, index: number, provenance: "declared" | "derived"): HintClaimCandidate => ({
  id: `clm_${tree.id}_${provenance}_${String(index)}`,
  workContextId: tree.id,
  kind: "observation",
  status: "proposed",
  confidence: provenance === "declared" ? 0.6 : 0.4,
  provenance,
  captureMode: provenance === "declared" ? "agent" : "auto",
  evidenceRefCount: 0,
  authorDeveloperId: OWNER_ID,
  authorDeveloperName: "Ken",
  body,
  createdAt: SEEDED_AT,
});

/** A corpus tree as an old hub ships it: no counts, every claim, drafts too — the statement the hub counts as its title. */
const oldHubCandidate = (tree: CorpusTree): HintContextCandidate => ({
  workContext: {
    id: tree.id,
    title: `${tree.title} ${tree.description}`,
    status: "analyzing",
    tier: "fts",
    developerId: OWNER_ID,
    developerName: "Ken",
    baseCommit: "a1b2c3d4",
    createdAt: SEEDED_AT,
    updatedAt: null,
  },
  claims: [
    ...tree.claims.map((body, index) => wireClaim(tree, body, index, "declared")),
    ...(tree.drafts ?? []).map((body, index) => wireClaim(tree, body, index, "derived")),
  ],
  matchedTargets: [],
  matchedOn: "prompt",
});

/** What one row's floor says of every tree: the trees that clear, and each tree's floor count. */
interface Verdicts {
  readonly clearing: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
}

interface RowParity {
  readonly prompt: string;
  readonly hub: Verdicts;
  readonly connector: Verdicts;
}

let hub: CorpusHub;
let parity: readonly RowParity[];
let contentFree: number;

const verdictsOf = (counts: Readonly<Record<string, number>>): Verdicts => ({
  clearing: Object.keys(counts).filter((id) => (counts[id] ?? 0) >= HINT_MIN_SHARED_TERMS).sort(),
  counts,
});

beforeAll(async () => {
  hub = await startCorpusHub();
  const treeIds = CORPUS_TREES.map((tree) => tree.id);
  const candidates = CORPUS_TREES.map(oldHubCandidate);
  const rows = PROMPT_CORPUS.map((row) => ({ prompt: row.prompt, terms: promptTerms(humanPromptText(row.prompt)) }));
  contentFree = rows.filter((row) => row.terms.isContentFree).length;
  const collected: RowParity[] = [];
  for (const { prompt, terms } of rows.filter((row) => !row.terms.isContentFree)) {
    const hubFloors = await contentFloorOf(hub.db, hub.readerId, await hubFloorTermsOf(hub.db, CORPUS_REPO_ID, terms), treeIds);
    const recount = recountFloorTermsOf({
      candidates,
      seenRefIds: [],
      deliveredCount: 0,
      selfDeveloperId: hub.readerId,
      promptTerms: terms.ranked,
      promptTopicalTerms: terms.topical,
    });
    const connectorCounts = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.workContext.id,
        clearsRecountedFloor(candidate, hub.readerId, recount)
          ? Math.max(
              ...[candidate.workContext.title, ...candidate.claims.filter((member) => member.provenance === "declared").map((member) => member.body)].map(
                (statement) => statementMatch(recount, statement).floor,
              ),
            )
          : 0,
      ]),
    );
    const hubCounts = Object.fromEntries(
      treeIds.map((id) => {
        const shared = hubFloors.get(id)?.sharedTerms ?? 0;
        return [id, shared >= HINT_MIN_SHARED_TERMS ? shared : 0];
      }),
    );
    collected.push({ prompt, hub: verdictsOf(hubCounts), connector: verdictsOf(connectorCounts) });
  }
  parity = collected;
  console.log(
    `floor parity: ${String(parity.length)} rows compared against ${String(treeIds.length)} trees (${String(contentFree)} content-free rows never reach a floor); ` +
      `${String(parity.filter((row) => row.hub.clearing.length > 0).length)} clear some tree on the hub`,
  );
}, 300_000);

afterAll(() => {
  hub.stop();
});

describe("the hub's floor and the connector's recount, row by row, tree by tree", () => {
  test("every corpus row that reaches a floor is compared, and many clear one", () => {
    expect(parity.length + contentFree).toBe(PROMPT_CORPUS.length);
    expect(parity.filter((row) => row.hub.clearing.length > 0).length).toBeGreaterThan(50);
  });

  test("the same trees clear on both sides", () => {
    const differing = parity
      .filter((row) => row.hub.clearing.join(",") !== row.connector.clearing.join(","))
      .map((row) => ({ prompt: row.prompt, hub: row.hub.clearing, connector: row.connector.clearing }));
    expect(differing).toEqual([]);
  });

  test("with the same floor count on every tree that clears", () => {
    const differing = parity
      .filter((row) => row.hub.clearing.some((id) => row.hub.counts[id] !== row.connector.counts[id]))
      .map((row) => ({ prompt: row.prompt, hub: row.hub.counts, connector: row.connector.counts }));
    expect(differing).toEqual([]);
  });
});
