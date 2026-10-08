/**
 * The connector half of the generated-target rule (capture/generated.ts):
 * each signal on its own, the attribute cache, and the direction a
 * classification that cannot run must fail in — toward an ORDINARY target,
 * never toward silence. Driven through the one capture flow every host's edit
 * and the git lane go through, so what is pinned here is what all three
 * connectors send.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyGenerated, hasGeneratedHeader } from "../src/capture/generated.ts";
import { generatedAttributesCachePath, repoKey } from "../src/config/paths.ts";
import { captureFileTargets } from "../src/flows/capture-targets.ts";
import type { Producer } from "../src/capture/records.ts";
import { readSpoolLines } from "../src/spool/files.ts";
import { git, makeHome, makeRepo, writeRepoFile } from "./helpers.ts";

const KEY = repoKey("http://127.0.0.1:9", "github.com/acme/api");
const NOW = new Date("2026-10-08T10:00:00.000Z");
const PRODUCER: Producer = { developerId: "dev_1", agentKind: "test", sessionId: "cc_1" };
/** A deadline no git can meet: the attribute call cannot answer. */
const UNMEETABLE_MS = 0;
const ATTRIBUTE_RULES = [
  "packages/proto/** linguist-generated=true",
  "third_party/** linguist-vendored",
  "packages/proto/src/hand-written.ts -linguist-generated",
  "packages/legacy/** linguist-generated=false",
  "",
].join("\n");

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  cleanups.length = 0;
});

interface Fixture {
  readonly home: string;
  readonly repo: string;
}

const fixture = async (label: string, attributes: string | null = ATTRIBUTE_RULES): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  if (attributes !== null) {
    await writeRepoFile(repo, ".gitattributes", attributes);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "attributes"]);
  }
  return { home, repo };
};

const capture = async (fx: Fixture, paths: readonly string[]) =>
  captureFileTargets({
    home: fx.home,
    repoKey: KEY,
    hostSessionKey: "generated-targets",
    repoRoot: fx.repo,
    cwd: fx.repo,
    paths,
    denylist: null,
    seenTargets: [],
    workContextId: "wc_1",
    producer: PRODUCER,
    now: NOW,
  });

/** value → the `generated` field each spooled target carries (undefined = none). */
const spooled = async (fx: Fixture): Promise<ReadonlyMap<string, string | undefined>> =>
  new Map(
    (await readSpoolLines(fx.home, KEY))
      .map((line) => JSON.parse(line) as { kind: string; body: { value: string; generated?: string } })
      .filter((record) => record.kind === "target")
      .map((record) => [record.body.value, record.body.generated]),
  );

const classify = async (fx: Fixture, paths: readonly string[], attrTimeoutMs?: number) =>
  classifyGenerated({
    home: fx.home,
    root: fx.repo,
    paths,
    ...(attrTimeoutMs === undefined ? {} : { attrTimeoutMs }),
  });

describe("the path signal", () => {
  test("a nested lockfile and a __generated__ file are spooled KEPT, labelled `path`", async () => {
    // Arrange: both are names the root-anchored denylist misses.
    const fx = await fixture("gen-path");
    await writeRepoFile(fx.repo, "apps/practice/package-lock.json", "{}\n");
    await writeRepoFile(fx.repo, "packages/api/src/__generated__/schema.ts", "export {};\n");
    await writeRepoFile(fx.repo, "src/feed.ts", "export const feed = 1;\n");

    // Act
    const result = await capture(fx, [
      "apps/practice/package-lock.json",
      "packages/api/src/__generated__/schema.ts",
      "src/feed.ts",
    ]);

    // Assert: kept as targets — `suspect` still sees the touch — and labelled.
    expect(result.captured).toEqual([
      "apps/practice/package-lock.json",
      "packages/api/src/__generated__/schema.ts",
      "src/feed.ts",
    ]);
    const labels = await spooled(fx);
    expect(labels.get("apps/practice/package-lock.json")).toBe("path");
    expect(labels.get("packages/api/src/__generated__/schema.ts")).toBe("path");
    expect(labels.has("src/feed.ts")).toBe(true);
    expect(labels.get("src/feed.ts")).toBeUndefined();
    expect(result.generated).toEqual({ path: 2, attribute: 0, header: 0, unknown: 0 });
  });

  test("a path-signal file needs no git and no read: it is generated even where git cannot answer", async () => {
    // Arrange: not a repository at all.
    const home = await makeHome("gen-path-nogit");
    const root = await mkdtemp(join(tmpdir(), "cx-gen-nogit-"));
    cleanups.push(home, root);

    // Act
    const classified = await classifyGenerated({ home, root, paths: ["apps/x/pnpm-lock.yaml"] });

    // Assert
    expect(classified.get("apps/x/pnpm-lock.yaml")).toBe("path");
  });
});

