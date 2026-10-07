/**
 * SUBSTANCE ONLY FROM A STRONG, TOPICAL MATCH, decided on the hub too
 * (hold-out review round 3, H3 + M6). The round-3 hold-out's t004 — "token
 * refresh fails after key rotation" — pushed the rate-limit tree's decision
 * "Use a token bucket per API key …" as a teammate's finding: "token" is a
 * meta word, so the decision shares ONE topical word, and its tree one more.
 *
 * So every count the selector judges relevance on is TOPICAL — the claim's
 * shown sentence (`matchedTerms`), the tree's own statement
 * (`workContext.matchedTerms`), and the tree's best statement (`topicalTerms`,
 * what a pointer's strength is compared on) — and the hub WITHHOLDS a body
 * whose own strong-match test fails, so a connector older than the selector's
 * best-match rule (0.10.0) has no wrong-tree finding to inline.
 *
 * SINCE ROUND 4 (M1) a meta word of a task IS topical — "token" is what the
 * prompt is about — and what keeps the rate-limit decision out is C2: the
 * JWT tree is the one strongest, and every word the rate decision shares,
 * the JWT tree says too.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";

const PROMPT = "token refresh fails after key rotation";
const JWT_TREE = "wc_jwt";
const RATE_TREE = "wc_rate";
const NOTES_TREE = "wc_notes";
const CRASH_TREE = "wc_crash";
const FINGERPRINT = `sha256:${"9c1e".repeat(16)}`;

interface WireClaim {
  readonly id: string;
  readonly body: string;
  readonly matchedTerms?: number;
  readonly distinctTerms?: number;
}

interface WireCandidate {
  readonly workContext: { readonly id: string; readonly matchedTerms?: number };
  readonly claims: readonly WireClaim[];
  readonly topicalTerms?: number;
}

/** The two round-3 trees and the notes tree, Nick's, and Robin asking — the notes tree left out on request. */
const candidates = async (withNotes = true): Promise<ReadonlyMap<string, WireCandidate>> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const records = [
    recordEnvelope("work_context", validWorkContextBody({ id: JWT_TREE, title: "JWT token refresh fails after signing key rotation", description: "Auth" })),
    recordEnvelope("claim", validClaimBody({ id: "clm_jwt_obs", workContextId: JWT_TREE, body: "Every access token refresh fails with invalid signature for ten minutes after a key rotation." })),
    recordEnvelope("claim", validClaimBody({ id: "clm_jwt_dec", workContextId: JWT_TREE, kind: "decision", evidenceRefs: ["clm_jwt_obs"], body: "Keep the previous signing key in the JWKS for 24 hours after every rotation." })),
    recordEnvelope(
      "work_context",
      validWorkContextBody({
        id: RATE_TREE,
        title: "Rate limiting middleware for the public API",
        description: "Gateway",
        intent: { summary: "Add per-key rate limiting to the public API", provenance: "declared", confidence: 0.9, capturedAt: "2026-09-20T08:00:00.000Z" },
      }),
    ),
    recordEnvelope("claim", validClaimBody({ id: "clm_rate_obs", workContextId: RATE_TREE, body: "Public API traffic spikes to 2000 requests per minute from a single key." })),
    recordEnvelope("claim", validClaimBody({ id: "clm_rate_dec", workContextId: RATE_TREE, kind: "decision", evidenceRefs: ["clm_rate_obs"], body: "Use a token bucket per API key with 100 requests per minute." })),
    // A tree whose own statement says nothing, and one claim that says it all
    ...(withNotes
      ? [
          recordEnvelope("work_context", validWorkContextBody({ id: NOTES_TREE, title: "Investigation notes", description: "Scratch" })),
          recordEnvelope("claim", validClaimBody({ id: "clm_notes_obs", workContextId: NOTES_TREE, body: "The refresh fails right after every key rotation." })),
        ]
      : []),
  ];
  const seeded = await postRecords(harness, nick, { records });
  expect(seeded.data?.accepted).toBe(records.length);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: PROMPT });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly WireCandidate[] } };
  return new Map(body.data.candidates.map((candidate) => [candidate.workContext.id, candidate]));
};

const claimOf = (candidate: WireCandidate | undefined, id: string): WireClaim | undefined =>
  candidate?.claims.find((claim) => claim.id === id);

