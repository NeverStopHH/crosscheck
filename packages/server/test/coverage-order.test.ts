/**
 * THE COVERAGE RECORD'S `order` BLOCK (1.0 spec 01a §3.7, CSK-8, CSK-9):
 * beside the five sources, never one of them, and carrying no count.
 *
 * `order.state` is the MINIMUM, over the sessions in scope and the kinds the
 * question needs, of each session's effective guarantee. Every case here is a
 * way a weaker rule would print a stronger word: a fold over nothing
 * returning the strongest value, a session that declared nothing left out of
 * the minimum, a contradicting row counted and not capped, a kind the
 * question does not need deciding the answer.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { isJudgeable, readCoverage } from "../src/services/coverage.ts";
import type { CoverageRecord } from "../src/services/coverage.ts";
import {
  EXPLANATION_TIMING_KINDS,
  TOUCH_KINDS,
} from "../src/services/coverage-order.ts";
import {
  VALID_SESSION_BODY,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const EPOCH = "0d9c8b7a-6f5e-4d4c-8b3a-2f1e0d9c8b7a";
/** One day back: inside every window this file asks about. */
const SCOPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Every kind declared at the strongest the hub admits for it (schema
 * `isAdmissibleReason`): `guaranteed` where the kind can carry it, the
 * strongest `partial` reason where it cannot.
 */
const ALL_GUARANTEED = [
  { kind: "session.started", guarantee: "guaranteed", reason: "lifecycle" },
  { kind: "session.ended", guarantee: "guaranteed", reason: "lifecycle" },
  { kind: "file.modified", guarantee: "guaranteed", reason: "bracketed_by_pre_tool" },
  { kind: "tool.failed", guarantee: "guaranteed", reason: "bracketed_by_pre_tool" },
  { kind: "claim.created", guarantee: "partial", reason: "ambiguous_session_possible" },
  { kind: "claim.invalidated", guarantee: "partial", reason: "ambiguous_session_possible" },
  { kind: "commit.observed", guarantee: "partial", reason: "ambiguous_session_possible" },
  { kind: "intent.declared", guarantee: "partial", reason: "ambiguous_session_possible" },
  { kind: "intent.amended", guarantee: "partial", reason: "ambiguous_session_possible" },
] as const;

const withKind = (kind: string, guarantee: string, reason: string): readonly unknown[] =>
  ALL_GUARANTEED.map((triple) => (triple.kind === kind ? { kind, guarantee, reason } : triple));

const seed = async (): Promise<{ harness: TestHarness; developer: TestDeveloper }> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
  return { harness, developer };
};

const register = async (
  harness: TestHarness,
  developer: TestDeveloper,
  id: string,
  guarantees?: readonly unknown[],
): Promise<void> => {
  const response = await registerTestSession(harness, developer.apiKey, {
    id,
    seq: { epoch: EPOCH, n: 0 },
    ...(guarantees === undefined ? {} : { guarantees }),
  });
  expect(response.status).toBeLessThan(300);
};

const coverage = async (
  harness: TestHarness,
  developer: TestDeveloper,
  options: Parameters<typeof readCoverage>[3] = {},
): Promise<CoverageRecord> =>
  readCoverage({ db: harness.db, now: harness.clock.now }, developer.developerId, REPO, options);

describe("CSK-8 — an empty or undeclared scope is never read as guaranteed", () => {
  test("a scope with no session reads undeclared / no_session_in_scope", async () => {
    // Arrange
    const { harness, developer } = await seed();
    // Act
    const record = await coverage(harness, developer);
    // Assert
    expect(record.order).toEqual({ state: "undeclared", reason: "no_session_in_scope" });
  });

  test("a session that declared nothing makes the whole scope undeclared", async () => {
    // Arrange: one over-declaring session and one older connector's.
    const { harness, developer } = await seed();
    await register(harness, developer, "ses_declared", ALL_GUARANTEED);
    await register(harness, developer, "ses_silent");
    // Act
    const record = await coverage(harness, developer);
    // Assert
    expect(record.order).toEqual({ state: "undeclared", reason: "provider_undeclared" });
  });
});

