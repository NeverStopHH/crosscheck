/**
 * SUBSTANCE ONLY FROM THE BEST MATCH (DESIGN.md §4, hold-out review round 3,
 * H3 + M6). The round-3 hold-out pushed a teammate's finding from the WRONG
 * tree for 12 of 119 task prompts: the selector took the first trusted,
 * strongly matched claim in the hub's order, and the hub's order is search
 * rank, not relevance. So, across all eligible contexts:
 *   - substance comes only from a tree at least as strong (`topicalTerms`, an
 *     exact target first) as the best tree a pointer could name, the hub's
 *     order among equals (its relevance and freshness, §5 stale-vs-fresh),
 *     the claim sharing most topical words within it;
 *   - otherwise the pointer goes to the strongest tree, never the hub's first —
 *     or nothing, when that tree was already shown.
 */
import { describe, expect, test } from "bun:test";

import { selectHint } from "../src/hints/select.ts";
import type { HintClaimCandidate, HintContextCandidate } from "../src/http/hub.ts";

const SELF = "dev_self";
const TEAMMATE = "dev_ken";
const ISO = "2026-09-20T08:00:00.000Z";

const decision = (id: string, workContextId: string, matchedTerms: number): HintClaimCandidate => ({
  id,
  workContextId,
  kind: "decision",
  status: "proposed",
  confidence: 0.8,
  provenance: "declared",
  captureMode: "agent",
  evidenceRefCount: 1,
  evidenceBacked: true,
  authorDeveloperId: TEAMMATE,
  authorDeveloperName: "Ken",
  body: "Keep the previous signing key in the JWKS for a day after every rotation.",
  matchedTerms,
  createdAt: ISO,
});

const observation = (id: string, workContextId: string, matchedTerms: number): HintClaimCandidate => ({
  ...decision(id, workContextId, matchedTerms),
  kind: "observation",
  evidenceRefCount: 0,
  evidenceBacked: false,
  body: "",
});

interface TreeShape {
  readonly treeTerms: number;
  readonly topicalTerms: number;
  readonly tier?: string;
  readonly matchedTargets?: HintContextCandidate["matchedTargets"];
}

const tree = (id: string, claims: readonly HintClaimCandidate[], shape: TreeShape): HintContextCandidate => ({
  workContext: {
    id,
    title: `Tree ${id}`,
    status: "analyzing",
    tier: shape.tier ?? "fts",
    developerId: TEAMMATE,
    developerName: "Ken",
    baseCommit: "a1b2c3d4",
    createdAt: ISO,
    updatedAt: null,
    matchedTerms: shape.treeTerms,
  },
  claims,
  matchedTargets: shape.matchedTargets ?? [],
  matchedOn: "prompt",
  sharedTerms: 2,
  topicalTerms: shape.topicalTerms,
});

const select = (candidates: readonly HintContextCandidate[], seenRefIds: readonly string[] = []) =>
  selectHint({ candidates, seenRefIds, deliveredCount: seenRefIds.length, selfDeveloperId: SELF, promptTerms: [], promptTopicalTerms: [] });

const pickedId = (candidates: readonly HintContextCandidate[], seenRefIds: readonly string[] = []): string => {
  const selection = select(candidates, seenRefIds);
  return selection.kind === "claim"
    ? selection.claim.id
    : selection.kind === "pointer"
      ? `pointer:${selection.context.workContext.id}`
      : "silence";
};

describe("substance comes from the strongest topical match, not the hub's first (H3 + M6)", () => {
  test("two strongly matched decisions: the one whose tree shares more topical words wins", () => {
    // Arrange — t004's shape: the hub ranked the rate-limit tree first
    const rate = tree("wc_rate", [decision("clm_rate", "wc_rate", 2)], { treeTerms: 0, topicalTerms: 2 });
    const jwt = tree("wc_jwt", [decision("clm_jwt", "wc_jwt", 2)], { treeTerms: 4, topicalTerms: 4 });

    // Act + Assert
    expect(pickedId([rate, jwt])).toBe("clm_jwt");
  });

  test("a tie keeps the hub's order", () => {
    const first = tree("wc_a", [decision("clm_a", "wc_a", 2)], { treeTerms: 2, topicalTerms: 2 });
    const second = tree("wc_b", [decision("clm_b", "wc_b", 2)], { treeTerms: 2, topicalTerms: 2 });
    expect(pickedId([first, second])).toBe("clm_a");
  });
});

describe("a substance tree must be at least as strong as the best pointer (H3 + M6)", () => {
  test("a finding from a weaker tree is refused, and the pointer goes to the stronger one", () => {
    // Arrange — t128's shape: the CI tree's decision shares two words, but the
    // PGlite tree's rejected approach shares four
    const ci = tree("wc_ci", [decision("clm_ci", "wc_ci", 2)], { treeTerms: 0, topicalTerms: 2 });
    const pglite = tree("wc_pglite", [observation("clm_pp", "wc_pglite", 4)], { treeTerms: 2, topicalTerms: 4 });

    // Act + Assert
    expect(pickedId([ci, pglite])).toBe("pointer:wc_pglite");
  });

  test("an exact target is the strongest match there is", () => {
    // Arrange — the prompt named a file the second tree touched
    const words = tree("wc_words", [decision("clm_words", "wc_words", 3)], { treeTerms: 3, topicalTerms: 5 });
    const named = tree("wc_named", [observation("clm_named", "wc_named", 0)], {
      treeTerms: 0,
      topicalTerms: 0,
      tier: "exact",
      matchedTargets: [{ kind: "file", value: "src/auth/jwks.ts", createdAt: ISO }],
    });

    // Act + Assert
    expect(pickedId([words, named])).toBe("pointer:wc_named");
  });
});

describe("the pointer names the strongest tree, or nothing (H3 + M6)", () => {
  test("the strongest tree, not the hub's first", () => {
    // Arrange — t006's shape: the dashboard tree ranked first on one word
    const dashboard = tree("wc_dashboard", [observation("clm_d", "wc_dashboard", 1)], { treeTerms: 1, topicalTerms: 1 });
    const banner = tree("wc_banner", [observation("clm_b", "wc_banner", 3)], { treeTerms: 3, topicalTerms: 3 });

    // Act + Assert
    expect(pickedId([dashboard, banner])).toBe("pointer:wc_banner");
  });

  test("once the strongest tree was shown, a weaker one is not pointed at instead", () => {
    const dashboard = tree("wc_dashboard", [observation("clm_d", "wc_dashboard", 1)], { treeTerms: 1, topicalTerms: 1 });
    const banner = tree("wc_banner", [observation("clm_b", "wc_banner", 3)], { treeTerms: 3, topicalTerms: 3 });
    expect(pickedId([dashboard, banner], ["wc_banner"])).toBe("silence");
  });

  test("a hub too old to send the strength keeps its own order", () => {
    // Arrange — no topicalTerms on either: every tree is equally strong
    const { topicalTerms: _first, ...first } = tree("wc_a", [observation("clm_a", "wc_a", 1)], { treeTerms: 1, topicalTerms: 1 });
    const { topicalTerms: _second, ...second } = tree("wc_b", [observation("clm_b", "wc_b", 3)], { treeTerms: 3, topicalTerms: 3 });

    // Act + Assert
    expect(pickedId([first, second])).toBe("pointer:wc_a");
  });
});
