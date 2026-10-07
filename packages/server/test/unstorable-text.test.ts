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

/**
 * A NUL byte in a body is the one piece of text Postgres cannot hold at all:
 * `text` is not `bytea`, and an INSERT carrying U+0000 raises 22021 ("invalid
 * byte sequence for encoding UTF8") from the driver rather than from any
 * check this hub writes. Before the guard, that error escaped `ingestOne`
 * unhandled and became a 500 for the WHOLE request — so one poisoned record
 * took its clean neighbours with it, and the connector's spool, which only
 * advances its cursor on an `ok` response, could never drain past it.
 *
 * Nothing here is about redaction: the text is not dangerous, it is
 * unstorable, and the honest answer is a per-record refusal naming the field,
 * exactly like every other body the schema turns away.
 *
 * Built rather than typed, because a literal NUL in a source file is invisible
 * in every diff and review tool this project is read in.
 */
const NUL = String.fromCharCode(0);
const REPO = VALID_SESSION_BODY.repo;
/** Past what a btree row holds (2704 bytes): the id the review sent. */
const LONG_ID_LENGTH = 4300;
/** Random text `length` long: Postgres compresses a long repeated string under the btree's limit. */
const incompressible = (length: number): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(length))).toString("base64").slice(0, length);

describe("text a text column cannot hold", () => {
  test("a NUL in a claim body is refused per record, never a 500", async () => {
    const { harness, developer } = await createHarnessWithSession();

    const result = await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_nul", body: `root cause${NUL} found` }),
        ),
      ],
    });

    expect(result.status).toBe(200);
    expect(result.data?.rejected).toBe(1);
    const rejected = result.data?.results.find(
      (entry) => entry.status === "rejected",
    );
    expect((rejected?.issues ?? []).join(" ")).toContain("body");
  });

  test("one poisoned record does not take its clean neighbours down", async () => {
    const { harness, developer } = await createHarnessWithSession();

    const result = await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_poison", body: `a${NUL}b` }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({ id: "clm_clean", body: "the refresh path retries" }),
        ),
      ],
    });

    expect(result.status).toBe(200);
    expect(result.data?.accepted).toBe(2);
    expect(result.data?.rejected).toBe(1);
  });

  /**
   * THE ENVELOPE ID TOO (review-2 round 9, M5). Ingest read the ids of a whole
   * flush for their receipts before it parsed a single envelope, so a NUL in
   * one id failed that read, and with it the batch; a 4.3 kB id passed every
   * check, landed its record, and then failed the receipt's INSERT — a 500 on
   * every retry, with the spool pinned behind it.
   */
  const poisonedId = async (id: string) => {
    const { harness, developer } = await createHarnessWithSession();
    return postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        recordEnvelope("claim", validClaimBody({ id: "clm_poisoned_id", body: "the token cache is stale" }), { id }),
        recordEnvelope("claim", validClaimBody({ id: "clm_clean_id", body: "the refresh path retries" })),
      ],
    });
  };

  test("a NUL in an envelope's id refuses that record alone, never the batch", async () => {
    // Act
    const result = await poisonedId(`env_${NUL}x`);

    // Assert
    expect(result.status).toBe(200);
    expect(result.data?.results.map((entry) => entry.status)).toEqual(["accepted", "rejected", "accepted"]);
  });

  test("an envelope id of 4.3 kB refuses that record alone, never the batch", async () => {
    // Act
    const result = await poisonedId(`env_${incompressible(LONG_ID_LENGTH)}`);

    // Assert
    expect(result.status).toBe(200);
    expect(result.data?.results.map((entry) => entry.status)).toEqual(["accepted", "rejected", "accepted"]);
    expect((result.data?.results[1]?.issues ?? []).join(" ")).toContain("id");
  });

  test("a NUL in a question body is a 400 the asker can read", async () => {
    const { harness, developer } = await createHarnessWithSession();
    await addTestDeveloperWithSession(harness, "Ken", "ken@example.com", {
      id: "ses_ken",
    });

    const response = await harness.app.request(
      "/api/questions",
      jsonRequest("POST", developer.apiKey, {
        id: "qn_nul",
        repo: REPO,
        sessionId: VALID_SESSION_BODY.id,
        developer: "Ken",
        body: `why does the refresh${NUL} path retry?`,
      }),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error?: { message?: string };
    };
    expect(payload.error?.message ?? "").toContain("body");
  });
});