describe("the attribute signal", () => {
  test("linguist-generated and linguist-vendored set a target `attribute`; unset and false do not", async () => {
    // Arrange
    const fx = await fixture("gen-attr");
    for (const path of [
      "packages/proto/src/messages.ts",
      "third_party/lib/index.ts",
      "packages/proto/src/hand-written.ts",
      "packages/legacy/old.ts",
      "src/plain.ts",
    ]) {
      await writeRepoFile(fx.repo, path, "export const value = 1;\n");
    }

    // Act
    const result = await capture(fx, [
      "packages/proto/src/messages.ts",
      "third_party/lib/index.ts",
      "packages/proto/src/hand-written.ts",
      "packages/legacy/old.ts",
      "src/plain.ts",
    ]);

    // Assert
    const labels = await spooled(fx);
    expect(labels.get("packages/proto/src/messages.ts")).toBe("attribute");
    expect(labels.get("third_party/lib/index.ts")).toBe("attribute");
    expect(labels.get("packages/proto/src/hand-written.ts")).toBeUndefined();
    expect(labels.get("packages/legacy/old.ts")).toBeUndefined();
    expect(labels.get("src/plain.ts")).toBeUndefined();
    expect(result.generated).toEqual({ path: 0, attribute: 2, header: 0, unknown: 0 });
  });

  test("the answer is CACHED: a second classification needs no git at all", async () => {
    // Arrange: one classification that asks git and writes the cache.
    const fx = await fixture("gen-cache");
    await writeRepoFile(fx.repo, "packages/proto/src/messages.ts", "export {};\n");
    await writeRepoFile(fx.repo, "src/plain.ts", "export {};\n");
    const first = await classify(fx, ["packages/proto/src/messages.ts", "src/plain.ts"]);

    // Act: the same paths with a deadline git cannot meet.
    const second = await classify(fx, ["packages/proto/src/messages.ts", "src/plain.ts"], UNMEETABLE_MS);

    // Assert: the cache answered both — a git call would have made them unknown.
    expect(first.get("packages/proto/src/messages.ts")).toBe("attribute");
    expect(second.get("packages/proto/src/messages.ts")).toBe("attribute");
    expect(second.get("src/plain.ts")).toBe("ordinary");
    expect(await Bun.file(generatedAttributesCachePath(fx.home, fx.repo)).exists()).toBe(true);
  });

  test("the cache is keyed by the .gitattributes blob: an edited file invalidates every answer", async () => {
    // Arrange: cached under the original rules.
    const fx = await fixture("gen-cache-key");
    await writeRepoFile(fx.repo, "packages/proto/src/messages.ts", "export {};\n");
    expect((await classify(fx, ["packages/proto/src/messages.ts"])).get("packages/proto/src/messages.ts")).toBe(
      "attribute",
    );

    // Act: the rule is removed.
    await writeRepoFile(fx.repo, ".gitattributes", "");
    const after = await classify(fx, ["packages/proto/src/messages.ts"]);

    // Assert: asked again, under the new file.
    expect(after.get("packages/proto/src/messages.ts")).toBe("ordinary");
  });

  test("the cache file stays in cache/, where the temp sweep reaches its temps", async () => {
    // Arrange
    const fx = await fixture("gen-cache-dir");
    await writeRepoFile(fx.repo, "src/plain.ts", "export {};\n");

    // Act
    await classify(fx, ["src/plain.ts"]);

    // Assert
    expect((await readdir(join(fx.home, "cache"))).filter((name) => name.startsWith("generated-"))).toHaveLength(1);
  });
});

