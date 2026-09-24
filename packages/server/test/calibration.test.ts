/**
 * EV-7(a) — the calibration report's RETURNED VALUE (1.0 spec 08 §3.7).
 *
 * The rules pinned here are the ones easiest to break by adding a field
 * somebody thought would be helpful:
 *
 *   - NO RATE. Not a ratio, a percentage, a score or a badge. A rate over
 *     twelve observations is the 0.80-at-55 % problem wearing a denominator.
 *   - NO PERSON. No developer id, name or email, and no session id. A
 *     calibration is a statement about a PROVIDER; naming somebody turns it
 *     into a performance review, which is a different product.
 *   - `withoutVerificationRef` ON EVERY CELL. A claim that named no check can
 *     never be verified, so omitting it makes the verified count a hit rate
 *     over a denominator chosen by omission.
 *   - THE CUT IS VISIBLE. `claimsRead` against `claimsTotal`, so a truncated
 *     answer cannot be read as a whole one.
 *
 * The first two are asserted STRUCTURALLY — over the report's own keys rather
 * than field by field — because the failure they guard against is somebody
 * ADDING something, and a field-by-field test passes happily beside a new
 * field it was never told about.
 */
import { describe, expect, test } from "bun:test";

import { CALIBRATION_WINDOW_DAYS } from "../src/constants.ts";
import { calibrationReport } from "../src/services/calibration.ts";
import {
  createHarnessWithSession,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = "github.com/acme/api";
const NOW = new Date("2026-09-23T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

/** A root cause from the registered session, optionally naming a check. */
const seedRootCause = async (
  harness: TestHarness,
  developer: TestDeveloper,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  const { data } = await postRecords(
    harness,
    developer,
    recordEnvelope(
      "claim",
      validClaimBody({
        id,
        kind: "root_cause",
        status: "likely_root_cause",
        evidenceRefs: ["clm_evidence"],
        // A DISTINCT BODY PER CLAIM, because ingest deduplicates on
        // normalized-body equality per author and context: two root causes
        // with identical text are one observation, which is correct product
        // behaviour and would silently halve every count below.
        body: `The rotation path drops the key id (${id})`,
        ...overrides,
      }),
    ),
  );
  if (data?.results[0]?.status !== "accepted") {
    throw new Error(
      `claim refused: ${data?.results[0]?.issues?.join(" ") ?? "unknown"}`,
    );
  }
};

const seeded = async (
  overrides: Record<string, unknown> = {},
): Promise<{ harness: TestHarness; developer: TestDeveloper }> => {
  const { harness, developer } = await createHarnessWithSession({
    repo: REPO,
    ...overrides,
  });
  await postRecords(
    harness,
    developer,
    recordEnvelope("work_context", validWorkContextBody()),
  );
  return { harness, developer };
};

describe("the calibration report", () => {
  test("counts root causes per provider, and never names a person", async () => {
    // Arrange
    const { harness, developer } = await seeded({ agentKind: "claude-code" });
    await seedRootCause(harness, developer, "clm_a");
    await seedRootCause(harness, developer, "clm_b", {
      verificationRef: "ci_test:packages/a.test.ts::suite::one",
    });

    // Act
    const report = await calibrationReport({
      db: harness.db,
      repo: REPO,
      now: NOW,
    });

    // Assert — the provider is the only identity in the whole document.
    const serialised = JSON.stringify(report);
    expect(report.cells).toHaveLength(1);
    expect(report.cells[0]?.agentKind).toBe("claude-code");
    expect(report.cells[0]?.rootCausesObserved).toBe(2);
    expect(serialised).not.toContain("Nick");
    expect(serialised).not.toContain("nick@example.com");
    expect(serialised).not.toContain("dev_");
    expect(serialised).not.toContain("ses_");
  });

  test("carries NO rate, ratio, percentage or score — anywhere", async () => {
    // Arrange
    const { harness, developer } = await seeded();
    await seedRootCause(harness, developer, "clm_a");

    // Act
    const report = await calibrationReport({
      db: harness.db,
      repo: REPO,
      now: NOW,
    });

    // Assert — STRUCTURAL, because the failure guarded against is somebody
    // ADDING a helpful-looking field, which a per-field test would not see.
    const keys = new Set<string>(
      Object.keys(report).map((key) => key.toLowerCase()),
    );
    for (const cell of report.cells) {
      for (const key of Object.keys(cell)) {
        keys.add(key.toLowerCase());
      }
    }
    for (const banned of ["rate", "ratio", "percent", "score", "pct", "share"]) {
      for (const key of keys) {
        expect(key.includes(banned), `${key} contains ${banned}`).toBe(false);
      }
    }
    // And no NUMBER is a fraction pretending to be a count.
    for (const cell of report.cells) {
      for (const value of Object.values(cell)) {
        if (typeof value === "number") {
          expect(
            Number.isInteger(value),
            `${String(value)} is not a count`,
          ).toBe(true);
        }
      }
    }
  });

  test("every cell carries withoutVerificationRef and unresolvableByRetention", async () => {
    // Arrange — one claim that named a check and one that did not.
    const { harness, developer } = await seeded();
    await seedRootCause(harness, developer, "clm_a");
    await seedRootCause(harness, developer, "clm_b", {
      verificationRef: "ci_test:packages/a.test.ts::suite::one",
    });

    // Act
    const report = await calibrationReport({
      db: harness.db,
      repo: REPO,
      now: NOW,
    });
    const cell = report.cells[0];

    // Assert — the ran-denominator lesson: the claim that named nothing can
    // NEVER be verified, and hiding it would turn the verified count into a
    // flattering hit rate.
    expect(cell?.withVerificationRef).toBe(1);
    expect(cell?.withoutVerificationRef).toBe(1);
    expect(cell?.unresolvableByRetention).toBe(0);
    expect(cell?.windowDays).toBe(CALIBRATION_WINDOW_DAYS);
  });

  test("a claim that named no check is still unsupported, and says so", async () => {
    // Arrange — the honest starting state of every claim in this product.
    const { harness, developer } = await seeded();
    await seedRootCause(harness, developer, "clm_a");

    // Act
    const report = await calibrationReport({
      db: harness.db,
      repo: REPO,
      now: NOW,
    });

    // Assert
    expect(report.cells[0]?.stillUnsupported).toBe(1);
    expect(report.cells[0]?.nowRepositoryVerified).toBe(0);
  });

  test("the cut is visible: claimsRead against claimsTotal", async () => {
    // Arrange
    const { harness, developer } = await seeded();
    await seedRootCause(harness, developer, "clm_a");
    await seedRootCause(harness, developer, "clm_b");

    // Act
    const report = await calibrationReport({
      db: harness.db,
      repo: REPO,
      now: NOW,
    });

    // Assert — equal when nothing was cut, and a surface printing both can say
    // so when they differ. A report carrying only one number could present a
    // truncated answer as a whole one.
    expect(report.claimsRead).toBe(2);
    expect(report.claimsTotal).toBe(2);
  });

  test("a repo with nothing recorded reports no cells, not a zero", async () => {
    // Arrange — the state of every repo before anybody publishes a root
    // cause. An empty report is the truth; a cell of zeros would invent a
    // provider that never spoke.
    const { harness } = await seeded();

    // Act
    const report = await calibrationReport({
      db: harness.db,
      repo: REPO,
      now: NOW,
    });

    // Assert
    expect(report.cells).toEqual([]);
    expect(report.claimsRead).toBe(0);
    expect(report.claimsTotal).toBe(0);
  });

  test("claims outside the window are not counted", async () => {
    // Arrange — the window is what makes this a measurement over MONTHS
    // rather than over everything the hub has ever held.
    const { harness, developer } = await seeded();
    const longAgo = new Date(
      NOW.getTime() - (CALIBRATION_WINDOW_DAYS + 30) * MS_PER_DAY,
    ).toISOString();
    await seedRootCause(harness, developer, "clm_old", { createdAt: longAgo });

    // Act
    const report = await calibrationReport({
      db: harness.db,
      repo: REPO,
      now: NOW,
    });

    // Assert
    expect(report.claimsTotal).toBe(0);
    expect(report.cells).toEqual([]);
  });
});
