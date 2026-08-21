/**
 * The intent on the wire, client side (trial finding #16): every row schema
 * that carries one is tolerant PER FIELD — a malformed intent drops the
 * intent, never the row. Pinned against the hub's own JSON shapes (null when
 * none) and against the things a hostile or newer hub could send.
 */
import { describe, expect, test } from "bun:test";

import {
  DiagnosisWorkContextSchema,
  HintContextCandidateSchema,
  PresenceEntrySchema,
  SearchResultEntrySchema,
  TripwireSessionSchema,
  WorkContextEntrySchema,
} from "../src/http/hub.ts";

const ISO = "2026-08-21T12:00:00.000Z";
const INTENT = { summary: "Fix the refresh 500s", provenance: "derived", confidence: 0.4, capturedAt: ISO };

const presenceRow = (intent: unknown) => ({
  sessionId: "cc_1",
  developerId: "dev_1",
  developerName: "Nick",
  branch: "main",
  status: "implementing",
  lastHeartbeatAt: ISO,
  isSelf: false,
  intent,
});

describe("intent wire parsing drops the field, never the row", () => {
  test("a well-formed intent parses on every row shape that carries one", () => {
    expect(PresenceEntrySchema.parse(presenceRow(INTENT)).intent?.summary).toBe("Fix the refresh 500s");
    expect(
      WorkContextEntrySchema.parse({
        id: "wc_1", developerId: "dev_1", title: "T", status: "analyzing", createdAt: ISO, intent: INTENT,
      }).intent?.provenance,
    ).toBe("derived");
    expect(
      TripwireSessionSchema.parse({
        sessionId: "cc_1", developerId: "dev_1", developerName: "Nick", branch: "main", status: "implementing",
        lastHeartbeatAt: ISO, workContextId: "wc_1", workContextTitle: "T", workContextIntent: INTENT,
      }).workContextIntent?.summary,
    ).toBe("Fix the refresh 500s");
    expect(
      DiagnosisWorkContextSchema.parse({ id: "wc_1", sessionId: "cc_1", title: "T", status: "analyzing", createdAt: ISO, intent: INTENT })
        .intent?.summary,
    ).toBe("Fix the refresh 500s");
    expect(
      SearchResultEntrySchema.parse({ id: "wc_1", developerId: "dev_1", title: "T", status: "analyzing", createdAt: ISO, intent: INTENT })
        .intent?.summary,
    ).toBe("Fix the refresh 500s");
    const candidate = HintContextCandidateSchema.parse({
      workContext: { id: "wc_1", title: "T", status: "analyzing", developerId: "dev_1", createdAt: ISO, intent: INTENT },
      claims: [],
    });
    expect(candidate.workContext.intent?.summary).toBe("Fix the refresh 500s");
  });

  test("null (the hub's 'none') and an absent field both read as no intent", () => {
    expect(PresenceEntrySchema.parse(presenceRow(null)).intent).toBeNull();
    const { intent: _dropped, ...withoutIntent } = presenceRow(null);
    expect(PresenceEntrySchema.parse(withoutIntent).intent).toBeUndefined();
  });

  test("a malformed intent drops the intent and keeps the row", () => {
    // Arrange: empty summary, an out-of-range confidence, a non-object
    for (const malformed of [
      { summary: "", provenance: "derived" },
      { summary: "x", provenance: "derived", confidence: 7 },
      "just a string",
      42,
      { provenance: "derived" },
    ]) {
      // Act
      const parsed = PresenceEntrySchema.safeParse(presenceRow(malformed));

      // Assert: the row survives, the intent is gone
      expect(parsed.success, JSON.stringify(malformed)).toBe(true);
      expect(parsed.success && parsed.data.intent, JSON.stringify(malformed)).toBeUndefined();
      expect(parsed.success && parsed.data.developerName).toBe("Nick");
    }
  });
});
