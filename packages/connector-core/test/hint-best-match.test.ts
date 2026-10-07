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

/** A trusted decision; every word it shares is its own unless said otherwise (C2). */
const decision = (id: string, workContextId: string, matchedTerms: number, distinctTerms = matchedTerms): HintClaimCandidate => ({
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
  distinctTerms,
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

  test("a tie says nothing — round 4, C2: the hub's order between equals is search rank, not relevance", () => {
    const first = tree("wc_a", [decision("clm_a", "wc_a", 2)], { treeTerms: 2, topicalTerms: 2 });
    const second = tree("wc_b", [decision("clm_b", "wc_b", 2)], { treeTerms: 2, topicalTerms: 2 });
    expect(pickedId([first, second])).toBe("silence");
  });
});

/**
 * STRICT SUBSTANCE (round 4, C2): the round-4 hold-out still showed 9 of 182
 * tasks a finding from another tree. A finding is shown only from the ONE
 * strongest tree, when the claim shares two topical words, one of which no
 * other candidate says, and the tree's own statement shares one; otherwise a
 * pointer at that tree — and nothing at all on a tie.
 */
describe("a finding only from the one strongest tree, on a word only it says (C2)", () => {
  test("every word the finding shares, another candidate says too: a pointer at its tree", () => {
    // Arrange — K063's shape: invoice and pdf, said by the labels tree as well
    const timeout = tree("wc_timeout", [decision("clm_t", "wc_timeout", 2, 0)], { treeTerms: 3, topicalTerms: 3 });
    const labels = tree("wc_labels", [observation("clm_l", "wc_labels", 2)], { treeTerms: 2, topicalTerms: 2 });

    // Act + Assert
    expect(pickedId([timeout, labels])).toBe("pointer:wc_timeout");
  });

  test("a tree whose own statement shares nothing lends no finding, however well the claim matches", () => {
    const notes = tree("wc_notes", [decision("clm_n", "wc_notes", 3)], { treeTerms: 0, topicalTerms: 3 });
    expect(pickedId([notes])).toBe("pointer:wc_notes");
  });

  test("one shared word is no finding, however strong its tree", () => {
    const strong = tree("wc_strong", [decision("clm_s", "wc_strong", 1)], { treeTerms: 4, topicalTerms: 4 });
    expect(pickedId([strong])).toBe("pointer:wc_strong");
  });

  test("a tie at the top: no finding and no pointer, however strict the claims", () => {
    const first = tree("wc_a", [decision("clm_a", "wc_a", 3)], { treeTerms: 3, topicalTerms: 3 });
    const second = tree("wc_b", [decision("clm_b", "wc_b", 3)], { treeTerms: 3, topicalTerms: 3 });
    expect(pickedId([first, second])).toBe("silence");
  });

  test("round 4, M1: on equal counts, the tree whose own statement shares more is the one strongest", () => {
    // Arrange — "Retry-Limit im Checkout erhöhen": a claim of each tree shares
    // two words, the checkout-retries tree's own title both of them
    const usage = tree("wc_usage", [observation("clm_u", "wc_usage", 2)], { treeTerms: 1, topicalTerms: 2 });
    const checkout = tree("wc_checkout", [decision("clm_c", "wc_checkout", 2)], { treeTerms: 2, topicalTerms: 2 });

    // Act + Assert
    expect(pickedId([usage, checkout])).toBe("clm_c");
  });

  test("a tie below the top is no tie", () => {
    const top = tree("wc_top", [decision("clm_top", "wc_top", 3)], { treeTerms: 3, topicalTerms: 4 });
    const first = tree("wc_a", [observation("clm_a", "wc_a", 2)], { treeTerms: 2, topicalTerms: 2 });
    const second = tree("wc_b", [observation("clm_b", "wc_b", 2)], { treeTerms: 2, topicalTerms: 2 });
    expect(pickedId([first, second, top])).toBe("clm_top");
  });

  test("a hub that does not say how many words are the claim's own buys no finding", () => {
    // Arrange — a round-4 hub: matchedTerms, but no distinctTerms
    const { distinctTerms: _distinct, ...claim } = decision("clm_old", "wc_old", 3);
    const old = tree("wc_old", [claim], { treeTerms: 3, topicalTerms: 3 });

    // Act + Assert
    expect(pickedId([old])).toBe("pointer:wc_old");
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

  test("a hub too old to send the strength: trees the recount finds equally strong are a tie, and a tie says nothing (C2)", () => {
    // Arrange — no counts on either, as a 0.10.0 hub sends them, and no prompt word to recount on
    const oldHub = (candidate: HintContextCandidate): HintContextCandidate => {
      const { topicalTerms: _strength, ...rest } = candidate;
      const { matchedTerms: _own, ...workContext } = candidate.workContext;
      return { ...rest, workContext };
    };
    const first = oldHub(tree("wc_a", [observation("clm_a", "wc_a", 1)], { treeTerms: 1, topicalTerms: 1 }));
    const second = oldHub(tree("wc_b", [observation("clm_b", "wc_b", 3)], { treeTerms: 3, topicalTerms: 3 }));

    // Act + Assert
    expect(pickedId([first, second])).toBe("silence");
  });
});
