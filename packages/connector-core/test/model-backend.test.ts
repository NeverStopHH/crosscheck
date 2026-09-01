/**
 * WHETHER ANYTHING ON THIS MACHINE CAN DERIVE AT ALL.
 *
 * All four derive tasks — the summarizer, the session intent, the ghost
 * check and the conference — spawn ONE resolved argv, and on a machine with
 * neither `CROSSCHECK_SUMMARIZER_CMD` nor a `claude` binary that argv cannot
 * start. Before this existed the fact was known only to the Claude
 * connector's probe, which called it "skipped" and told a Cursor- or ACP-only
 * machine it could be ignored — the exact machine every rung on this branch
 * depends on it for.
 *
 * So the fact gets ONE definition, here, and every surface reads it rather
 * than re-deriving it and drifting.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveBackendSentence,
  resolveDeriveBackend,
} from "../src/model/backend.ts";

const paths: string[] = [];

afterAll(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

const emptyDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-backend-"));
  paths.push(dir);
  return dir;
};

describe("resolveDeriveBackend", () => {
  test("an override is a backend, whatever else the machine has", async () => {
    // Arrange — no claude reachable anywhere on this PATH
    const dir = await emptyDir();

    // Act
    const backend = resolveDeriveBackend({
      PATH: dir,
      CROSSCHECK_SUMMARIZER_CMD: "/opt/ox/alpha.sh",
    });

    // Assert
    expect(backend).toEqual({ kind: "override", command: "/opt/ox/alpha.sh" });
  });

  test("an EMPTY override is not a backend — it is an unset variable", async () => {
    const dir = await emptyDir();
    expect(
      resolveDeriveBackend({ PATH: dir, CROSSCHECK_SUMMARIZER_CMD: "" }).kind,
    ).toBe("absent");
  });

  test("a claude on PATH is the default backend", async () => {
    const dir = await emptyDir();
    const binary = join(dir, "claude");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(binary, 0o755);

    expect(resolveDeriveBackend({ PATH: dir })).toEqual({ kind: "default" });
  });

  test("neither one is ABSENT — the state this branch exists for", async () => {
    const dir = await emptyDir();
    expect(resolveDeriveBackend({ PATH: dir })).toEqual({ kind: "absent" });
  });

  test("no PATH at all is absent, not a crash", () => {
    expect(resolveDeriveBackend({}).kind).toBe("absent");
  });
});

describe("deriveBackendSentence", () => {
  test("the absent sentence says nothing derives, and where to read why", () => {
    const said = deriveBackendSentence({ kind: "absent" });
    expect(said).toContain("nothing on this machine can derive");
    expect(said).toContain("docs/FOREIGN-MODELS.md");
    // Deterministic capture is a DIFFERENT lane and must not be tarred here:
    // a reader who sees this line must not conclude crosscheck is dead.
    expect(said).toContain("deterministic capture is unaffected");
  });

  test("an override names the command, so a wrapper typo is visible", () => {
    expect(deriveBackendSentence({ kind: "override", command: "/opt/ox/a.sh" })).toContain(
      "/opt/ox/a.sh",
    );
  });

  test("the default backend says which binary it resolved to", () => {
    expect(deriveBackendSentence({ kind: "default" })).toContain("claude");
  });
});
