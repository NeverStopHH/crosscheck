/**
 * The intent on the wire, client side (trial finding #16): every row schema
 * that carries one is tolerant PER FIELD — a malformed intent drops the
 * intent, never the row. Pinned against the hub's own JSON shapes (null when
 * none) and against the things a hostile or newer hub could send.
 *
 * ONE TABLE, EVERY ROW SHAPE, AND THE MALFORMED CASE IN EACH. An earlier
 * version checked the well-formed and null cases on all six shapes but the
 * malformed case only on presence. Those two halves are green against a
 * schema with no intent field at all — every row schema here is a
 * `looseObject`, so an unknown `intent` key rides through untouched and
 * `.intent.summary` reads back whatever was sent. The malformed assertion is
 * the one that can tell a typed, `.catch(undefined)`-guarded field from a
 * passthrough, so it belongs on every shape: without it, dropping the guard
 * from one of the five non-presence rows would break nothing here.
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
const INTENT = {
  summary: "Fix the refresh 500s",
  provenance: "derived",
  confidence: 0.4,
  capturedAt: ISO,
};

/**
 * What a hostile or simply newer hub can put in the intent slot: an empty
 * summary, a confidence outside [0,1], a non-object, a missing summary.
 */
const MALFORMED: readonly unknown[] = [
  { summary: "", provenance: "derived" },
  { summary: "x", provenance: "derived", confidence: 7 },
  "just a string",
  42,
  { provenance: "derived" },
];

/**
 * One row shape: how to build a row around a given intent slot, the name of
 * the field the intent lives in, and one other field that must survive
 * whatever the intent does (the "keeps the row" half).
 */
interface RowShape {
  readonly label: string;
  readonly parse: (row: Record<string, unknown>) => {
    readonly intent: unknown;
    readonly survivor: unknown;
  };
  readonly row: (intent: unknown) => Record<string, unknown>;
  readonly safeParse: (row: Record<string, unknown>) => { readonly success: boolean };
  readonly survivor: unknown;
}

const presenceRow = (intent: unknown): Record<string, unknown> => ({
  sessionId: "cc_1",
  developerId: "dev_1",
  developerName: "Nick",
  branch: "main",
  status: "implementing",
  lastHeartbeatAt: ISO,
  isSelf: false,
  intent,
});

const workContextRow = (intent: unknown): Record<string, unknown> => ({
  id: "wc_1",
  developerId: "dev_1",
  title: "T",
  status: "analyzing",
  createdAt: ISO,
  intent,
});

const tripwireRow = (intent: unknown): Record<string, unknown> => ({
  sessionId: "cc_1",
  developerId: "dev_1",
  developerName: "Nick",
  branch: "main",
  status: "implementing",
  lastHeartbeatAt: ISO,
  workContextId: "wc_1",
  workContextTitle: "T",
  workContextIntent: intent,
});

const diagnosisRow = (intent: unknown): Record<string, unknown> => ({
  id: "wc_1",
  sessionId: "cc_1",
  title: "T",
  status: "analyzing",
  createdAt: ISO,
  intent,
});

const searchRow = (intent: unknown): Record<string, unknown> => ({
  id: "wc_1",
  developerId: "dev_1",
  title: "T",
  status: "analyzing",
  createdAt: ISO,
  intent,
});

const candidateRow = (intent: unknown): Record<string, unknown> => ({
  workContext: {
    id: "wc_1",
    title: "T",
    status: "analyzing",
    developerId: "dev_1",
    createdAt: ISO,
    intent,
  },
  claims: [],
});

const SHAPES: readonly RowShape[] = [
  {
    label: "PresenceEntry",
    row: presenceRow,
    survivor: "Nick",
    safeParse: (row) => PresenceEntrySchema.safeParse(row),
    parse: (row) => {
      const parsed = PresenceEntrySchema.parse(row);
      return { intent: parsed.intent, survivor: parsed.developerName };
    },
  },
  {
    label: "WorkContextEntry",
    row: workContextRow,
    survivor: "T",
    safeParse: (row) => WorkContextEntrySchema.safeParse(row),
    parse: (row) => {
      const parsed = WorkContextEntrySchema.parse(row);
      return { intent: parsed.intent, survivor: parsed.title };
    },
  },
  {
    label: "TripwireSession",
    row: tripwireRow,
    survivor: "T",
    safeParse: (row) => TripwireSessionSchema.safeParse(row),
    parse: (row) => {
      const parsed = TripwireSessionSchema.parse(row);
      return { intent: parsed.workContextIntent, survivor: parsed.workContextTitle };
    },
  },
  {
    label: "DiagnosisWorkContext",
    row: diagnosisRow,
    survivor: "T",
    safeParse: (row) => DiagnosisWorkContextSchema.safeParse(row),
    parse: (row) => {
      const parsed = DiagnosisWorkContextSchema.parse(row);
      return { intent: parsed.intent, survivor: parsed.title };
    },
  },
  {
    label: "SearchResultEntry",
    row: searchRow,
    survivor: "T",
    safeParse: (row) => SearchResultEntrySchema.safeParse(row),
    parse: (row) => {
      const parsed = SearchResultEntrySchema.parse(row);
      return { intent: parsed.intent, survivor: parsed.title };
    },
  },
  {
    label: "HintContextCandidate",
    row: candidateRow,
    survivor: "T",
    safeParse: (row) => HintContextCandidateSchema.safeParse(row),
    parse: (row) => {
      const parsed = HintContextCandidateSchema.parse(row);
      return { intent: parsed.workContext.intent, survivor: parsed.workContext.title };
    },
  },
];

const summaryOf = (intent: unknown): unknown =>
  typeof intent === "object" && intent !== null && "summary" in intent
    ? (intent as { summary: unknown }).summary
    : undefined;

describe("intent wire parsing drops the field, never the row", () => {
  for (const shape of SHAPES) {
    test(`${shape.label}: well-formed parses, null/absent read as none, malformed drops the field`, () => {
      // Arrange / Act / Assert — a well-formed intent survives
      const good = shape.parse(shape.row(INTENT));
      expect(summaryOf(good.intent)).toBe("Fix the refresh 500s");
      expect(good.survivor).toBe(shape.survivor);

      // The hub's own "none"
      expect(shape.parse(shape.row(null)).intent).toBeNull();

      // An older hub sends no field at all
      const withoutIntent = shape.row(INTENT);
      const carrier =
        shape.label === "HintContextCandidate"
          ? (withoutIntent["workContext"] as Record<string, unknown>)
          : withoutIntent;
      delete carrier[shape.label === "TripwireSession" ? "workContextIntent" : "intent"];
      expect(shape.parse(withoutIntent).intent).toBeUndefined();

      // A hostile or newer hub sends something else: the intent goes, the row stays
      for (const malformed of MALFORMED) {
        const parsed = shape.parse(shape.row(malformed));
        expect(parsed.intent, `${shape.label} ${JSON.stringify(malformed)}`).toBeUndefined();
        expect(parsed.survivor, `${shape.label} ${JSON.stringify(malformed)}`).toBe(
          shape.survivor,
        );
        expect(
          shape.safeParse(shape.row(malformed)).success,
          `${shape.label} ${JSON.stringify(malformed)}`,
        ).toBe(true);
      }
    });
  }
});
