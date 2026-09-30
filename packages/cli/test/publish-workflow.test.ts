/**
 * What `.github/workflows/publish.yml` promises, asserted over its text.
 *
 * No test can run the workflow: it only fires on a pushed tag, on GitHub, with
 * an OIDC token npm accepts. So its guarantees are pinned the way spec 05's
 * CI-1 pins the reporter step — as string assertions over the YAML, stated as
 * such: it publishes only from a tag, only after the preflight, only the
 * tarball the pack script built, and with no npm token anywhere.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const WORKFLOW_PATH = join(import.meta.dir, "..", "..", "..", ".github", "workflows", "publish.yml");
const PREFLIGHT = "run: bun packages/cli/scripts/release-preflight.ts";
const PACK = 'run: echo "TARBALL=$(bun packages/cli/scripts/pack-npm.ts | tail -1)" >> "$GITHUB_ENV"';
const PUBLISH = 'run: npm publish "$TARBALL"';

const workflow = await Bun.file(WORKFLOW_PATH).text();

/** The top-level `permissions:` block, up to the next top-level key. */
const permissionsBlock = (text: string): string => {
  const start = text.indexOf("\npermissions:\n");
  const end = text.indexOf("\nconcurrency:\n");
  if (start < 0 || end < start) {
    throw new Error("publish.yml no longer has a top-level permissions block before concurrency");
  }
  return text.slice(start, end);
};

describe("the publish workflow", () => {
  test("fires only on a pushed release tag", () => {
    expect(workflow).toContain('on:\n  push:\n    tags: ["v*"]\n');
    expect(workflow).not.toContain("pull_request");
    expect(workflow).not.toContain("branches:");
    expect(workflow).not.toContain("workflow_dispatch");
  });

  test("asks for an OIDC token and nothing it could write with", () => {
    const permissions = permissionsBlock(workflow);
    expect(permissions).toContain("id-token: write");
    expect(permissions).toContain("contents: read");
    expect(permissions).toContain("actions: read");
    expect(permissions).not.toContain("contents: write");
  });

  test("carries no npm token of any kind", () => {
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("secrets.");
  });

  test("runs the preflight, then packs, then publishes that tarball", () => {
    const preflight = workflow.indexOf(PREFLIGHT);
    const pack = workflow.indexOf(PACK);
    const publish = workflow.indexOf(PUBLISH);
    expect(preflight).toBeGreaterThan(0);
    expect(pack).toBeGreaterThan(preflight);
    expect(publish).toBeGreaterThan(pack);
  });

  test("uses an npm that can publish through OIDC, and full history for the on-main check", () => {
    expect(workflow).toContain("npm install -g npm@^11.5.1");
    expect(workflow).toContain("fetch-depth: 0");
  });
});
