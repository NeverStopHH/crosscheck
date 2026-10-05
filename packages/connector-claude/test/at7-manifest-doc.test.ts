import { describe, expect, test } from "bun:test";

import { buildManifest, resumeMismatches, startDecision } from "../bench/at7/manifest-doc.ts";
import type { ManifestInput } from "../bench/at7/manifest-doc.ts";
import { dryRunOrder, MANIFEST_SEED, measuredOrder } from "../bench/at7/manifest.ts";
import type { ProfileCheck } from "../bench/at7/profile.ts";

/**
 * The manifest is the record written before the first run (§3, A1.8, A2.2,
 * A2.5): the order, the harness identity, the run env, the exact claude argv
 * and settings, and the A2.2 shell-profile check. Pure builder, so its
 * contents are pinned here rather than read back from a live sweep.
 */
const CLEAN_PROFILE: ProfileCheck = {
  prefixes: ["CROSSCHECK_", "CLAUDE_", "ANTHROPIC_"],
  files: [{ path: "/home/someone/.zshrc", present: true, readable: true, watched: [] }],
  clean: true,
};

const input = (overrides: Partial<ManifestInput> = {}): ManifestInput => ({
  mode: "measured",
  order: measuredOrder(),
  claudeVersion: "2.1.286 (Claude Code)",
  harnessHead: "abc123",
  harnessDirty: false,
  payloadTemplateHash: "f00d",
  env: { PATH: "/usr/bin", CROSSCHECK_HOME: "<per-run temp dir>" },
  shellProfileCheck: CLEAN_PROFILE,
  createdAt: "2026-10-02T00:00:00.000Z",
  ...overrides,
});

describe("buildManifest", () => {
  test("records the A2.2 shell-profile check", () => {
    // Act
    const manifest = buildManifest(input());

    // Assert
    expect(manifest.shellProfileCheck).toEqual(CLEAN_PROFILE);
  });

  test("records the seed for a measured sweep and none for a dry run", () => {
    // Act
    const measured = buildManifest(input());
    const dry = buildManifest(input({ mode: "dry-run", order: dryRunOrder() }));

    // Assert
    expect(measured.seed).toBe(MANIFEST_SEED);
    expect(dry.seed).toBeNull();
  });

  test("records the model, the order and the harness identity", () => {
    // Act
    const manifest = buildManifest(input());

    // Assert
    expect(manifest.model).toBe("claude-opus-5-5");
    expect(manifest.order).toHaveLength(40);
    expect(manifest.harnessHead).toBe("abc123");
    expect(manifest.payloadTemplateHash).toBe("f00d");
    expect(manifest.claudeVersion).toBe("2.1.286 (Claude Code)");
  });

  test("survives a JSON round trip, as resume reads it back", () => {
    // Act
    const manifest = buildManifest(input());
    const reread = JSON.parse(JSON.stringify(manifest)) as unknown;

    // Assert
    expect(resumeMismatches(reread, manifest)).toEqual([]);
  });

  test("records the run settings and the messaging disallow (A2.1, A2.2)", () => {
    // Act
    const manifest = buildManifest(input());

    // Assert
    expect(manifest.runSettings.crossSessionInbound).toBe("refuse");
    expect(manifest.runSettings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(manifest.claudeArgv).toContain("--disallowed-tools");
    expect(manifest.claudeArgv).toContain("SendMessage");
  });
});

/**
 * A2.5: resume refuses a manifest whose mode, seeded order, harness HEAD or
 * payload-template hash differs from the current one — so `--measured
 * --resume` can never fold a dry run's winners and voids into the
 * measurement — and `--resume` on a dir without a manifest refuses rather
 * than running with none.
 */
describe("resumeMismatches", () => {
  const current = buildManifest(input());
  const stored = (overrides: Partial<ManifestInput>): unknown =>
    JSON.parse(JSON.stringify(buildManifest(input(overrides)))) as unknown;

  test.each([
    ["mode", { mode: "dry-run" as const, order: dryRunOrder() }],
    ["harnessHead", { harnessHead: "def456" }],
    ["payloadTemplateHash", { payloadTemplateHash: "beef" }],
    ["order", { order: measuredOrder(7) }],
  ])("names a different %s", (field, overrides) => {
    // Act
    const mismatches = resumeMismatches(stored(overrides), current);

    // Assert
    expect(mismatches.some((m) => m.startsWith(field))).toBe(true);
  });

  test("names a different seed", () => {
    // Arrange: same order, seed field altered on disk
    const altered = { ...(stored({}) as Record<string, unknown>), seed: 1 };

    // Act / Assert
    expect(resumeMismatches(altered, current).some((m) => m.startsWith("seed"))).toBe(true);
  });

  test("a different claude version alone is not a refusal (every run records its own)", () => {
    // Act / Assert
    expect(resumeMismatches(stored({ claudeVersion: "2.1.290" }), current)).toEqual([]);
  });

  test("a file that is not a manifest is a mismatch, never a pass", () => {
    // Act / Assert
    expect(resumeMismatches({ mode: "measured" }, current).length).toBeGreaterThan(0);
    expect(resumeMismatches(null, current).length).toBeGreaterThan(0);
  });
});

describe("startDecision", () => {
  const current = buildManifest(input());

  test("a fresh dir without --resume writes the manifest", () => {
    // Act / Assert
    expect(startDecision({ resume: false, stored: null, current })).toEqual({ kind: "write" });
  });

  test("an existing manifest without --resume refuses", () => {
    // Act / Assert
    expect(startDecision({ resume: false, stored: current, current }).kind).toBe("refuse");
  });

  test("--resume on a dir with no manifest refuses instead of running with none", () => {
    // Act / Assert
    expect(startDecision({ resume: true, stored: null, current }).kind).toBe("refuse");
  });

  test("--resume against a matching manifest resumes", () => {
    // Act / Assert
    expect(
      startDecision({ resume: true, stored: JSON.parse(JSON.stringify(current)) as unknown, current }),
    ).toEqual({ kind: "resume" });
  });

  test("--measured --resume over a dry run's manifest refuses", () => {
    // Arrange
    const dry = JSON.parse(
      JSON.stringify(buildManifest(input({ mode: "dry-run", order: dryRunOrder() }))),
    ) as unknown;

    // Act
    const decision = startDecision({ resume: true, stored: dry, current });

    // Assert
    expect(decision.kind).toBe("refuse");
  });
});
