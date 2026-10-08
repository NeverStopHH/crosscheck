/**
 * Doctor's "repo runtime files" line (cli/doctor-repo-runtime.ts): a repo's
 * top-level bunfig preload, and `.env*` keys that steer crosscheck, a proxy or
 * TLS — named, never their values — and nothing at all for a clean repo.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasTopLevelPreload, repoRuntimeChecks, steeringKeysIn } from "../src/cli/doctor-repo-runtime.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

const dir = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "cx-repo-runtime-"));
  dirs.push(path);
  return path;
};

describe("what a repo hands bun", () => {
  test("a top-level preload counts; one under [test] does not", () => {
    // Act + Assert
    expect(hasTopLevelPreload('preload = ["./x.ts"]\n')).toBe(true);
    expect(hasTopLevelPreload('logLevel = "warn"\npreload=["./x.ts"]\n[install]\nexact = true\n')).toBe(true);
    expect(hasTopLevelPreload('[test]\npreload = ["./setup.ts"]\n')).toBe(false);
  });

  test("dotenv keys that steer crosscheck, a proxy or TLS are named; others are not", () => {
    // Act
    const keys = steeringKeysIn(
      "CROSSCHECK_HUB_URL=x\nexport HTTP_PROXY=y\nhttps_proxy=z\nNODE_TLS_REJECT_UNAUTHORIZED=0\nDATABASE_URL=w\n# CROSSCHECK_API_KEY=commented\n",
    );

    // Assert
    expect(keys).toEqual(["CROSSCHECK_HUB_URL", "HTTP_PROXY", "https_proxy", "NODE_TLS_REJECT_UNAUTHORIZED"]);
  });

  test("a bait repo WARNs with file paths and key names, never a value", async () => {
    // Arrange
    const repo = await dir();
    await writeFile(join(repo, "bunfig.toml"), 'preload = ["./steal.ts"]\n', "utf8");
    await writeFile(join(repo, ".env"), "CROSSCHECK_HUB_URL=http://127.0.0.1:1\nHTTP_PROXY=SECRET_VALUE_MARKER\n", "utf8");

    // Act
    const checks = await repoRuntimeChecks(repo, repo);

    // Assert
    expect(checks).toHaveLength(1);
    expect(checks[0]?.level).toBe("WARN");
    expect(checks[0]?.detail).toContain(`${join(repo, "bunfig.toml")} sets a bun preload`);
    expect(checks[0]?.detail).toContain(`${join(repo, ".env")} sets CROSSCHECK_HUB_URL, HTTP_PROXY`);
    expect(checks[0]?.detail).not.toContain("SECRET_VALUE_MARKER");
    expect(checks[0]?.detail).not.toContain("127.0.0.1:1");
  });

  test("a clean repo prints nothing", async () => {
    // Arrange
    const repo = await dir();
    await writeFile(join(repo, "bunfig.toml"), '[test]\npreload = ["./setup.ts"]\n', "utf8");
    await writeFile(join(repo, ".env"), "DATABASE_URL=postgres://localhost/dev\n", "utf8");

    // Act + Assert
    expect(await repoRuntimeChecks(repo, repo)).toEqual([]);
  });
});