describe("every relevance count is topical (H3 + M6) — a task's meta words included (round 4, M1)", () => {
  test("a claim's count takes the meta words a task shares", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert — the rate decision shares token and key, the JWT decision key and rotation
    expect(claimOf(byTree.get(RATE_TREE), "clm_rate_dec")?.matchedTerms).toBe(2);
    expect(claimOf(byTree.get(JWT_TREE), "clm_jwt_dec")?.matchedTerms).toBe(2);
  });

  test("a tree's own count takes them too", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert — token, refresh, fails, key, rotation: "refresh" is its own
    // lexeme, no inflection of the meta word "refreshed" (M1)
    expect(byTree.get(JWT_TREE)?.workContext.matchedTerms).toBe(5);
    expect(byTree.get(RATE_TREE)?.workContext.matchedTerms).toBe(1);
  });

  test("each candidate carries its best statement's topical count, the strength a pointer is compared on", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert
    expect(byTree.get(JWT_TREE)?.topicalTerms).toBe(5);
    expect(byTree.get(RATE_TREE)?.topicalTerms).toBe(2);
  });

  test("a tree's strength counts its claims too, not only its own statement", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert — "Investigation notes" shares nothing; its claim shares refresh, fails, key, rotation
    expect(byTree.get(NOTES_TREE)?.workContext.matchedTerms).toBe(0);
    expect(byTree.get(NOTES_TREE)?.topicalTerms).toBe(4);
  });
});

describe("the hub withholds a body its own strong-match test refuses (H3 + M6)", () => {
  test("the rate-limit decision, trusted but weakly matched, travels without its body", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert — a 0.10.0 connector has no wrong-tree finding to inline
    expect(claimOf(byTree.get(RATE_TREE), "clm_rate_dec")?.body).toBe("");
  });

  test("the control: the JWT decision, strongly matched in the one strongest tree, carries its body", async () => {
    // Arrange + Act — without the notes tree, which ties the JWT tree (C2)
    const byTree = await candidates(false);

    // Assert — key and rotation; the rate tree says key, never rotation
    expect(claimOf(byTree.get(JWT_TREE), "clm_jwt_dec")?.distinctTerms).toBe(1);
    expect(claimOf(byTree.get(JWT_TREE), "clm_jwt_dec")?.body.length ?? 0).toBeGreaterThan(0);
  });

  test("C2: beside the notes tree, which says key and rotation too, the JWT decision ships no body", async () => {
    // Arrange + Act
    const byTree = await candidates();

    // Assert — the JWT tree is still the one strongest, but the decision says
    // no word the other candidates do not
    expect(byTree.get(JWT_TREE)?.topicalTerms).toBeGreaterThan(byTree.get(NOTES_TREE)?.topicalTerms ?? 0);
    expect(claimOf(byTree.get(JWT_TREE), "clm_jwt_dec")?.distinctTerms).toBe(0);
    expect(claimOf(byTree.get(JWT_TREE), "clm_jwt_dec")?.body).toBe("");
  });

  test("an error fingerprint the prompt carried is content identity: the body ships without a shared word", async () => {
    // Arrange — the crash tree's decision shares no word with the prompt
    const { harness, developer: nick } = await createHarnessWithSession();
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ id: CRASH_TREE, title: "Exporter crash", description: "Nightly" })),
      recordEnvelope("target", { workContextId: CRASH_TREE, kind: "error_fingerprint", value: FINGERPRINT }),
      recordEnvelope("claim", validClaimBody({ id: "clm_crash_obs", workContextId: CRASH_TREE, body: "The exporter crashes when the bucket name is read before the config loads." })),
      recordEnvelope("claim", validClaimBody({ id: "clm_crash_dec", workContextId: CRASH_TREE, kind: "decision", evidenceRefs: ["clm_crash_obs"], body: "Load the bucket configuration before the exporter starts its first upload." })),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: `${FINGERPRINT} again in the nightly job` });

    // Act
    const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
    const body = (await response.json()) as { data: { candidates: readonly WireCandidate[] } };
    const crash = body.data.candidates.find((candidate) => candidate.workContext.id === CRASH_TREE);

    // Assert
    expect(claimOf(crash, "clm_crash_dec")?.matchedTerms).toBe(0);
    expect(claimOf(crash, "clm_crash_dec")?.body.length ?? 0).toBeGreaterThan(0);
  });
});

/**
 * THE BOUND KEEPS THE STRONGEST (round 4, M1): since a task's meta words
 * count, more trees clear the floor, and the hub cut the qualified pool to
 * HINT_MAX_CONTEXTS in SEARCH order — so "limit ist wieder da. Kannst du
 * jetzt den session timeout im workbench fixen?" lost the session-timeout
 * tree, the one strongest, to three trees that ranked above it on a word
 * repeated. The bound now keeps the strongest candidates.
 */
