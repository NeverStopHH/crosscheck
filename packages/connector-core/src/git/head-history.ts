/**
 * "DOES THIS COMMIT DESCEND FROM THAT ONE", ANSWERED FROM THE WORKTREE'S OWN
 * HEAD LOG — no git spawned (DESIGN.md "One session, many topics").
 *
 * The topic rules keep a topic across a branch rename, a move to a branch
 * that continues the work, and a detached HEAD on top of it, and each of those
 * asks whether the root's HEAD now descends from the commit the topic was last
 * seen at. `git merge-base --is-ancestor` would answer it exactly, at a spawn
 * per question on the hook's hot path. The worktree's HEAD log
 * (`<gitdir>/logs/HEAD`) already records every move HEAD made in it, so the
 * question becomes: is there a chain of FORWARD moves from the one commit to
 * the other — a commit, a merge, a pull that fast-forwards or merges, a
 * cherry-pick — in the newest MAX_HEAD_LOG_BYTES of it.
 *
 * DETERMINISTIC, AND CONSERVATIVE BY CONSTRUCTION. An amend, a reset, a
 * rebase (a rebasing pull too) and a checkout of another commit are not
 * forward moves, so a history
 * rewritten in the worktree reads as "does not descend" and the rules open a
 * new topic — the safe answer, because a topic that merges two pieces of work
 * hides a collision, and two topics for one piece of work only split its
 * evidence. A commit made in ANOTHER worktree never shows here either: the
 * rules then open a topic, which is what their first rule says anyway.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { MAX_HEAD_LOG_BYTES } from "../constants.ts";

/**
 * The reflog messages of a move that keeps the previous commit as an ancestor.
 * `pull:` and `cherry-pick:` WITH their colon: a `pull --rebase (start)` or a
 * sequencer step moves HEAD onto a commit that is not on top of it.
 */
const FORWARD_MESSAGES = ["commit:", "commit (initial):", "commit (merge):", "merge ", "pull:", "cherry-pick:"] as const;

const isForward = (message: string): boolean => FORWARD_MESSAGES.some((prefix) => message.startsWith(prefix));

/** The newest part of the log, cut at a line boundary. */
const readLogTail = async (gitDir: string): Promise<string> => {
  try {
    const text = await readFile(join(gitDir, "logs", "HEAD"), "utf8");
    if (text.length <= MAX_HEAD_LOG_BYTES) {
      return text;
    }
    const tail = text.slice(text.length - MAX_HEAD_LOG_BYTES);
    return tail.slice(tail.indexOf("\n") + 1);
  } catch {
    return "";
  }
};

/** Each forward move as old → new, read off `<old> <new> <who> <when>\t<message>`. */
const forwardEdges = (log: string): ReadonlyMap<string, readonly string[]> => {
  const edges = new Map<string, string[]>();
  for (const line of log.split("\n")) {
    const tab = line.indexOf("\t");
    const [from = "", to = ""] = line.slice(0, tab).split(" ");
    if (tab > 0 && isForward(line.slice(tab + 1))) {
      edges.set(from, [...(edges.get(from) ?? []), to]);
    }
  }
  return edges;
};

/**
 * True when `descendant` is `ancestor` itself, or the worktree's HEAD log
 * shows a chain of forward moves from one to the other. False when the log
 * cannot be read: no answer is no descent.
 */
export const descendsInHeadLog = async (gitDir: string, ancestor: string, descendant: string): Promise<boolean> => {
  if (ancestor === descendant) {
    return true;
  }
  const edges = forwardEdges(await readLogTail(gitDir));
  const seen = new Set<string>([ancestor]);
  const frontier = [ancestor];
  while (frontier.length > 0) {
    const next = frontier.pop() as string;
    for (const child of edges.get(next) ?? []) {
      if (child === descendant) {
        return true;
      }
      if (!seen.has(child)) {
        seen.add(child);
        frontier.push(child);
      }
    }
  }
  return false;
};
