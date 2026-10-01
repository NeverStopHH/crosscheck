import { describe, expect, test } from "bun:test";

import { buildManifest } from "../bench/at7/manifest-doc.ts";
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