describe("the fold is the minimum", () => {
  test("the weakest declaration among the sessions wins, with its own reason", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await register(harness, developer, "ses_strong", ALL_GUARANTEED);
    await register(
      harness,
      developer,
      "ses_weak",
      withKind("file.modified", "partial", "unbracketed_lane"),
    );
    // Act
    const record = await coverage(harness, developer);
    // Assert
    expect(record.order).toEqual({ state: "partial", reason: "unbracketed_lane" });
  });

  test("only the kinds the question needs decide it", async () => {
    // Arrange: a session that cannot see commits, asked about touches.
    const { harness, developer } = await seed();
    await register(
      harness,
      developer,
      "ses_no_commits",
      withKind("commit.observed", "unavailable", "no_emitter"),
    );
    // Act
    const touches = await coverage(harness, developer, { orderKinds: TOUCH_KINDS });
    const everything = await coverage(harness, developer);
    // Assert
    expect(touches.order).toEqual({ state: "guaranteed", reason: "bracketed_by_pre_tool" });
    expect(everything.order).toEqual({ state: "unavailable", reason: "no_emitter" });
  });

  test("an explanation-timing question reads the intent kinds as well as the edits", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await register(
      harness,
      developer,
      "ses_derived_intent",
      withKind("intent.amended", "partial", "derived_after_the_fact"),
    );
    // Act
    const record = await coverage(harness, developer, { orderKinds: EXPLANATION_TIMING_KINDS });
    // Assert
    expect(record.order).toEqual({ state: "partial", reason: "derived_after_the_fact" });
  });
});

describe("CSK-9 — a contradicting row lowers what the user sees", () => {
  test("an unbracketed edit from a session that declared it bracketed reads partial / declaration_contradicted", async () => {
    // Arrange
    const { harness, developer } = await seed();
    await register(harness, developer, VALID_SESSION_BODY.id, ALL_GUARANTEED);
    const edit = recordEnvelope("target", {
      workContextId: WORK_CONTEXT_ID,
      kind: "file",
      value: "src/auth.ts",
    });
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        { ...edit, seq: { epoch: EPOCH, n: 1 } },
      ],
    });
    // Act
    const record = await coverage(harness, developer, { orderKinds: TOUCH_KINDS });
    // Assert
    expect(record.order).toEqual({ state: "partial", reason: "declaration_contradicted" });
  });
});

describe("a stored value this hub cannot read", () => {
  test("a reason a newer hub wrote ranks as undeclared, never as the strongest", async () => {
    // Arrange: a row this hub's vocabulary has no word for.
    const { harness, developer } = await seed();
    await register(harness, developer, "ses_newer", ALL_GUARANTEED);
    await harness.db.execute(
      sql`UPDATE session_causal_guarantees SET reason = 'vendor_magic' WHERE session_id = 'ses_newer' AND kind = 'file.modified'`,
    );
    // Act
    const record = await coverage(harness, developer, { orderKinds: TOUCH_KINDS });
    // Assert
    expect(record.order).toEqual({ state: "undeclared", reason: "provider_undeclared" });
  });
});

describe("the fold reads the agent_event rung's own scope", () => {
  test("a session the path scope leaves out does not enter the fold, and one it keeps does", async () => {
    // Arrange: A declared everything and touched the pinned file inside its
    // bracket; B declared nothing, touched nothing and ended cleanly.
    const { harness, developer } = await seed();
    await register(harness, developer, VALID_SESSION_BODY.id, ALL_GUARANTEED);
    await register(harness, developer, "ses_elsewhere");
    await harness.app.request(
      "/api/sessions/ses_elsewhere/end",
      jsonRequest("POST", developer.apiKey, { status: "done", seq: { epoch: EPOCH, n: 1 } }),
    );
    const edit = recordEnvelope("target", {
      workContextId: WORK_CONTEXT_ID,
      kind: "file",
      value: "src/auth.ts",
    });
    await postRecords(harness, developer, {
      records: [
        recordEnvelope("work_context", validWorkContextBody()),
        { ...edit, seq: { epoch: EPOCH, n: 2, after: 1 } },
      ],
    });
    const since = new Date(harness.clock.now().getTime() - SCOPE_WINDOW_MS).toISOString();
    // Act
    const pinned = await coverage(harness, developer, {
      orderKinds: TOUCH_KINDS,
      scope: { sinceIso: since, paths: ["src/auth.ts"] },
    });
    const repoWide = await coverage(harness, developer, { orderKinds: TOUCH_KINDS });
    // Assert
    expect(pinned.order).toEqual({ state: "guaranteed", reason: "bracketed_by_pre_tool" });
    expect(repoWide.order).toEqual({ state: "undeclared", reason: "provider_undeclared" });
  });
});

describe("the two gates stay orthogonal", () => {
  test("isJudgeable does not read order", async () => {
    // Arrange: a judgeable record, then the same record with the weakest order there is.
    const { harness, developer } = await seed();
    const record = await coverage(harness, developer);
    const complete: CoverageRecord = {
      ...record,
      sources: record.sources.map((row) =>
        row.source === "agent_event" || row.source === "git"
          ? { ...row, state: "complete", reason: "sessions_reported" }
          : row,
      ),
    };
    // Act / Assert
    expect(isJudgeable({ ...complete, order: { state: "guaranteed", reason: "lifecycle" } })).toBe(true);
    expect(
      isJudgeable({ ...complete, order: { state: "undeclared", reason: "no_session_in_scope" } }),
    ).toBe(true);
  });
});
