/**
 * THE PILOT CHANNELS A HOST CANNOT FEED ARE DECLARED, NOT ABSENT (1.0 spec 07
 * §8.6, PIL-8).
 *
 * Proof 2's tripwire bucket is fed by an ask before an edit, and only Claude
 * Code can make one: Cursor treats ask as advisory, and the ACP proxy forwards
 * permission traffic untouched. A team measured partly through those hosts
 * would read a low tripwire figure as few collisions, when it is really few
 * sessions that could have asked. So each of the two manifests carries the
 * refusal, which its own `doctor` prints on every run — and Claude Code's
 * does not, because there the channel exists.
 *
 * Loaded by path, the way the capability registry test loads them, because
 * this package may not depend on the connectors that depend on it.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { DeriveCapabilityManifest } from "../src/derive/capabilities.ts";

const PACKAGES = join(import.meta.dir, "..", "..");

const manifestOf = async (
  pkg: string,
  exportName: string,
): Promise<DeriveCapabilityManifest> => {
  const module = (await import(join(PACKAGES, pkg, "src", "capabilities.ts"))) as Record<
    string,
    DeriveCapabilityManifest
  >;
  const manifest = module[exportName];
  if (manifest === undefined) {
    throw new Error(`${pkg} exports no ${exportName}`);
  }
  return manifest;
};

const PILOT_TRIPWIRE = "pilot tripwire channel";

describe("the pilot's tripwire channel, per host", () => {
  test("Cursor declares it cannot feed it, and says what the figure then means", async () => {
    // Arrange & Act
    const manifest = await manifestOf("connector-cursor", "CURSOR_CAPABILITY_MANIFEST");
    const refusal = manifest.refusals.find((row) => row.name === PILOT_TRIPWIRE);

    // Assert
    expect(refusal?.sentence).toContain("never fed from this host");
    expect(refusal?.sentence).toContain("not fewer collisions");
  });

  test("ACP declares it too, for its own platform reason", async () => {
    // Arrange & Act
    const manifest = await manifestOf("connector-acp", "ACP_CAPABILITY_MANIFEST");
    const refusal = manifest.refusals.find((row) => row.name === PILOT_TRIPWIRE);

    // Assert
    expect(refusal?.sentence).toContain("never fed from this host");
    expect(refusal?.sentence).toContain("permission traffic");
  });

  test("Claude Code does not — there the channel exists", async () => {
    // Arrange & Act — a refusal where the capability is real would tell a
    // reader to discount a figure that is sound.
    const manifest = await manifestOf("connector-claude", "CLAUDE_CAPABILITY_MANIFEST");

    // Assert
    expect(manifest.refusals.map((row) => row.name)).not.toContain(PILOT_TRIPWIRE);
  });
});
