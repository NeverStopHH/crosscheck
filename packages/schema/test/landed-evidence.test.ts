/**
 * landed_evidence — the connector's bounded git reading of which session base
 * commits have reached the default branch (DESIGN.md §5 merged-branch
 * detection). Facts about commits, never about contexts: the hub maps commit
 * → context itself, so a report cannot name what it lands.
 */
import { describe, expect, test } from "bun:test";

import {
  LandedEvidenceSchema,
  MAX_LANDED_COMMITS,
  parseRecord,
} from "../src/index.ts";

const VALID_BODY = {
  repo: "github.com/acme/api",
  defaultBranch: "origin/main",
  checkedAt: "2026-07-24T09:00:00.000Z",
  commits: ["a1b2c3d4", "deadbeef1"],
};

const envelope = (body: unknown): Record<string, unknown> => ({
  cx: "0.1",
  id: "env_landed_1",
  ts: "2026-07-24T09:00:00.000Z",
  producer: {
    developerId: "dev_1",
    agentKind: "claude-code",
    sessionId: "ses_1",
  },
  kind: "landed_evidence",
  body,
});

describe("LandedEvidenceSchema", () => {
  test("a valid report parses as a known record kind", () => {
    // Act
    const parsed = parseRecord(envelope(VALID_BODY));

    // Assert: known, not the unknown-kind forward-compat path.
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.unknownKind).toBe(false);
  });

  test("a commit that is not a sha is refused", () => {
    // Arrange: flag-shaped and prose-shaped values must never reach git or SQL.
    const body = { ...VALID_BODY, commits: ["--upload-pack=/bin/sh"] };

    // Act
    const parsed = LandedEvidenceSchema.safeParse(body);

    // Assert
    expect(parsed.success).toBe(false);
  });

  test("an empty commit list is refused — no evidence, no record", () => {
    // Act
    const parsed = LandedEvidenceSchema.safeParse({
      ...VALID_BODY,
      commits: [],
    });

    // Assert
    expect(parsed.success).toBe(false);
  });

  test("a report past the commit cap is refused", () => {
    // Arrange
    const body = {
      ...VALID_BODY,
      commits: Array.from(
        { length: MAX_LANDED_COMMITS + 1 },
        (_, index) => `abcdef${String(index).padStart(2, "0")}`,
      ),
    };

    // Act
    const parsed = LandedEvidenceSchema.safeParse(body);

    // Assert
    expect(parsed.success).toBe(false);
  });
});
