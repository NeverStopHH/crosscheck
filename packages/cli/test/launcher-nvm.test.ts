/**
 * A launcher that belongs to one runtime version (trial finding M9).
 *
 * `resolveLauncher` calls any PATH hit `bare` once it is not a package-runner
 * cache and answers `--version` with our own banner — including
 * `~/.nvm/versions/node/v22.4.0/bin/crosscheck`. `init` then writes the naked
 * command `crosscheck` into six hooks, and after `nvm use 20` the name is gone
 * from PATH: every fire exits 127. It is loud (Claude Code prints a hook error
 * per fire) and the capture is lost anyway, and nothing on the machine said
 * the install was that fragile in the first place.
 *
 * A REAL shim, executed for real: the identity probe runs `<bin> --version`,
 * so a stub that is not executable would fail for the wrong reason.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isVersionManagerPath } from "@crosscheck/connector-core/config/launcher.ts";
import { checkLauncherCommand } from "@crosscheck/connector-core/config/launcher-check.ts";

const KEYWORDS = ["hook", "statusline"] as const;
const HOOK_COMMAND = "crosscheck hook session-start";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

/** An executable `crosscheck` that identifies as ours, at `relativeBin`. */
const shimAt = async (relativeBin: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "cx-launcher-"));
  paths.push(root);
  const binDir = join(root, relativeBin);
  await mkdir(binDir, { recursive: true });
  const bin = join(binDir, "crosscheck");
  await writeFile(bin, "#!/bin/sh\necho 'crosscheck 0.7.2'\n", "utf8");
  await chmod(bin, 0o755);
  return binDir;
};

describe("isVersionManagerPath", () => {
  test("recognises the four version managers that version their bin dirs", () => {
    // Arrange + Act + Assert
    expect(
      isVersionManagerPath("/Users/dev/.nvm/versions/node/v22.4.0/bin/crosscheck"),
    ).toBe(true);
    expect(
      isVersionManagerPath(
        "/Users/dev/.fnm/node-versions/v20.11.0/installation/bin/crosscheck",
      ),
    ).toBe(true);
    expect(
      isVersionManagerPath(
        "/Users/dev/.volta/tools/image/node/22.4.0/bin/crosscheck",
      ),
    ).toBe(true);
    expect(
      isVersionManagerPath(
        "/Users/dev/.asdf/installs/nodejs/22.4.0/bin/crosscheck",
      ),
    ).toBe(true);
  });

  test("a permanent install is not one", () => {
    // Arrange + Act + Assert
    expect(isVersionManagerPath("/usr/local/bin/crosscheck")).toBe(false);
    expect(isVersionManagerPath("/opt/homebrew/bin/crosscheck")).toBe(false);
    // A directory merely CONTAINING "node" is not a version manager layout.
    expect(isVersionManagerPath("/srv/node/bin/crosscheck")).toBe(false);
  });
});

describe("checkLauncherCommand", () => {
  test("a bare launcher under nvm WARNs, naming nvm and the pin command", async () => {
    // Arrange: exactly the teammate's shape — the nvm bin first on PATH
    const binDir = await shimAt(join(".nvm", "versions", "node", "v22.0.0", "bin"));

    // Act
    const result = await checkLauncherCommand(
      HOOK_COMMAND,
      { PATH: binDir },
      KEYWORDS,
    );

    // Assert
    expect(result.level).toBe("WARN");
    expect(result.detail).toContain("version manager");
    expect(result.detail).toContain("nvm use");
    expect(result.detail).toContain("--command-prefix");
  });

  test("the same shim outside a version manager still passes", async () => {
    // Arrange: the control arm — same binary, permanent location
    const binDir = await shimAt(join("usr-local", "bin"));

    // Act
    const result = await checkLauncherCommand(
      HOOK_COMMAND,
      { PATH: binDir },
      KEYWORDS,
    );

    // Assert
    expect(result.level).toBe("PASS");
  });

  test("nothing on PATH is still the louder FAIL, not the nvm WARN", async () => {
    // Arrange
    const empty = await mkdtemp(join(tmpdir(), "cx-launcher-empty-"));
    paths.push(empty);

    // Act
    const result = await checkLauncherCommand(
      HOOK_COMMAND,
      { PATH: empty },
      KEYWORDS,
    );

    // Assert
    expect(result.level).toBe("FAIL");
    expect(result.detail).toContain("nothing by that name is on PATH");
  });
});
