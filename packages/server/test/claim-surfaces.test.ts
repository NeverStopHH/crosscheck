/**
 * THE DECLARED HALF OF A CLAIM'S AFFECTED SURFACE (1.0 spec 02 §3.2).
 *
 * An author who names the files a finding is about gets a staleness check
 * scoped to THOSE files. With none, the fallback is the work context's own
 * `file` targets, which over-fires by construction — any file the session
 * touched moving marks every claim on the tree. The two are told apart by
 * `claim_revalidations.basis`, never by guessing.
 */
import { describe, expect, test } from "bun:test";
import { MAX_CLAIM_SURFACE_PATHS } from "@crosscheck/schema";

import {
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const readSurfaces = async (
  harness: TestHarness,
  developer: TestDeveloper,
): Promise<ReadonlyMap<string, readonly string[]>> => {
  const response = await harness.app.request(
    `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
    jsonRequest("GET", developer.apiKey),
  );
  const body = (await response.json()) as {
    data: { claims: { id: string; affectedPaths: string[] }[] };
  };
  return new Map(body.data.claims.map((claim) => [claim.id, claim.affectedPaths]));
};

describe("claim surfaces", () => {
  test("declared paths are stored and shipped back with the claim", async () => {
    // Arrange
    const { harness, developer } = await createHarnessWithSession();

    // Act
    const posted = await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_declared",
            affectedPaths: ["src/auth/verify.ts", "src/auth/refresh.ts"],
          }),
        ),
        recordEnvelope("claim", validClaimBody({ id: "clm_bare", body: "no paths" })),
      ],
    });

    // Assert: a claim with no declared paths says so with an EMPTY list, which
    // is not the same statement as "this claim touches nothing" — the reader
    // falls back to the tree's targets and labels the basis.
    expect(posted.data?.rejected).toBe(0);
    const surfaces = await readSurfaces(harness, developer);
    expect(surfaces.get("clm_declared")).toEqual([
      "src/auth/refresh.ts",
      "src/auth/verify.ts",
    ]);
    expect(surfaces.get("clm_bare")).toEqual([]);
  });

  test("a path that is not repo-relative POSIX is refused at the wire", async () => {
    // Arrange: a path that could never intersect a touch would watch NOTHING
    // while reading as declared — the fail-silent-dead shape.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody())],
    });

    // Act
    const absolute = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_abs", affectedPaths: ["/etc/passwd"] }),
      ),
    );
    const escaping = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({ id: "clm_up", affectedPaths: ["../other/secrets.ts"] }),
      ),
    );

    // Assert
    expect(absolute.data?.rejected).toBe(1);
    expect(escaping.data?.rejected).toBe(1);
  });

  test("an area-sized surface is refused rather than truncated", async () => {
    // Arrange: past the cap it is not a surface, it is an area — and an
    // area-sized surface makes every commit in the area a downgrade.
    const { harness, developer } = await createHarnessWithSession();
    await postRecords(harness, developer, {
      records: [recordEnvelope("work_context", validWorkContextBody())],
    });

    // Act
    const posted = await postRecords(
      harness,
      developer,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_area",
          affectedPaths: Array.from(
            { length: MAX_CLAIM_SURFACE_PATHS + 1 },
            (_unused, index) => `src/file${String(index)}.ts`,
          ),
        }),
      ),
    );

    // Assert
    expect(posted.data?.rejected).toBe(1);
  });
});
