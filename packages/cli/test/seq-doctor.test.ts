/**
 * THE CAUSAL ORDER'S FAILURES ARE PRINTED, never inferred from silence.
 *
 * Both conditions leave a machine looking completely healthy: the claims land,
 * the intents land, the targets land, and only *whether the reason predated
 * the change* quietly stops being answerable. Nothing else in this product
 * would mention either one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "../src/index.ts";
import {
  deriveSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const HUB = "http://127.0.0.1:1";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const seed = async (
  home: string,
  key: string,
  repoRoot: string,
  seqEpoch: string | null,
  eventSeq: number,
): Promise<void> => {
  await writeSessionState(home, {
    ...deriveSessionState({
      hostSessionKey: key,
      repoId: REPO_ID,
      repoRoot,
      hubUrl: HUB,
      developerId: "dev_self",
      startedAt: new Date().toISOString(),
    }),
    lastHeartbeatAt: new Date().toISOString(),
    seqEpoch,
    eventSeq,
  });
};

const doctorOutput = async (home: string, repo: string): Promise<string> => {
  const result = await runCli(
    ["doctor"],
    {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB,
      CROSSCHECK_API_KEY: "k",
      CROSSCHECK_SSH_CANONICALIZE: "off",
    },
    repo,
  );
  return result.stdout;
};

describe("doctor prints the event sequence", () => {
  test("a healthy machine PASSes with the positions it handed out", async () => {
    // Arrange
    const home = await makeHome("seq-doctor-ok");
    const repo = await makeRepo("seq-doctor-ok", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    await seed(home, "a-uuid", repo, EPOCH, 12);

    // Act
    const output = await doctorOutput(home, repo);

    // Assert
    expect(output).toContain("event sequence");
    expect(output).toContain("12 position(s) allocated");
    expect(output).not.toContain("WARN  event sequence");
    // ...and ABSENT IS NOT ZERO. This hub is unreachable, so the two failures
    // only the hub can see were never measured — and a line that reported
    // "none broken" here would be an assertion nobody made.
    expect(output).not.toContain("on the hub cannot be ordered");
    // The same for the hub's retention: nobody declared one, so nothing may
    // be printed as though a hub had.
    expect(output).toContain("PASS  session-event retention  not measured");
    expect(output).not.toContain("nothing deletes session events");
  });

  test("two sessions in one worktree WARN, and the line names the remedy", async () => {
    // Arrange: an MCP tool cannot tell which of these two is calling it, so
    // every intent and claim it files lands without a position.
    const home = await makeHome("seq-doctor-ambiguous");
    const repo = await makeRepo("seq-doctor-ambiguous", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    await seed(home, "a-uuid", repo, EPOCH, 3);
    await seed(home, "b-uuid", repo, EPOCH, 5);

    // Act
    const output = await doctorOutput(home, repo);

    // Assert: the count, the consequence, and something to do about it.
    expect(output).toContain("event sequence");
    expect(output).toContain("1 worktree");
    expect(output).toContain("MCP positions refused there");
    expect(output).toContain("give each its own worktree");
  });

  test("a session with no epoch WARNs that its work is unordered", async () => {
    // Arrange: a state file from before this protocol field.
    const home = await makeHome("seq-doctor-legacy");
    const repo = await makeRepo("seq-doctor-legacy", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    await seed(home, "a-uuid", repo, null, 0);

    // Act
    const output = await doctorOutput(home, repo);

    // Assert
    expect(output).toContain("1 with no position at all");
    expect(output).toContain("everything it records is unordered");
  });
});