describe("the header signal", () => {
  test("an @generated token or a Code generated … DO NOT EDIT. line in a comment", () => {
    expect(hasGeneratedHeader("// Code generated by protoc-gen-go. DO NOT EDIT.\npackage x\n")).toBe(true);
    expect(hasGeneratedHeader("/**\n * @generated SignedSource<<abc>>\n */\n")).toBe(true);
    expect(hasGeneratedHeader("# @generated by uv\n")).toBe(true);
    expect(hasGeneratedHeader("-- Code generated by sqlc. DO NOT EDIT.\n")).toBe(true);
  });

  test("a file that merely MENTIONS the marker in prose or code is hand-written", () => {
    expect(hasGeneratedHeader("/**\n * a file with an `@generated` token is skipped\n */\n")).toBe(false);
    expect(hasGeneratedHeader('const marker = "@generated";\n')).toBe(false);
    expect(hasGeneratedHeader("// Code generated files are fine to read\n")).toBe(false);
  });

  test("the marker is read from the file's first bytes, and only those", async () => {
    // Arrange: one marker in the head, one past it.
    const fx = await fixture("gen-header", null);
    await writeRepoFile(fx.repo, "src/client.ts", "// Code generated by openapi. DO NOT EDIT.\nexport {};\n");
    await writeRepoFile(fx.repo, "src/late.ts", `${"// filler line\n".repeat(64)}// @generated\n`);

    // Act
    const result = await capture(fx, ["src/client.ts", "src/late.ts"]);

    // Assert
    const labels = await spooled(fx);
    expect(labels.get("src/client.ts")).toBe("header");
    expect(labels.get("src/late.ts")).toBeUndefined();
    expect(result.generated.header).toBe(1);
  });
});

describe("fail toward warning: a classification that cannot run keeps the target ORDINARY", () => {
  test("git missing or not a repository: unknown, counted, sent with no label", async () => {
    // Arrange: a plain directory — check-attr exits 128.
    const home = await makeHome("gen-unknown-nogit");
    const root = await mkdtemp(join(tmpdir(), "cx-gen-unknown-"));
    cleanups.push(home, root);
    await writeRepoFile(root, "packages/proto/src/messages.ts", "export {};\n");

    // Act
    const result = await captureFileTargets({
      home,
      repoKey: KEY,
      hostSessionKey: "generated-unknown",
      repoRoot: root,
      cwd: root,
      paths: ["packages/proto/src/messages.ts"],
      denylist: null,
      seenTargets: [],
      workContextId: "wc_1",
      producer: PRODUCER,
      now: NOW,
    });

    // Assert: kept, unlabelled — the hub will treat it as overlap evidence.
    expect(result.captured).toEqual(["packages/proto/src/messages.ts"]);
    expect(result.generated).toEqual({ path: 0, attribute: 0, header: 0, unknown: 1 });
    const records = (await readSpoolLines(home, KEY)).map((line) => JSON.parse(line) as { body: Record<string, unknown> });
    expect(records[0]?.body["generated"]).toBeUndefined();
  });

  test("a check-attr that misses its deadline is unknown — and is never cached as an answer", async () => {
    // Arrange: a file the rules WOULD mark generated.
    const fx = await fixture("gen-unknown-timeout");
    await writeRepoFile(fx.repo, "packages/proto/src/messages.ts", "export {};\n");

    // Act
    const timedOut = await classify(fx, ["packages/proto/src/messages.ts"], UNMEETABLE_MS);
    const retried = await classify(fx, ["packages/proto/src/messages.ts"]);

    // Assert: unknown, not generated; the next capture asked git again.
    expect(timedOut.get("packages/proto/src/messages.ts")).toBe("unknown");
    expect(retried.get("packages/proto/src/messages.ts")).toBe("attribute");
  });

  test("an unreadable file is unknown, not generated and not a measured ordinary", async () => {
    // Arrange: attributes say no, and the header cannot be read.
    const fx = await fixture("gen-unknown-unreadable");
    const path = await writeRepoFile(fx.repo, "src/locked.ts", "// @generated\n");
    await chmod(path, 0o000);

    // Act
    const classified = await classify(fx, ["src/locked.ts"]);
    await chmod(path, 0o644);

    // Assert
    expect(classified.get("src/locked.ts")).toBe("unknown");
  });
});
