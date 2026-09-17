/**
 * CCB-4 — CODE, NOT CLOCK, and the assertion that makes AT-2 mean something.
 *
 * Two claims of IDENTICAL age. One's surface moved on the default branch and
 * one's did not. The old-and-untouched claim stays `current`; the
 * young-and-touched claim is `stale`. Either verdict tracking `created_at`
 * fails this file, which is the whole difference between this design and the
 * `stale_at` column it replaced.
 */
import { describe, expect, test } from "bun:test";

import {
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  TEST_START_ISO,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const OLD_ISO = "2026-01-02T09:00:00.000Z";

interface ValidityView {
  readonly state: string;
  readonly commitBinding: string;
  readonly observedAtCommit: string | null;
  readonly touchingCommits: readonly string[];
  readonly touchingTotal: number | null;
  readonly supersededByClaimId: string | null;
}

const readValidity = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<ReadonlyMap<string, ValidityView>> => {
  const response = await harness.app.request(
    `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
    jsonRequest("GET", developer.apiKey),
  );
  const body = (await response.json()) as {
    data: { claims: { id: string; validity: ValidityView }[] };
  };
  return new Map(body.data.claims.map((claim) => [claim.id, claim.validity]));
};

const revalidate = async (
  harness: TestHarness,
  developer: TestDeveloper,
  entries: readonly Record<string, unknown>[],
): Promise<void> => {
  await harness.app.request(
    "/api/claim-revalidations",
    jsonRequest("POST", developer.apiKey, {
      repo: REPO,
      entries,
      revalidated: entries.length,
      total: entries.length,
    }),
  );
};

describe("claim validity", () => {
  test("age decides nothing; the code does", async () => {
    // Arrange: clm_old was written in January, clm_new today, and BOTH sit on
    // the same session base commit.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_old", createdAt: OLD_ISO, body: "old" }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_new",
            createdAt: TEST_START_ISO,
            body: "new",
          }),
        ),
      ],
    });

    // Act: the OLD one's files never moved; the NEW one's did.
    await revalidate(harness, developer, [
      {
        claimId: "clm_old",
        result: "unchanged",
        basis: "context_targets",
        refCommit: "ff00aa11",
      },
      {
        claimId: "clm_new",
        result: "changed",
        basis: "context_targets",
        refCommit: "ff00aa11",
        touchingCommits: ["deadbee", "cafe123"],
        touchingTotal: 2,
      },
    ]);

    // Assert
    const validity = await readValidity(harness, developer);
    expect(validity.get("clm_old")?.state).toBe("current");
    expect(validity.get("clm_new")?.state).toBe("stale");
    expect(validity.get("clm_new")?.touchingCommits).toEqual([
      "deadbee",
      "cafe123",
    ]);
  });

  test("a claim nobody revalidated is unknown, never current", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody()),
      ],
    });

    // Assert
    const validity = await readValidity(harness, developer);
    expect(validity.get("clm_01")?.state).toBe("unknown");
    expect(validity.get("clm_01")?.commitBinding).toBe("session_base");
    expect(validity.get("clm_01")?.observedAtCommit).toBe("a1b2c3d4");
  });

  test("the edge outranks the status in both directions", async () => {
    // Arrange: a `proposed` claim WITH an incoming supersedes edge is
    // superseded; a claim whose author typed status `superseded` with NO edge
    // is not. The edge is the authority and the status is the author's word.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody({ id: "clm_01" })),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_02", body: "the revision" }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_word",
            body: "says superseded, no edge",
            status: "superseded",
          }),
        ),
        recordEnvelope(
          "claim_edge",
          validClaimEdgeBody({ fromClaimId: "clm_02", toClaimId: "clm_01" , kind: "supersedes" }),
        ),
      ],
    });

    // Assert
    const validity = await readValidity(harness, developer);
    expect(validity.get("clm_01")?.state).toBe("superseded");
    expect(validity.get("clm_01")?.supersededByClaimId).toBe("clm_02");
    expect(validity.get("clm_word")?.state).not.toBe("superseded");
  });

  test("a rejected claim is invalidated", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_rejected", status: "rejected" }),
        ),
      ],
    });

    // Assert
    expect((await readValidity(harness, developer)).get("clm_rejected")?.state).toBe(
      "invalidated",
    );
  });

  test("a rejected approach is judged by its code, not by its own status", async () => {
    // Arrange: Nick's own example of the problem this spec exists for —
    // "Raising the timeout does nothing" is gold today and superstition once
    // the reader is rebuilt. It is a `rejected_approach`, and `rejected` is
    // that kind's NATURAL status: it records that the APPROACH was rejected,
    // not that the author retracted the finding. Read as `invalidated`, the
    // claim would be answered by its status forever — never `stale`, never
    // naming the commits that rewrote its code, and rendered as "its author
    // rejected it", which says the opposite of what the author wrote.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_neg",
            kind: "rejected_approach",
            status: "rejected",
            body: "Raising the timeout does nothing",
          }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_neg_unchecked",
            kind: "rejected_approach",
            status: "rejected",
            body: "Retrying the refresh call does not help",
          }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_dead_theory",
            kind: "hypothesis",
            status: "rejected",
            body: "The cache TTL is too short",
          }),
        ),
      ],
    });

    // Act: the timeout finding's code was rewritten.
    await revalidate(harness, developer, [
      {
        claimId: "clm_neg",
        result: "changed",
        basis: "context_targets",
        refCommit: "ff00aa11",
        touchingCommits: ["deadbee"],
        touchingTotal: 1,
      },
    ]);

    // Assert: the negative finding goes stale and names the commit; an
    // unchecked one is unknown like any other claim; a theory its author
    // rejected is still what `invalidated` means.
    const validity = await readValidity(harness, developer);
    expect(validity.get("clm_neg")?.state).toBe("stale");
    expect(validity.get("clm_neg")?.touchingCommits).toEqual(["deadbee"]);
    expect(validity.get("clm_neg_unchecked")?.state).toBe("unknown");
    expect(validity.get("clm_dead_theory")?.state).toBe("invalidated");
  });

  test("a claim bound to no commit is unknown even under a current reading", async () => {
    // Arrange: AT-2's first "fails if" — nothing bound to no commit may read
    // `current`. Unreachable through this hub's own writers (a 'none' claim is
    // never revalidated), which is exactly why it is asserted rather than
    // assumed.
    const { harness, developer } = await createHarnessWithSession({
      baseCommit: "conference",
    });
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody({ id: "clm_unbound" })),
      ],
    });
    await revalidate(harness, developer, [
      {
        claimId: "clm_unbound",
        result: "unchanged",
        basis: "context_targets",
        refCommit: "ff00aa11",
      },
    ]);

    // Assert
    const validity = await readValidity(harness, developer);
    expect(validity.get("clm_unbound")?.commitBinding).toBe("none");
    expect(validity.get("clm_unbound")?.state).toBe("unknown");
  });
});