describe("the hub's bound keeps the strongest candidates, not the search's first (M1)", () => {
  /** Long enough ago for the search's 14-day half-life to rank a tree below any fresh one. */
  const OLD_ISO = new Date(Date.now() - 200 * 24 * 3_600_000).toISOString();

  test("a tree sharing three words outlives three that repeat two", async () => {
    // Arrange — three trees whose claim repeats two of the words, one that says all three once
    const { harness, developer: nick } = await createHarnessWithSession();
    const repeat = "Zebra quokka zebra quokka zebra quokka zebra quokka zebra quokka.";
    const records = [
      ...["wc_rep_a", "wc_rep_b", "wc_rep_c"].flatMap((id) => [
        recordEnvelope("work_context", validWorkContextBody({ id, title: `Notes ${id}`, description: "Scratch" })),
        recordEnvelope("claim", validClaimBody({ id: `clm_${id}`, workContextId: id, body: repeat })),
      ]),
      // … and older by far, so the search's freshness decay ranks it last
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_all_three", title: "Notes on the enclosure", description: "Scratch", createdAt: OLD_ISO })),
      recordEnvelope("claim", validClaimBody({ id: "clm_all_three", workContextId: "wc_all_three", body: "The zebra, the quokka and the narwhal share one enclosure.", createdAt: OLD_ISO })),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: "zebra quokka narwhal" });

    // Act
    const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
    const body = (await response.json()) as { data: { candidates: readonly WireCandidate[] } };

    // Assert — the strongest first, and kept
    expect(body.data.candidates.map((candidate) => candidate.workContext.id)[0]).toBe("wc_all_three");
    expect(body.data.candidates).toHaveLength(3);
  });

  test("on equal topical counts, the tree that shares more words — weak ones among them — comes first (decision 3)", async () => {
    // Arrange — both titles say invoice, pdf, rendering and fails; the older one, which the
    // search's decay ranks second, says "new users" too
    const { harness, developer: nick } = await createHarnessWithSession();
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_safari", title: "Invoice PDF rendering fails in Safari", description: "Browser" })),
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_new_users", title: "Invoice PDF rendering fails for new users", description: "Signup", createdAt: OLD_ISO })),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: "invoice pdf rendering fails for new users" });

    // Act
    const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
    const body = (await response.json()) as { data: { candidates: readonly WireCandidate[] } };

    // Assert
    expect(body.data.candidates.map((candidate) => candidate.workContext.id)).toEqual(["wc_new_users", "wc_safari"]);
  });

  test("on equal counts, the tree whose own statement says the prompt is the one strongest, and its finding ships", async () => {
    // Arrange — a claim of each shares three words; only the render tree's title says any
    const { harness, developer: nick } = await createHarnessWithSession();
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_render", title: "Invoice PDF rendering", description: "Billing" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_render_obs", workContextId: "wc_render", body: "Puppeteer stalls on the first page." })),
      recordEnvelope("claim", validClaimBody({ id: "clm_render_dec", workContextId: "wc_render", kind: "decision", evidenceRefs: ["clm_render_obs"], body: "Rendering fails when the PDF font is missing." })),
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_scratch", title: "Scratch notes", description: "Misc" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_scratch", workContextId: "wc_scratch", body: "Dutch customers see the invoice twice." })),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: "invoice pdf rendering fails for dutch customers" });

    // Act
    const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
    const body = (await response.json()) as { data: { candidates: readonly WireCandidate[] } };
    const byTree = new Map(body.data.candidates.map((candidate) => [candidate.workContext.id, candidate]));

    // Assert — three each on the best statement; the render tree's title says three, the scratch tree's none
    expect(byTree.get("wc_render")?.topicalTerms).toBe(byTree.get("wc_scratch")?.topicalTerms);
    expect(claimOf(byTree.get("wc_render"), "clm_render_dec")?.body.length ?? 0).toBeGreaterThan(0);
  });
});

/**
 * STRICT SUBSTANCE (round 4, C2): a body ships only from the ONE strongest
 * candidate, when the claim shares two topical words, one of which no other
 * candidate tree says, and its tree's own statement shares one. The round-4
 * hold-out's "invoice pdf timeout" was shown the PDF-labels tree's cause on
 * the two words the timeout tree's title says as well.
 */
