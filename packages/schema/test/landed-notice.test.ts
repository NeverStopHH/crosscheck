/**
 * The two records of the author's notice (docs/1.0/landed-changes.md, step
 * 4): `landed_stop`, the reader's stop at a teammate's landed change, and
 * `landed_notice_delivery`, the author's "shown". Both are known kinds, so a
 * hub that knows them stores them and one that does not ignores them.
 */
import { describe, expect, test } from "bun:test";

import {
  LANDED_CONTEXT_MAX_COMMITS,
  LANDED_NOTICE_MAX_DELIVERED,
  LANDED_STOP_MAX_SUBJECT_CHARS,
  LandedNoticeDeliverySchema,
  LandedStopSchema,
  parseRecord,
} from "../src/index.ts";

const COMMIT = {
  sha: "0dcfc4e9a1b2c3d4e5f60718293a4b5c6d7e8f90",
  subject: "Fix line offset",
  authorEmail: "mike@example.com",
  authorDeveloperId: "dev_mike",
  missing: true,
};

const STOP = {
  sessionId: "ses_nick",
  repo: "github.com/acme/api",
  path: "src/lines.ts",
  stoppedAt: "2026-09-26T09:00:00.000Z",
  commits: [COMMIT],
};

const DELIVERY = {
  sessionId: "ses_mike",
  noticeIds: ["lnt_1", "lnt_2"],
  deliveredAt: "2026-09-26T10:00:00.000Z",
};

const envelope = (kind: string, body: unknown): Record<string, unknown> => ({
  cx: "0.1",
  id: "env_notice_1",
  ts: "2026-09-26T09:00:00.000Z",
  producer: { developerId: "dev_nick", agentKind: "claude-code", sessionId: "ses_nick" },
  kind,
  body,
});

describe("LandedStopSchema", () => {
  test("a stop is a known record kind", () => {
    const parsed = parseRecord(envelope("landed_stop", STOP));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.unknownKind).toBe(false);
  });

  test("a commit that is not a sha is refused", () => {
    const body = { ...STOP, commits: [{ ...COMMIT, sha: "--upload-pack=/bin/sh" }] };

    expect(LandedStopSchema.safeParse(body).success).toBe(false);
  });

  test("a stop names at least one commit and no more than the why may ask about", () => {
    const tooMany = Array.from({ length: LANDED_CONTEXT_MAX_COMMITS + 1 }, () => COMMIT);

    expect(LandedStopSchema.safeParse({ ...STOP, commits: [] }).success).toBe(false);
    expect(LandedStopSchema.safeParse({ ...STOP, commits: tooMany }).success).toBe(false);
  });

  test("whether the reader lacked the commit is stated, never assumed", () => {
    const { missing: _missing, ...unstated } = COMMIT;

    expect(LandedStopSchema.safeParse({ ...STOP, commits: [unstated] }).success).toBe(false);
  });

  test("a subject longer than the bound is refused, and one at it passes", () => {
    const at = { ...COMMIT, subject: "x".repeat(LANDED_STOP_MAX_SUBJECT_CHARS) };
    const over = { ...COMMIT, subject: "x".repeat(LANDED_STOP_MAX_SUBJECT_CHARS + 1) };

    expect(LandedStopSchema.safeParse({ ...STOP, commits: [at] }).success).toBe(true);
    expect(LandedStopSchema.safeParse({ ...STOP, commits: [over] }).success).toBe(false);
  });

  test("an address without an @ is refused, like the why's own", () => {
    const body = { ...STOP, commits: [{ ...COMMIT, authorEmail: "mike" }] };

    expect(LandedStopSchema.safeParse(body).success).toBe(false);
  });
});

describe("LandedNoticeDeliverySchema", () => {
  test("a delivery is a known record kind", () => {
    const parsed = parseRecord(envelope("landed_notice_delivery", DELIVERY));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.unknownKind).toBe(false);
  });

  test("it marks at least one notice and no more than the bound", () => {
    const tooMany = Array.from({ length: LANDED_NOTICE_MAX_DELIVERED + 1 }, (_, i) => `lnt_${String(i)}`);

    expect(LandedNoticeDeliverySchema.safeParse({ ...DELIVERY, noticeIds: [] }).success).toBe(false);
    expect(LandedNoticeDeliverySchema.safeParse({ ...DELIVERY, noticeIds: tooMany }).success).toBe(false);
  });
});
