/**
 * The client's release, as the hub compares it (human provenance §10, round
 * 2): a 0.10 client names none and is older than every floor; a release at or
 * past the floor is not.
 */
import { describe, expect, test } from "bun:test";

import { CLIENT_RELEASE, FIRST_DRAFTING_CLIENT_RELEASE, isReleaseAtLeast } from "../src/index.ts";

describe("isReleaseAtLeast", () => {
  test("a missing or malformed release is older than every floor", () => {
    // Assert
    expect(isReleaseAtLeast(undefined, "0.11.0")).toBe(false);
    expect(isReleaseAtLeast(null, "0.11.0")).toBe(false);
    expect(isReleaseAtLeast("", "0.11.0")).toBe(false);
    expect(isReleaseAtLeast("0.11", "0.11.0")).toBe(false);
    expect(isReleaseAtLeast("v0.11.0", "0.11.0")).toBe(false);
    expect(isReleaseAtLeast("0.11.0-beta", "0.11.0")).toBe(false);
  });

  test("an older release is refused part by part; the floor and anything newer pass", () => {
    // Assert
    expect(isReleaseAtLeast("0.10.9", "0.11.0")).toBe(false);
    expect(isReleaseAtLeast("0.10.0", "0.11.0")).toBe(false);
    expect(isReleaseAtLeast("0.11.0", "0.11.0")).toBe(true);
    expect(isReleaseAtLeast(" 0.11.0 ", "0.11.0")).toBe(true);
    expect(isReleaseAtLeast("0.11.1", "0.11.0")).toBe(true);
    expect(isReleaseAtLeast("0.12.0", "0.11.0")).toBe(true);
    expect(isReleaseAtLeast("1.0.0", "0.11.0")).toBe(true);
    expect(isReleaseAtLeast("0.9.99", "0.11.0")).toBe(false);
  });

  test("this client's own release passes the drafting floor", () => {
    // Assert
    expect(isReleaseAtLeast(CLIENT_RELEASE, FIRST_DRAFTING_CLIENT_RELEASE)).toBe(true);
  });
});
