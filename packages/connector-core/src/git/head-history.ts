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

/**
 * The reflog messages of a move that MADE a commit in this worktree — a merge
 * is left out, like `--no-merges` leaves it out, and so is every move onto a
 * commit made elsewhere (a checkout, a pull, a rebase, a reset).
 */
const MADE_MESSAGES = ["commit:", "commit (initial):", "commit (amend):", "cherry-pick:"] as const;
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MS_PER_SECOND = 1000;

/** A line's parts: the commits it moved from and to, when (whole seconds), and its message. */
export interface HeadMove {
  readonly from: string;
  readonly to: string;
  readonly atSeconds: number;
  readonly message: string;
}

const AMEND_MESSAGE = "commit (amend):";

/** `<old> <new> <name> <<email>> <seconds> <tz>\t<message>`: the seconds are the identity's second-to-last word. */
const movesOf = (log: string): readonly HeadMove[] =>
  log.split("\n").flatMap((line) => {
    const tab = line.indexOf("\t");
    if (tab <= 0) {
      return [];
    }
    const words = line.slice(0, tab).split(" ");
    const [from = "", to = ""] = words;
    return COMMIT_ID.test(to) ? [{ from, to, atSeconds: Number(words.at(-2)), message: line.slice(tab + 1) }] : [];
  });

/**
 * THE COMMITS THIS WORKTREE MADE since `since`, oldest first, each once (review
 * H1, DESIGN.md "One session, many topics"). The commit half used to read
 * HEAD's history, so every own commit HEAD could reach was filed under the
 * root's current topic wherever it was made: a merge of another topic's
 * branch, a start checkout re-detached at a newer main, a worktree re-added
 * at the same path from a tip just committed, two worktrees on one branch.
 * The worktree's own HEAD log names exactly the commits made IN it — a merged,
 * pulled, rebased or checked-out commit never appears there as a `commit:`
 * move. The time is the move's, git's whole seconds; nothing when the log is
 * gone or reflogs are off, which reads as "made nothing here". A commit an
 * amend replaced is left out: the amend is the commit now, and the version it
 * replaced may carry what was taken out of it.
 */
export const commitsMadeInHeadLog = async (gitDir: string, since: Date): Promise<readonly string[]> =>
  commitsMadeAmong(movesOf(await readLogTail(gitDir)), since);

/** `<sha>\tHEAD@{<seconds>}\t<message>`, as `git reflog show --date=unix --format=%H%x09%gd%x09%gs` prints it. */
const REFLOG_SHOW_LINE = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t[^\t]*@\{(\d+)\}\t(.*)$/;
const NULL_COMMIT = "0".repeat(40);

/**
 * A REFTABLE worktree's HEAD log, as git prints it (review M3): the reftable
 * keeps it where no file read reaches, so the caller asks git for the newest
 * entries — newest first, each line the commit HEAD moved TO. The commit it
 * moved from is the next (older) line's; the oldest shown has none. Returned
 * oldest first, the order `logs/HEAD` is written in.
 */
export const movesOfReflogShow = (stdout: string): readonly HeadMove[] => {
  const entries = stdout.split("\n").flatMap((line) => {
    const match = REFLOG_SHOW_LINE.exec(line);
    return match === null ? [] : [{ to: match[1] ?? "", atSeconds: Number(match[2]), message: match[3] ?? "" }];
  });
  return entries.map((entry, index) => ({ ...entry, from: entries[index + 1]?.to ?? NULL_COMMIT })).reverse();
};

/** `commitsMadeInHeadLog` over moves read any way — the files backend's log, or git's for a reftable. */
export const commitsMadeAmong = (moves: readonly HeadMove[], since: Date): readonly string[] => {
  const sinceSeconds = Math.floor(since.getTime() / MS_PER_SECOND);
  const amended = new Set(moves.filter((move) => move.message.startsWith(AMEND_MESSAGE)).map((move) => move.from));
  const made = moves
    .filter((move) => move.atSeconds >= sinceSeconds && MADE_MESSAGES.some((prefix) => move.message.startsWith(prefix)))
    .map((move) => move.to)
    .filter((commit) => !amended.has(commit));
  return [...new Set(made)];
};

/**
 * Whether git itself recorded `from` renamed to `to` in this worktree (review
 * H3): `git branch -m` writes `Branch: renamed refs/heads/<from> to
 * refs/heads/<to>` into the HEAD log. A branch that is merely gone — deleted
 * after the next one was cut at its tip — has no such line, and is no rename.
 */
export const isRenamedInHeadLog = async (gitDir: string, from: string, to: string): Promise<boolean> => {
  const record = `Branch: renamed refs/heads/${from} to refs/heads/${to}`;
  return movesOf(await readLogTail(gitDir)).some((move) => move.message === record);
};
