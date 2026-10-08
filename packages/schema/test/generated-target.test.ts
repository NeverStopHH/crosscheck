/**
 * The PATH signal of the generated-target rule, and the wire field that
 * carries a connector's classification. The path signal is the one both sides
 * apply — the connector to every captured path, the hub to every target an
 * older connector sends without the field — so it is pinned here, once.
 */
import { describe, expect, test } from "bun:test";

import {
  GENERATED_LOCKFILE_NAMES,
  TargetSchema,
  isGeneratedPath,
} from "../src/index.ts";

const TARGET = { workContextId: "wc_1", kind: "file", value: "apps/x/package-lock.json" } as const;

describe("isGeneratedPath — well-known names at ANY depth", () => {
  test("every lockfile name is generated at the root and nested", () => {
    for (const name of GENERATED_LOCKFILE_NAMES) {
      expect(isGeneratedPath(name), name).toBe(true);
      expect(isGeneratedPath(`apps/practice/${name}`), `nested ${name}`).toBe(true);
    }
  });

  test("the lockfiles the release gate names are all in the list", () => {
    // Arrange: the gate's spec list, verbatim.
    const named = [
      "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock",
      "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock", "go.sum",
    ];

    // Assert
    expect([...GENERATED_LOCKFILE_NAMES].map(String).sort()).toEqual([...named].sort());
  });

  test("a directory named for machine output, at any depth", () => {
    expect(isGeneratedPath("packages/api/src/__generated__/schema.ts")).toBe(true);
    expect(isGeneratedPath("__generated__/schema.ts")).toBe(true);
    expect(isGeneratedPath("packages/api/generated/client.ts")).toBe(true);
    expect(isGeneratedPath("packages/ui/dist/index.js")).toBe(true);
  });

  test("codegen names: *.generated.*, *.gen.*, protobuf output", () => {
    expect(isGeneratedPath("packages/api/src/client.generated.ts")).toBe(true);
    expect(isGeneratedPath("src/routes.gen.ts")).toBe(true);
    expect(isGeneratedPath("proto/messages_pb2.py")).toBe(true);
    expect(isGeneratedPath("proto/messages.pb.go")).toBe(true);
    expect(isGeneratedPath("web/src/messages_pb.ts")).toBe(true);
    expect(isGeneratedPath("web/src/messages_pb.js")).toBe(true);
  });

  test("ordinary files stay ordinary, near-misses included", () => {
    for (const path of [
      "apps/streaming/feed.ts",
      "src/generated.ts",
      "src/generator/index.ts",
      "src/distance.ts",
      "src/a.genuine.ts",
      "docs/lockfile.md",
      "src/package-lock.json.ts",
      "src/messages_pb.tsx",
    ]) {
      expect(isGeneratedPath(path), path).toBe(false);
    }
  });
});

describe("TargetSchema.generated — additive, optional, tolerant", () => {
  test("a target without the field parses, unlabelled", () => {
    const result = TargetSchema.parse(TARGET);

    expect(result.generated).toBeUndefined();
  });

  test("each signal round-trips", () => {
    for (const signal of ["path", "attribute", "header"] as const) {
      expect(TargetSchema.parse({ ...TARGET, generated: signal }).generated).toBe(signal);
    }
  });

  test("a value this build does not know reads as ORDINARY, and the touch is kept", () => {
    // Act: a newer connector's label, or garbage.
    const result = TargetSchema.safeParse({ ...TARGET, generated: "vendored-by-a-future-build" });

    // Assert: the record is accepted and the label is gone — never a reason to drop the touch.
    expect(result.success).toBe(true);
    expect(result.data?.generated).toBeUndefined();
  });
});
