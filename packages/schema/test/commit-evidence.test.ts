import { describe, expect, test } from "bun:test";

import {
  MAX_COMMIT_EVIDENCE_AUTHORS,
  parseRecord,
} from "../src/index.ts";

const TS = "2026-08-10T09:00:00.000Z";

const author = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: "Alice",
  email: "alice@example.com",
  latestCommitAt: TS,
  commitCount: 3,
  ...overrides,
});

const body = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  repo: "github.com/acme/api",
  collectedAt: TS,
  windowDays: 14,
  authors: [author()],
  ...overrides,
});

const envelope = (recordBody: unknown): Record<string, unknown> => ({
  cx: "0.1",
  id: "env_1",
  ts: TS,
  producer: {
    developerId: "dev_1",
    agentKind: "claude-code",
    sessionId: "cc_1",
  },
  kind: "commit_evidence",
  body: recordBody,
});

describe("commit_evidence record kind", () => {
  test("parses a valid body as a known kind", () => {
    // Act
    const parsed = parseRecord(envelope(body()));

    // Assert
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.unknownKind).toBe(false);
    }
  });

  test("rejects a batch of more authors than the cap", () => {
    // Arrange
    const authors = Array.from(
      { length: MAX_COMMIT_EVIDENCE_AUTHORS + 1 },
      (_, index) => author({ email: `dev${index}@example.com` }),
    );

    // Act
    const parsed = parseRecord(envelope(body({ authors })));

    // Assert
    expect(parsed.ok).toBe(false);
  });

  test("rejects an author with an empty email", () => {
    // Act
    const parsed = parseRecord(envelope(body({ authors: [author({ email: "" })] })));

    // Assert
    expect(parsed.ok).toBe(false);
  });

  test("rejects a latestCommitAt that is not an ISO datetime", () => {
    // Act
    const parsed = parseRecord(
      envelope(body({ authors: [author({ latestCommitAt: "yesterday" })] })),
    );

    // Assert
    expect(parsed.ok).toBe(false);
  });

  test("rejects an empty author list — evidence with nobody in it says nothing", () => {
    // Act
    const parsed = parseRecord(envelope(body({ authors: [] })));

    // Assert
    expect(parsed.ok).toBe(false);
  });

  test("rejects a commitCount below one", () => {
    // Act
    const parsed = parseRecord(
      envelope(body({ authors: [author({ commitCount: 0 })] })),
    );

    // Assert
    expect(parsed.ok).toBe(false);
  });

  test("rejects an author whose latestCommitAt outruns collectedAt beyond clock skew", () => {
    // Arrange: collected at TS, but the author's newest commit claims a full
    // day later — an author-controlled forgery or a badly wrong clock, and the
    // hub keeps the newest commit timestamp per author, so an unbounded future
    // date would be stored forever.
    const future = new Date(Date.parse(TS) + 25 * 3_600_000).toISOString();

    // Act
    const parsed = parseRecord(
      envelope(body({ authors: [author({ latestCommitAt: future })] })),
    );

    // Assert
    expect(parsed.ok).toBe(false);
  });

  test("accepts an author whose latestCommitAt sits within clock skew of collectedAt", () => {
    // Arrange: one second ahead of collection — ordinary cross-machine drift.
    const nearFuture = new Date(Date.parse(TS) + 1000).toISOString();

    // Act
    const parsed = parseRecord(
      envelope(body({ authors: [author({ latestCommitAt: nearFuture })] })),
    );

    // Assert
    expect(parsed.ok).toBe(true);
  });
});
