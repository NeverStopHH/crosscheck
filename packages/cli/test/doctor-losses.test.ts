/**
 * LOSS-10 and §5.1 (docs/1.0/loss-accounting.md): `doctor` and `status` print
 * every loss the machine's ledgers hold, in one spelling, and `doctor` names
 * the one contradiction a newer connector can see against an older hub —
 * recent local losses beside an `agent_event` rung that still reads
 * complete. Nothing else is a contradiction, and nothing else gets a line.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { EMPTY_LOSS_REPORT } from "@crosscheck/schema";
import type { TelemetryLossReport } from "@crosscheck/schema";
import { repoKey, sessionSlug } from "@crosscheck/connector-core/config/paths.ts";
import type { CoverageRecord } from "@crosscheck/connector-core/http/coverage.ts";
import { UNKNOWN_COVERAGE } from "@crosscheck/connector-core/http/coverage.ts";
import { recordDrop } from "@crosscheck/connector-core/spool/drops.ts";
import { recordCaptureLoss } from "@crosscheck/connector-core/state/loss-ledger.ts";

import { runCli } from "../src/index.ts";
import { coverageReportingCheck } from "../src/cli/doctor-losses.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const NOW = new Date("2026-09-30T10:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const YESTERDAY = new Date(NOW.getTime() - DAY_MS).toISOString();
const MONTH_AGO = new Date(NOW.getTime() - 30 * DAY_MS).toISOString();

const lossOf = (newestAt: string | null): TelemetryLossReport => ({
  total: 382,
  kinds: { spool_expired: 300, hub_rejected: 82 },
  oldestAt: MONTH_AGO,
  newestAt,
});

const coverageWith = (state: string, reason: string): CoverageRecord => ({
  ...UNKNOWN_COVERAGE,
  repo: REPO_ID,
  computedAt: NOW.toISOString(),
  sources: UNKNOWN_COVERAGE.sources.map((row) =>
    row.source === "agent_event"
      ? {
          ...row,
          state,
          reason,
          gapSince: state === "incomplete" ? MONTH_AGO : null,
          observedAt: YESTERDAY,
        }
      : row,
  ) as CoverageRecord["sources"],
});

describe("LOSS-10: doctor names the contradiction and nothing else", () => {
  test("recent local losses beside a complete agent rung are a WARN naming the count and the remedy", () => {
    // Act
    const check = coverageReportingCheck(lossOf(YESTERDAY), coverageWith("complete", "sessions_reported"), NOW);

    // Assert
    expect(check?.level).toBe("WARN");
    expect(check?.name).toBe("coverage reporting");
    expect(check?.detail).toContain("382 telemetry losses");
    expect(check?.detail).toContain("reads complete");
    expect(check?.detail).toContain("upgrade the hub");
  });

  test("a rung the hub turned incomplete for the loss is a PASS", () => {
    // Act
    const lost = coverageReportingCheck(lossOf(YESTERDAY), coverageWith("incomplete", "telemetry_lost"), NOW);
    const ignored = coverageReportingCheck(lossOf(YESTERDAY), coverageWith("incomplete", "record_kinds_ignored"), NOW);

    // Assert
    expect(lost?.level).toBe("PASS");
    expect(lost?.detail).toBe("the hub's coverage reflects the losses this connector reported");
    expect(ignored?.level).toBe("PASS");
  });

  test("a rung incomplete for another reason, or unknown, is no contradiction and gets no line", () => {
    // Act
    const reaped = coverageReportingCheck(lossOf(YESTERDAY), coverageWith("incomplete", "session_reaped"), NOW);
    const unknown = coverageReportingCheck(lossOf(YESTERDAY), UNKNOWN_COVERAGE, NOW);
    const unreachable = coverageReportingCheck(lossOf(YESTERDAY), null, NOW);

    // Assert
    expect(reaped).toBeNull();
    expect(unknown).toBeNull();
    expect(unreachable).toBeNull();
  });

  test("no recent loss is a PASS whatever the hub says, and an undated one counts as recent", () => {
    // Act
    const none = coverageReportingCheck(EMPTY_LOSS_REPORT, coverageWith("complete", "sessions_reported"), NOW);
    const stale = coverageReportingCheck(lossOf(MONTH_AGO), coverageWith("complete", "sessions_reported"), NOW);
    const undated = coverageReportingCheck(lossOf(null), coverageWith("complete", "sessions_reported"), NOW);

    // Assert
    expect(none?.detail).toBe("no recent losses to reflect");
    expect(stale?.level).toBe("PASS");
    expect(undated?.level).toBe("WARN");
  });
});

const stops: (() => void)[] = [];
const paths: string[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** A hub that answers /api/absences with a COMPLETE agent rung and nothing else of note. */
const startCompleteHub = (): string => {
  const record = coverageWith("complete", "sessions_reported");
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/absences") {
        return Promise.resolve(Response.json({ ok: true, data: { absences: [], coverage: record } }));
      }
      if (pathname === "/api/presence") {
        return Promise.resolve(Response.json({ ok: true, data: { sessions: [] } }));
      }
      return Promise.resolve(Response.json({ ok: true, data: {} }));
    },
  });
  stops.push(() => {
    server.stop(true);
  });
  return `http://127.0.0.1:${String(server.port)}`;
};

const fixture = async (
  label: string,
): Promise<{ readonly repo: string; readonly home: string; readonly env: Record<string, string>; readonly key: string }> => {
  const hubUrl = startCompleteHub();
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
    home,
    key: repoKey(hubUrl, REPO_ID),
    env: { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: "test-key" },
  };
};

const seedLosses = async (home: string, key: string): Promise<void> => {
  const now = new Date();
  await recordDrop(home, key, sessionSlug("loss-cli"), 2, "ignored", now, { claim_revalidation: 2 });
  await recordCaptureLoss(home, { kind: "hook_timed_out", count: 1, key, detail: "post-tool-use", now });
};

describe("§5.1: doctor and status print every loss, in one spelling", () => {
  test("doctor names the ignored record kinds, the abandoned hook and the contradiction", async () => {
    // Arrange
    const { repo, home, env, key } = await fixture("doctor-losses");
    await seedLosses(home, key);

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("WARN  spool drops  2 records discarded in 1 batch (ignored 2)");
    expect(result.stdout).toContain("WARN  hub ignored records  2 records in 1 batch ignored by the hub (claim_revalidation 2)");
    expect(result.stdout).toContain("WARN  capture losses  1 hook exceeded its budget before capture could finish (post-tool-use 1)");
    expect(result.stdout).toContain("WARN  coverage reporting  local ledgers hold 3 telemetry losses");
  });

  test("a clean machine passes every loss line", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-no-losses");

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("PASS  spool drops  none");
    expect(result.stdout).toContain("PASS  hub ignored records  none");
    expect(result.stdout).toContain("PASS  capture losses  none");
    expect(result.stdout).toContain("PASS  coverage reporting  no recent losses to reflect");
  });

  test("status prints one losses line above zero only", async () => {
    // Arrange
    const lossy = await fixture("status-losses");
    await seedLosses(lossy.home, lossy.key);
    const clean = await fixture("status-no-losses");

    // Act
    const withLosses = await runCli(["status"], lossy.env, lossy.repo);
    const without = await runCli(["status"], clean.env, clean.repo);

    // Assert
    expect(withLosses.stdout).toContain("\nlosses: 2 records in 1 batch ignored by the hub (claim_revalidation 2)");
    expect(withLosses.stdout).toContain(" · 1 hook exceeded its budget before capture could finish (post-tool-use 1)");
    expect(without.stdout).not.toContain("\nlosses:");
  });
});
