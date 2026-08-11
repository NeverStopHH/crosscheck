/**
 * GET /api/drafts — the promotion loop's read (DESIGN.md §3 Tier 1): the
 * caller's OWN unreviewed Tier-1 drafts, and nothing else. "Unreviewed" is
 * append-only mechanics: no supersedes edge pointing at the draft (a
 * promotion or discard revision retires it without mutating the row).
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
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const SECOND_SESSION_ID = "ses_02";

interface DraftView {
  readonly id: string;
  readonly workContextId: string;
  readonly kind: string;
  readonly body: string;
  readonly status: string;
  readonly confidence: number;
  readonly createdAt: string;
}

const fetchDrafts = async (
  harness: TestHarness,
  developer: TestDeveloper,
  repo: string = VALID_SESSION_BODY.repo,
): Promise<{ status: number; drafts: readonly DraftView[] }> => {
  const response = await harness.app.request(
    `/api/drafts?repo=${encodeURIComponent(repo)}`,
    jsonRequest("GET", developer.apiKey),
  );
  if (response.status !== 200) {
    return { status: response.status, drafts: [] };
  }
  const body = (await response.json()) as { data: { drafts: DraftView[] } };
  return { status: response.status, drafts: body.data.drafts };
};

const draftBody = (
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> =>
  validClaimBody({
    id,
    captureMode: "auto",
    provenance: "derived",
    confidence: 0.4,
    body: `Draft finding ${id}`,
    ...overrides,
  });

describe("GET /api/drafts", () => {
  test("lists the caller's own unreviewed derived drafts, newest first", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", draftBody("clm_d1")),
        recordEnvelope(
          "claim",
          draftBody("clm_d2", { createdAt: "2026-07-24T10:00:00.000Z" }),
        ),
        // A DECLARED claim is not a draft, whatever else it looks like.
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_declared", body: "A declared claim" }),
        ),
      ],
    });

    // Act
    const { status, drafts } = await fetchDrafts(harness, developer);

    // Assert
    expect(status).toBe(200);
    expect(drafts.map((draft) => draft.id)).toEqual(["clm_d2", "clm_d1"]);
    expect(drafts[0]?.status).toBe("proposed");
  });

  test("never lists a teammate's drafts — own drafts only", async () => {
    // Arrange: Robin has his own session and his own draft
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody())],
    });
    const robin = await addTestDeveloperWithSession(
      harness,
      "Robin",
      "robin@example.com",
      { id: SECOND_SESSION_ID },
    );
    await postRecords(
      harness,
      robin,
      recordEnvelope(
        "claim",
        draftBody("clm_robin_draft", { authorSessionId: SECOND_SESSION_ID }),
        { sessionId: SECOND_SESSION_ID },
      ),
    );

    // Act + Assert: Robin sees his draft, Nick sees none of Robin's
    const robinView = await fetchDrafts(harness, robin);
    expect(robinView.drafts.map((draft) => draft.id)).toEqual([
      "clm_robin_draft",
    ]);
    const nickView = await fetchDrafts(harness, developer);
    expect(nickView.drafts).toHaveLength(0);
  });

  test("a superseded draft is reviewed and disappears", async () => {
    // Arrange: draft + promotion revision + supersedes edge (append-only)
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", draftBody("clm_reviewed")),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_promoted",
            body: "Draft finding clm_reviewed",
          }),
        ),
        recordEnvelope(
          "claim_edge",
          validClaimEdgeBody({
            id: "edge_promote",
            fromClaimId: "clm_promoted",
            toClaimId: "clm_reviewed",
            kind: "supersedes",
          }),
        ),
      ],
    });

    // Act
    const { drafts } = await fetchDrafts(harness, developer);

    // Assert: the draft row still exists (append-only) but is no longer
    // unreviewed; the promoted claim is declared and never a draft.
    expect(drafts).toHaveLength(0);
  });

  test("repo filters as relevance, and a foreign repo lists nothing", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", draftBody("clm_here")),
      ],
    });

    const { drafts } = await fetchDrafts(
      harness,
      developer,
      "github.com/acme/other",
    );
    expect(drafts).toHaveLength(0);
  });

  test("requires a repo parameter", async () => {
    const { harness, developer } = await createHarnessWithSession();
    const response = await harness.app.request(
      "/api/drafts",
      jsonRequest("GET", developer.apiKey),
    );
    expect(response.status).toBe(400);
  });

  test("requires authentication", async () => {
    const { harness } = await createHarnessWithSession();
    const response = await harness.app.request(
      `/api/drafts?repo=${encodeURIComponent(VALID_SESSION_BODY.repo)}`,
      jsonRequest("GET", null),
    );
    expect(response.status).toBe(401);
  });
});
