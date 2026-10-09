/**
 * A TOPIC ID NAMES NO BRANCH (batch-2 integration review, H3).
 *
 * The id was sha256(repo, root) and the decimal of sha256(branch)'s first 8
 * hex, and the hub serves ids as written: a colleague who hashed the branch
 * names every clone has (`git branch -r`) matched the suffix and read off
 * which branch an opted-out developer's topics were on. It is now an HMAC
 * under a key this machine minted and never sends (state/topic-key.ts).
 *
 * What a colleague can compute without the key is tried here against every
 * id: the old mint, a plain sha256 of the branch, the same input hashed
 * unkeyed, and the HMAC under an empty key. The conversation, the repo and a
 * guessable root are all in his hands; the key is not.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SAFE_ID_PATTERN } from "@crosscheck/schema";

import { mintTopicId, topicWorkContextIdFor } from "../src/flows/topic-contexts.ts";
import { readOrCreateTopicKey, readTopicKey, topicKeyFrom, topicKeyPath } from "../src/state/topic-key.ts";
import { makeHome } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const CONVERSATION = "cc_44444444-5555-4666-8777-888888888888";
const BRANCHES = ["feat/robin-topic-lugano", "fix/robin-topic-bern.v2", "feat/robin-healed-chur", "main", "release/2026.10"];
/** Worktree folders are often named after the branch: the root is a guess a colleague can make. */
const rootOf = (branch: string): string => `/Users/robin/worktrees/${branch.split("/").at(-1) ?? branch}`;
/** The remote's branch list a colleague hashes, hers among them. */
const CANDIDATES = [...BRANCHES, "feat/nick-login", "chore/deps", "fix/refresh-500"];
const OWNER_ONLY = 0o077;
const CONCURRENT_HOOKS = 16;
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const home = async (label: string): Promise<string> => {
  const path = await makeHome(label);
  cleanups.push(path);
  return path;
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const decimalOf = (hex: string): string => String(Number.parseInt(hex, 16));

/** Every way to spell an id from a branch without the key, as `<lead>.<number>` or its parts. */
const unkeyedGuesses = (branch: string): readonly { readonly lead?: string; readonly number?: string }[] => {
  const plain = sha256(branch);
  const sameInput = sha256(JSON.stringify([CONVERSATION, REPO_ID, rootOf(branch), branch]));
  const emptyKey = createHmac("sha256", "").update(JSON.stringify([CONVERSATION, REPO_ID, rootOf(branch), branch])).digest("hex");
  return [
    // The old mint's number, and its lead from the guessed root.
    { lead: sha256(`${REPO_ID}\n${rootOf(branch)}`).slice(0, 12) },
    { number: decimalOf(plain.slice(0, 8)) },
    { lead: plain.slice(0, 12) },
    { lead: sameInput.slice(0, 12), number: decimalOf(sameInput.slice(12, 20)) },
    { lead: emptyKey.slice(0, 12), number: decimalOf(emptyKey.slice(12, 20)) },
  ];
};

/** The candidate branches whose unkeyed spelling meets `id` in either part. */
const recoveredFrom = (id: string): readonly string[] => {
  const [lead, number] = id.split(".");
  return CANDIDATES.filter((branch) =>
    unkeyedGuesses(branch).some((guess) => guess.lead === lead || guess.number === number),
  );
};

describe("a topic id", () => {
  test("names no branch a colleague can hash: no candidate's unkeyed spelling meets any id", async () => {
    // Arrange: the key this machine mints at its first topic
    const key = await readOrCreateTopicKey(await home("topic-oracle"));
    if (key === null) {
      throw new Error("no topic key");
    }

    // Act: her topics, each in its own worktree
    const ids = BRANCHES.map((branch) => mintTopicId(key, CONVERSATION, REPO_ID, rootOf(branch), branch));

    // Assert
    expect(ids.flatMap(recoveredFrom)).toEqual([]);
    for (const id of ids) {
      expect(topicWorkContextIdFor(`wc_${CONVERSATION}`, id)).toMatch(SAFE_ID_PATTERN);
    }
  });

  test("is one id per (conversation, root, branch) under one key, and another under any other", () => {
    const key = "a1".repeat(32);
    const id = mintTopicId(key, CONVERSATION, REPO_ID, rootOf(BRANCHES[0] ?? ""), BRANCHES[0] ?? "");

    expect(mintTopicId(key, CONVERSATION, REPO_ID, rootOf(BRANCHES[0] ?? ""), BRANCHES[0] ?? "")).toBe(id);
    expect(
      new Set([
        id,
        mintTopicId("b2".repeat(32), CONVERSATION, REPO_ID, rootOf(BRANCHES[0] ?? ""), BRANCHES[0] ?? ""),
        mintTopicId(key, "cc_another-conversation", REPO_ID, rootOf(BRANCHES[0] ?? ""), BRANCHES[0] ?? ""),
        mintTopicId(key, CONVERSATION, REPO_ID, rootOf(BRANCHES[0] ?? ""), "feat/elsewhere"),
      ]).size,
    ).toBe(4);
  });
});

describe("the topic key", () => {
  test("is minted once, for this user only, and every later hook reads the same one", async () => {
    // Arrange
    const dir = await home("topic-key-once");

    // Act: sibling hooks racing for the first key, then a hook in a later life
    const racing = await Promise.all(Array.from({ length: CONCURRENT_HOOKS }, () => readOrCreateTopicKey(dir)));
    const later = await topicKeyFrom(dir)();

    // Assert
    const first = racing[0] ?? null;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([...racing, later])).toEqual(new Set([first]));
    expect((await stat(topicKeyPath(dir))).mode & OWNER_ONLY).toBe(0);
  });

  test("that cannot be had is none: an unwritable place mints nothing", async () => {
    // Arrange: `sessions` is a file, so nothing can be written beneath it
    const dir = await home("topic-key-none");
    await writeFile(join(dir, "sessions"), "not a directory\n");

    // Act
    const key = await readOrCreateTopicKey(dir);

    // Assert
    expect(key).toBeNull();
    expect(await readTopicKey(dir)).toBeNull();
  });
});
