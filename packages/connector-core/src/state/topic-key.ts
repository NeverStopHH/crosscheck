/**
 * THE TOPIC KEY (batch-2 integration review, H3): the secret every topic id
 * this machine mints is an HMAC under (flows/topic-contexts.ts `mintTopicId`).
 *
 * WHY A KEY. A topic id was sha256(repo, root) and sha256(the branch it opened
 * on), and the hub serves ids as written — on the listing, the conference,
 * search, the landed stop and every pointer a connector prints. A colleague
 * who hashed the branch names every clone already has (`git branch -r`)
 * matched the suffix and read off which branch an opted-out developer's
 * topics were on: the field the presence opt-out withholds. Keyed, nobody
 * without the key can test a guess.
 *
 * ONE KEY PER MACHINE, BESIDE THE LINEAGE (`sessions/topic-key`), minted the
 * first time a topic opens and never sent: no record, no request and no log
 * line carries it. The id is keyed per CONVERSATION too (the HMAC's input
 * names it), so two conversations' topics on one branch are not linkable by
 * their ids, while every hook of one conversation — sibling hooks reading one
 * state, a heal's next life, a resume after SessionEnd — mints the same id
 * for the same (root, branch). Nothing about it lives in the session state,
 * so no re-fire, busy-lock fallback or heal has a field to carry or drop.
 *
 * Created by an exclusive `link` of a fully written temp file: two hooks
 * racing to mint the first key both end up reading the one that won, never a
 * half-written file. A key that cannot be had — the sessions directory not
 * writable, the file unreadable or not a key — is null, and a touch that
 * would open a topic files under the session's own context instead
 * (flows/topic-rules.ts), as one whose root's HEAD cannot be read does.
 */
import { randomBytes } from "node:crypto";
import { link, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ensureDir, readTextOrNull, removeFile, tempSibling } from "../config/paths.ts";
import { PRIVATE_FILE_MODE, TOPIC_KEY_BYTES } from "../constants.ts";
import type { TopicKeySource } from "../flows/topic-contexts.ts";
import { sessionStateDir } from "./session-scan.ts";

/** Not `.json` and no lineage suffix: neither the state scan nor the lineage reap ever reads or removes it. */
const TOPIC_KEY_FILE = "topic-key";
const KEY_PATTERN = new RegExp(`^[0-9a-f]{${String(TOPIC_KEY_BYTES * 2)}}$`);

export const topicKeyPath = (home: string): string => join(sessionStateDir(home), TOPIC_KEY_FILE);

const keyIn = (text: string | null): string | null => {
  const key = text?.trim() ?? "";
  return KEY_PATTERN.test(key) ? key : null;
};

/** The key this machine minted, or null when there is none (yet) or it is not a key. */
export const readTopicKey = async (home: string): Promise<string | null> =>
  keyIn(await readTextOrNull(topicKeyPath(home)));

const isAlreadyThere = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "EEXIST";

/** The key, minted now when there is none. Null when none can be had. */
export const readOrCreateTopicKey = async (home: string): Promise<string | null> => {
  const existing = await readTopicKey(home);
  if (existing !== null) {
    return existing;
  }
  const path = topicKeyPath(home);
  const temp = tempSibling(path);
  try {
    await ensureDir(dirname(path));
    await writeFile(temp, `${randomBytes(TOPIC_KEY_BYTES).toString("hex")}\n`, { mode: PRIVATE_FILE_MODE });
    // EEXIST is a sibling that published first: its key is the one read below.
    await link(temp, path);
  } catch (error) {
    if (!isAlreadyThere(error)) {
      await removeFile(temp);
      return null;
    }
  }
  await removeFile(temp);
  return readTopicKey(home);
};

/** A capture's key source: read (or minted) once, and only when a topic opens. */
export const topicKeyFrom = (home: string): TopicKeySource => {
  let pending: Promise<string | null> | undefined;
  return () => {
    pending ??= readOrCreateTopicKey(home);
    return pending;
  };
};
