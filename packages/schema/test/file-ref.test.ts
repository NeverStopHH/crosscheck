/**
 * ONE FILE, ONE SPELLING (1.0 spec 01a §3.3d, CSK-20b, CSK-25).
 *
 * A pin and a touch meet only when they spell the same file the same way.
 * Today they do not have to: the pin door stores `./src/x.ts` verbatim, the
 * touch arrives as `src/x.ts`, and the exact-string intersection `suspect`
 * runs finds nobody — "no session touched this surface", an exoneration
 * produced by a spelling. These pin the canonical form both sides share, and
 * the identity the retention graph will hash from it.
 */
import { describe, expect, test } from "bun:test";

import {
  FILE_REF_DOMAIN,
  canonicalRepoPath,
  fileRef,
} from "../src/file-ref.ts";

const canonical = (raw: string): string | null => {
  const result = canonicalRepoPath(raw);
  return result.ok ? result.path : null;
};

describe("canonicalRepoPath", () => {
  test("every spelling of one path reaches one form", () => {
    // Arrange — the matrix §3.3d names
    const spellings = [
      "src/x.ts",
      "./src/x.ts",
      "src//x.ts",
      "src/./x.ts",
      "./src/./x.ts",
      "src/x.ts/",
      "src///x.ts",
    ];

    // Act & Assert
    for (const spelling of spellings) {
      expect(canonical(spelling), spelling).toBe("src/x.ts");
    }
  });

  test("a decomposed name and a composed one are the same file", () => {
    // Arrange — `é` as one code point (NFC, what git stores) and as `e` plus a
    // combining accent (NFD, what a macOS filesystem can hand back).
    const composed = "src/café.ts";
    const decomposed = "src/café.ts";

    // Act & Assert
    expect(canonical(decomposed)).toBe(composed);
    expect(canonical(composed)).toBe(composed);
  });

  test("a path that could never be a repo file is refused, with its reason", () => {
    // Arrange & Act & Assert — refused rather than stored as a spelling that
    // matches nothing
    expect(canonicalRepoPath("../outside.ts")).toEqual({ ok: false, reason: "parent_segment" });
    expect(canonicalRepoPath("src/../x.ts")).toEqual({ ok: false, reason: "parent_segment" });
    expect(canonicalRepoPath("/etc/passwd")).toEqual({ ok: false, reason: "absolute" });
    expect(canonicalRepoPath("src/x.ts\nsrc/y.ts")).toEqual({ ok: false, reason: "control_character" });
    expect(canonicalRepoPath("src/x.ts\r")).toEqual({ ok: false, reason: "control_character" });
    expect(canonicalRepoPath("src/\u0000x.ts")).toEqual({ ok: false, reason: "control_character" });
    expect(canonicalRepoPath("src\\x.ts")).toEqual({ ok: false, reason: "backslash" });
    expect(canonicalRepoPath("./")).toEqual({ ok: false, reason: "empty" });
    expect(canonicalRepoPath("")).toEqual({ ok: false, reason: "empty" });
  });

  test("a dot that is part of a name is not a segment", () => {
    // Arrange & Act & Assert — `.github`, `..hidden` and `a.b` are names
    expect(canonical(".github/workflows/ci.yml")).toBe(".github/workflows/ci.yml");
    expect(canonical("src/..hidden")).toBe("src/..hidden");
    expect(canonical("src/a.b.ts")).toBe("src/a.b.ts");
  });
});

describe("fileRef", () => {
  test("the field boundary is unambiguous (CSK-25)", () => {
    // Arrange — the collision pair a bare concatenation would merge
    const one = fileRef("github.com/acme/ap", "isrc/x.ts");
    const two = fileRef("github.com/acme/api", "src/x.ts");

    // Assert
    expect(one).not.toBe(two);
  });

  test("the same file in two repos is two identities", () => {
    // Arrange & Act & Assert
    expect(fileRef("github.com/acme/api", "src/x.ts")).not.toBe(
      fileRef("github.com/acme/web", "src/x.ts"),
    );
  });

  test("is the domain-separated SHA-256 the spec pins", () => {
    // Arrange
    const expected = new Bun.CryptoHasher("sha256")
      .update([FILE_REF_DOMAIN, "github.com/acme/api", "src/x.ts"].join("\n"))
      .digest("hex");

    // Act & Assert
    expect(fileRef("github.com/acme/api", "src/x.ts")).toBe(expected);
  });

  test("a repo identity carrying the separator is refused before hashing", () => {
    // Arrange & Act & Assert — the separator is safe only because neither
    // field may contain it
    expect(() => fileRef("github.com/acme/api\nsrc", "x.ts")).toThrow();
    expect(() => fileRef("github.com/acme/api", "src/x.ts\n")).toThrow();
  });
});