describe("the hub ships a body only from the one strongest tree, on a word only it says (C2)", () => {
  // "german" is a conversation word ("auf deutsch", "in german"): Dutch is topical
  const STRICT_PROMPT = "invoice pdf rendering fails for dutch customers on staging";
  const INVOICE_TREE = "wc_invoice";
  const LABELS_TREE = "wc_labels";
  const TOTALS_TREE = "wc_totals";

  /** The invoice tree (4 words on its title) beside the labels tree (3), and a tie on request. */
  const strictWorld = async (withTie: boolean): Promise<ReadonlyMap<string, WireCandidate>> => {
    const { harness, developer: nick } = await createHarnessWithSession();
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ id: INVOICE_TREE, title: "Invoice PDF rendering fails under load", description: "Billing" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_inv_obs", workContextId: INVOICE_TREE, body: "Puppeteer renders each invoice PDF in a fresh browser." })),
      recordEnvelope("claim", validClaimBody({ id: "clm_inv_shared", workContextId: INVOICE_TREE, kind: "decision", evidenceRefs: ["clm_inv_obs"], body: "Dutch customers get the invoice from a cached template." })),
      recordEnvelope("claim", validClaimBody({ id: "clm_inv_own", workContextId: INVOICE_TREE, kind: "decision", evidenceRefs: ["clm_inv_obs"], body: "Rendering fails when the PDF font is missing." })),
      recordEnvelope("work_context", validWorkContextBody({ id: LABELS_TREE, title: "Dutch labels on staging invoices", description: "Locale" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_lab_obs", workContextId: LABELS_TREE, body: "Staging customers see Dutch labels from the locale cache." })),
      recordEnvelope("claim", validClaimBody({ id: "clm_lab_dec", workContextId: LABELS_TREE, kind: "decision", evidenceRefs: ["clm_lab_obs"], body: "Staging customers need the Dutch locale bundle." })),
      ...(withTie
        ? [
            recordEnvelope("work_context", validWorkContextBody({ id: TOTALS_TREE, title: "Invoice totals wrong for Dutch customers on staging", description: "Billing" })),
            recordEnvelope("claim", validClaimBody({ id: "clm_tot_obs", workContextId: TOTALS_TREE, body: "The VAT line is rounded per item." })),
          ]
        : []),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: STRICT_PROMPT });
    const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { candidates: readonly WireCandidate[] } };
    return new Map(body.data.candidates.map((candidate) => [candidate.workContext.id, candidate]));
  };

  test("a finding on words only its tree says ships, and says how many", async () => {
    // Arrange + Act
    const byTree = await strictWorld(false);

    // Assert — rendering, fails and pdf; the labels tree says none of them
    expect(byTree.get(INVOICE_TREE)?.topicalTerms).toBe(4);
    expect(byTree.get(LABELS_TREE)?.topicalTerms).toBe(3);
    expect(claimOf(byTree.get(INVOICE_TREE), "clm_inv_own")?.distinctTerms).toBe(3);
    expect(claimOf(byTree.get(INVOICE_TREE), "clm_inv_own")?.body.length ?? 0).toBeGreaterThan(0);
  });

  test("a finding whose every shared word the runner-up says too travels without its body", async () => {
    // Arrange + Act
    const byTree = await strictWorld(false);

    // Assert — dutch, customers and invoice: the labels tree says all three
    const shared = claimOf(byTree.get(INVOICE_TREE), "clm_inv_shared");
    expect(shared?.matchedTerms).toBe(3);
    expect(shared?.distinctTerms).toBe(0);
    expect(shared?.body).toBe("");
  });

  test("a weaker tree's finding travels without its body, however well it matches alone", async () => {
    // Arrange + Act
    const byTree = await strictWorld(false);

    // Assert — staging is the labels decision's own word, but its tree is not the strongest
    const weaker = claimOf(byTree.get(LABELS_TREE), "clm_lab_dec");
    expect(weaker?.matchedTerms).toBe(3);
    expect(weaker?.distinctTerms).toBe(1);
    expect(weaker?.body).toBe("");
  });

  test("a tie at the top ships no body at all, words of its own or not", async () => {
    // Arrange + Act — the totals tree's title says four words too, none of the finding's
    const byTree = await strictWorld(true);

    // Assert
    expect(byTree.get(TOTALS_TREE)?.topicalTerms).toBe(4);
    expect(claimOf(byTree.get(INVOICE_TREE), "clm_inv_own")?.distinctTerms).toBe(3);
    expect(claimOf(byTree.get(INVOICE_TREE), "clm_inv_own")?.body).toBe("");
  });
});
