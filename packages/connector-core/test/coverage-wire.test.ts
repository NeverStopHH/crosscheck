/**
 * COV-3 — absent coverage is `unknown`, never silence and never `complete`.
 *
 * `GET /api/absences` stops being a bare list here: it answers findings AND
 * the record that says how far those findings can be trusted. The direction
 * that matters is the one an OLD hub takes — no `coverage` key at all — and
 * the rule inverts this tree's usual tolerant parse: nothing claimed is not
 * the honest reading, five `unknown` rows are.
 */
import { afterAll, describe, expect, test } from "bun:test";

import {
  COVERAGE_REASONS,
  COVERAGE_SOURCES,
  COVERAGE_STATES,
  UNKNOWN_COVERAGE,
  parseCoverage,
} from "../src/http/coverage.ts";
import { getAbsences } from "../src/http/hub.ts";
import type { HubContext } from "../src/http/client.ts";
import * as hubCoverage from "@crosscheck/server";

const REPO = "github.com/acme/api";

let body: unknown = { absences: [] };

const server = Bun.serve({
  port: 0,
  fetch: () => Response.json({ ok: true, data: body }),
});

afterAll(() => {
  server.stop(true);
});

const ctx = (): HubContext => ({
  hubUrl: `http://127.0.0.1:${String(server.port)}`,
  apiKey: "key",
  timeoutMs: 2000,
  home: "/tmp/does-not-exist",
  repoKey: "",
  now: () => new Date("2026-07-24T09:00:00.000Z"),
});

describe("COV-3: a response with no coverage block", () => {
  test("yields five unknown rows with reason hub_did_not_report", async () => {
    // Arrange: an un-upgraded hub — findings, no coverage key at all
    body = { absences: [] };

    // Act
    const result = await getAbsences(ctx(), REPO);

    // Assert
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.coverage.sources.map((row) => row.source)).toEqual([
      ...COVERAGE_SOURCES,
    ]);
    expect(result.data.coverage.sources.every((row) => row.state === "unknown")).toBe(true);
    expect(
      result.data.coverage.sources.every(
        (row) => row.reason === "hub_did_not_report",
      ),
    ).toBe(true);
  });

  test("a hub that DOES report is read as reported, findings and all", async () => {
    // Arrange
    body = {
      absences: [
        {
          kind: "unconnected",
          name: "Sam Stranger",
          latestCommitAt: "2026-07-22T09:00:00.000Z",
          lastSessionAt: null,
          evidenceCollectedAt: "2026-07-24T08:00:00.000Z",
        },
      ],
      coverage: {
        repo: REPO,
        computedAt: "2026-07-24T09:00:00.000Z",
        scope: { sinceIso: "2026-07-10T09:00:00.000Z" },
        sources: [
          {
            source: "agent_event",
            state: "incomplete",
            reason: "session_reaped",
            gapSince: "2026-07-24T08:30:00.000Z",
            observedAt: "2026-07-24T08:30:00.000Z",
          },
          {
            source: "git",
            state: "complete",
            reason: "commits_reported",
            gapSince: null,
            observedAt: "2026-07-24T08:00:00.000Z",
          },
          { source: "ci", state: "unavailable", reason: "no_emitter", gapSince: null, observedAt: null },
          { source: "runtime", state: "unavailable", reason: "out_of_scope_1_0", gapSince: null, observedAt: null },
          { source: "human_edit", state: "unavailable", reason: "no_platform_rung", gapSince: null, observedAt: null },
        ],
      },
    };

    // Act
    const result = await getAbsences(ctx(), REPO);

    // Assert
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.absences.length).toBe(1);
    expect(result.data.coverage.sources[0]?.state).toBe("incomplete");
    expect(result.data.coverage.sources[0]?.gapSince).toBe("2026-07-24T08:30:00.000Z");
  });
});

describe("parseCoverage fails closed, per row", () => {
  test("a block missing a source keeps the rows it sent and reads the rest unknown", () => {
    // Arrange: git reported, the other four absent
    const raw = {
      repo: REPO,
      computedAt: "2026-07-24T09:00:00.000Z",
      scope: { sinceIso: "2026-07-10T09:00:00.000Z" },
      sources: [
        {
          source: "git",
          state: "complete",
          reason: "commits_reported",
          gapSince: null,
          observedAt: null,
        },
      ],
    };

    // Act
    const record = parseCoverage(raw);

    // Assert
    expect(record.sources.length).toBe(5);
    expect(record.sources.find((row) => row.source === "git")?.state).toBe("complete");
    expect(
      record.sources.filter((row) => row.source !== "git").every((row) => row.state === "unknown"),
    ).toBe(true);
  });

  test.each([
    ["undefined", undefined],
    ["a string", "complete"],
    ["a number", 87],
    ["null", null],
  ] as const)("%s is UNKNOWN_COVERAGE, never complete", (_label, raw) => {
    // Act
    const record = parseCoverage(raw);

    // Assert
    expect(record.sources.every((row) => row.state === "unknown")).toBe(true);
    expect(record.sources.length).toBe(UNKNOWN_COVERAGE.sources.length);
  });

  test("a row claiming a state this client does not know reads unknown, not complete", () => {
    // Act
    const record = parseCoverage({
      sources: [{ source: "agent_event", state: "mostly", reason: "vibes" }],
    });

    // Assert
    expect(record.sources[0]?.state).toBe("unknown");
    expect(record.sources[0]?.reason).toBe("hub_did_not_report");
  });
});

/**
 * ONE VOCABULARY, TWO PACKAGES. The connector cannot import the hub, so the
 * three enums are declared twice — which is exactly the drift 00 §9.6 forbids
 * unless something checks it. This is the something.
 */
describe("the wire vocabulary matches the hub's own", () => {
  test("sources, states and reasons are identical to the hub's", () => {
    expect([...COVERAGE_SOURCES]).toEqual([...hubCoverage.COVERAGE_SOURCES]);
    expect([...COVERAGE_STATES]).toEqual([...hubCoverage.COVERAGE_STATES]);
    expect([...COVERAGE_REASONS]).toEqual([...hubCoverage.COVERAGE_REASONS]);
  });
});
