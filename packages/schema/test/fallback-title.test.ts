/**
 * IS THIS TITLE ITS OWNER'S LOCATION? The hub withholds a work-context
 * title from a colleague of a developer who opted out of presence exactly
 * when it is (server services/live-location.ts).
 *
 * The connector says how it wrote the title (`titleSource`). Only a row
 * without the marker — an older connector's — is judged by its shape, and
 * the shape is judged against everything a fallback can be: the bare
 * branch (a `local:` repo has no label), `<branch> @ <label>`, or a
 * detached ref with or without its commit subject.
 */
import { describe, expect, test } from "bun:test";

import { isLocationTitle } from "../src/fallback-title.ts";

const REMOTE = "github.com/acme/api";
const LOCAL = "local:0123456789abcdef";

describe("isLocationTitle", () => {
  test("a title its connector marked as the fallback always is", () => {
    expect(isLocationTitle({ title: "Anything at all", titleSource: "fallback", branch: "main", repo: REMOTE })).toBe(true);
  });

  test("a title a host or a person wrote never is, even one shaped like the fallback", () => {
    expect(isLocationTitle({ title: "Fix the 500 on POST /login @ api", titleSource: "host", branch: "main", repo: REMOTE })).toBe(false);
    expect(isLocationTitle({ title: "feat/x @ api", titleSource: "person", branch: "feat/x", repo: REMOTE })).toBe(false);
  });

  test("an unmarked title is its branch, the `<branch> @ <label>` shape, or a detached ref", () => {
    expect(isLocationTitle({ title: "feat/hideout", titleSource: null, branch: "feat/hideout", repo: LOCAL })).toBe(true);
    expect(isLocationTitle({ title: "anything @ api", titleSource: null, branch: "feat/x", repo: REMOTE })).toBe(true);
    expect(isLocationTitle({ title: "detached@beefbeef · Try the other key order", titleSource: null, branch: "feat/x", repo: LOCAL })).toBe(true);
    expect(isLocationTitle({ title: "detached@beefbeef", titleSource: null, branch: null, repo: LOCAL })).toBe(true);
  });

  test("an unmarked title in none of those shapes is not", () => {
    expect(isLocationTitle({ title: "Login 500s on staging", titleSource: null, branch: "main", repo: REMOTE })).toBe(false);
    expect(isLocationTitle({ title: "detached@release notes", titleSource: null, branch: "main", repo: LOCAL })).toBe(false);
    expect(isLocationTitle({ title: "Rotation drill", titleSource: null, branch: null, repo: LOCAL })).toBe(false);
  });
});
