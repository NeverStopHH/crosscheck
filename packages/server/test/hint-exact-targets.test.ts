/**
 * WHAT THE EXACT TIER MATCHES A PROMPT'S FILES ON (hold-out review round 5):
 *
 *   M1 — a path as a stack trace writes it, "(…/permissions.ts:27:13)", or a
 *   link, "…/permissions.ts#L27", is the file it names, so the tree that
 *   touched it is matched on the fact, not on its words alone;
 *   M4 — a conventional file name alone ("Dockerfile", ".nvmrc") is in every
 *   repo, and a tree it matches needs a shared topical word beside it.
 */
import { describe, expect, test } from "bun:test";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;

interface CandidateView {
  readonly workContext: { readonly id: string; readonly tier: string };
  readonly matchedTargets: readonly { readonly value: string }[];
}

const candidatesOf = async (harness: TestHarness, developer: TestDeveloper, query: string): Promise<readonly CandidateView[]> => {
  const search = new URLSearchParams({ repo: REPO, query });
  const response = await harness.app.request(`/api/hints/candidates?${search.toString()}`, jsonRequest("GET", developer.apiKey));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly CandidateView[] } };
  return body.data.candidates;
};

/** Ken's tree, with its files and one claim. */
const seedTree = async (title: string, files: readonly string[], claim: string): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
  const { harness, developer: ken } = await createHarnessWithSession();
  const records = [
    recordEnvelope("work_context", validWorkContextBody({ title, description: "Teammate work" })),
    ...files.map((value) => recordEnvelope("target", { workContextId: WORK_CONTEXT_ID, kind: "file", value })),
    recordEnvelope("claim", validClaimBody({ id: "clm_tree", body: claim })),
  ];
  const seeded = await postRecords(harness, ken, { records });
  expect(seeded.data?.accepted).toBe(records.length);
  const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
  return { harness, robin };
};

describe("a stack trace's path is the file it names (round 5, M1)", () => {
  const PATH = "packages/api/src/auth/permissions.ts";
  const setup = () => seedTree("Project deletion permissions for owners", [PATH], "The guard denies projects:delete to project owners");

  test.each([
    ["ForbiddenException: Missing permission projects:delete\n    at PermissionsGuard.canActivate (packages/api/src/auth/permissions.ts:27:13)"],
    ["why does packages/api/src/auth/permissions.ts:27 throw for owners"],
    ["see packages/api/src/auth/permissions.ts#L27 — owners get a 403"],
    ["the guard in `packages/api/src/auth/permissions.ts`, line 27, denies owners"],
  ])("%p reaches the tree on the file it touched", async (prompt) => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await candidatesOf(harness, robin, prompt);

    // Assert — matched on the fact, and the pointer can name the file
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
    expect(candidates[0]?.workContext.tier).toBe("exact");
    expect(candidates[0]?.matchedTargets.map((target) => target.value)).toEqual([PATH]);
  });
});

describe("a conventional file name alone is no fact about the work (round 5, M4)", () => {
  const setup = () =>
    seedTree(
      "Docker compose dev environment on Apple Silicon (arm64 images)",
      ["docker-compose.yml", "docker/postgres/Dockerfile"],
      "The postgis image has no arm64 build; switch to a multi-arch image",
    );

  test("a prompt that shares only the name gets no candidate", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const ids = (await candidatesOf(harness, robin, "bump node to 22 in .nvmrc and the Dockerfile")).map((candidate) => candidate.workContext.id);

    // Assert
    expect(ids).toEqual([]);
  });

  test("the name beside a topical word of the tree is still a match", async () => {
    // Arrange
    const { harness, robin } = await setup();

    // Act
    const candidates = await candidatesOf(harness, robin, "the Dockerfile pulls postgis without arm64");

    // Assert
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
    expect(candidates[0]?.workContext.tier).toBe("exact");
  });

  test.each([["docker/postgres/Dockerfile"], ["postgres/Dockerfile"]])("the conventional name written as the tree's path, %p, is a fact", async (path) => {
    // Arrange
    const { harness, robin } = await setup();

    // Act — no topical word beside it
    const candidates = await candidatesOf(harness, robin, `bump node to 22 in ${path}`);

    // Assert
    expect(candidates.map((candidate) => candidate.workContext.id)).toEqual([WORK_CONTEXT_ID]);
    expect(candidates[0]?.matchedTargets.map((target) => target.value)).toEqual(["docker/postgres/Dockerfile"]);
  });
});
