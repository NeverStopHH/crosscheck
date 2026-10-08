/**
 * The hint pool is RANKED on pushable text only (hold-out review, M3). A
 * draft, a refuted claim or one revised away is never shown by a hint and
 * never lends a word to the floor — and it must not rank a tree into the
 * ten-row pool either, where a flood of them crowded out the one tree whose
 * declared claim is the answer. The ranking is the hints query's own: it
 * reads each context's own statement and its pushable claims, whatever the
 * context's normalized search document still holds.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";

const PROMPT = "why does the JWT refresh race corrupt the token cache on key rotation";
const NOISE = "The JWT refresh race corrupts the token cache on every key rotation; refresh token cache race on rotation";
const FLOOD = 12;

type Variant = "derived" | "rejected" | "superseded";

/** One noise claim per flood tree, in the variant's unpushable shape. */
const noise = (variant: Variant, index: number): readonly unknown[] => {
  const wc = `wc_flood_${String(index)}`;
  const id = `clm_f_${String(index)}`;
  if (variant === "derived") {
    return [recordEnvelope("claim", validClaimBody({ id, workContextId: wc, provenance: "derived", captureMode: "auto", confidence: 0.4, body: NOISE }))];
  }
  if (variant === "rejected") {
    return [recordEnvelope("claim", validClaimBody({ id, workContextId: wc, status: "rejected", body: NOISE }))];
  }
  return [
    recordEnvelope("claim", validClaimBody({ id, workContextId: wc, body: NOISE })),
    recordEnvelope("claim", validClaimBody({ id: `${id}_new`, workContextId: wc, body: "Retracted: that was wrong." })),
    recordEnvelope("claim_edge", validClaimEdgeBody({ id: `edge_f_${String(index)}`, fromClaimId: `${id}_new`, toClaimId: id, kind: "supersedes" })),
  ];
};

const poolFor = async (variant: Variant): Promise<readonly string[]> => {
  const { harness, developer: nick } = await createHarnessWithSession();
  const records = [
    // the one tree that should be hinted: a declared claim under an unrelated title
    recordEnvelope("work_context", validWorkContextBody({ id: "wc_real", title: "Auth cleanup", description: "Middleware" })),
    recordEnvelope("claim", validClaimBody({ id: "clm_real", workContextId: "wc_real", body: "The JWT refresh race comes from two parallel requests rotating the token." })),
    ...Array.from({ length: FLOOD }, (_, index) => [
      recordEnvelope("work_context", validWorkContextBody({ id: `wc_flood_${String(index)}`, title: `Nightly job ${String(index)}`, description: "Batch" })),
      recordEnvelope("claim", validClaimBody({ id: `clm_f_decl_${String(index)}`, workContextId: `wc_flood_${String(index)}`, body: "The nightly job writes its report at 2am." })),
      ...noise(variant, index),
    ]).flat(),
  ];
  const seeded = await postRecords(harness, nick, { records });
  expect(seeded.data?.accepted).toBe(records.length);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: PROMPT });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
  const body = (await response.json()) as { data: { candidates: readonly { workContext: { id: string } }[] } };
  return body.data.candidates.map((candidate) => candidate.workContext.id);
};

describe("a muted author's flood cannot crowd it out either", () => {
  test("twelve trees whose prompt-matching claims are by an author the reader muted", async () => {
    // Arrange — Nick's trees; Mike's claims inside them say the prompt's words; Robin muted Mike
    const { harness, developer: nick } = await createHarnessWithSession();
    const mike = await addTestDeveloperWithSession(harness, "Mike", "mike@example.com", { id: "ses_mike" });
    const trees = [
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_real", title: "Auth cleanup", description: "Middleware" })),
      recordEnvelope("claim", validClaimBody({ id: "clm_real", workContextId: "wc_real", body: "The JWT refresh race comes from two parallel requests rotating the token." })),
      ...Array.from({ length: FLOOD }, (_, index) =>
        recordEnvelope("work_context", validWorkContextBody({ id: `wc_flood_${String(index)}`, title: `Nightly job ${String(index)}`, description: "Batch" })),
      ),
    ];
    expect((await postRecords(harness, nick, { records: trees })).data?.accepted).toBe(trees.length);
    const muted = Array.from({ length: FLOOD }, (_, index) =>
      recordEnvelope("claim", validClaimBody({ id: `clm_m_${String(index)}`, workContextId: `wc_flood_${String(index)}`, authorSessionId: "ses_mike", body: NOISE }), { sessionId: "ses_mike" }),
    );
    expect((await postRecords(harness, mike, { records: muted })).data?.accepted).toBe(FLOOD);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    expect((await harness.app.request("/api/settings/mutes", jsonRequest("POST", robin.apiKey, { developer: "Mike" }))).status).toBe(200);

    // Act
    const search = new URLSearchParams({ repo: VALID_SESSION_BODY.repo, query: PROMPT });
    const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", robin.apiKey));
    const body = (await response.json()) as { data: { candidates: readonly { workContext: { id: string } }[] } };

    // Assert
    expect(body.data.candidates.map((candidate) => candidate.workContext.id)).toEqual(["wc_real"]);
  }, 120_000);
});

describe("a flood of claims a hint never shows cannot crowd out the one it would", () => {
  test.each([["derived"], ["rejected"], ["superseded"]] as const)(
    "twelve trees ranking on %s claims leave the declared tree in the pool",
    async (variant) => {
      // Act
      const ids = await poolFor(variant);

      // Assert — the declared tree is found, and no flood tree with it
      expect(ids).toEqual(["wc_real"]);
    },
    120_000,
  );
});
