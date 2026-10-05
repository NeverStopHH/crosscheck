/**
 * Where one attempt lives on disk, and how its paths are read back.
 *
 * REAL PATHS (M9). On macOS `tmpdir()` is `/var/folders/…`, a symlink into
 * `/private/var/folders/…`, and a child's cwd is always the real spelling.
 * A root left unresolved relativized nothing, and the `Read(//…)` allow rules
 * were written on the `/var` spelling. `createWorkRoot` resolves the base
 * first, so the fixture root, the permission rules and the child's cwd are
 * one string; `relativeTo` still accepts both spellings, because an agent may
 * name a path either way.
 *
 * OPAQUE NAMES (A2.4). Claude Code puts the working directory into the system
 * prompt, so a path like `…/runs/14-P4/attempt-1/slugkit` was a cue that
 * differed by arm. Each attempt now sits under a random 12-hex-character id;
 * hex cannot spell `at7`, `bench`, `control` or a payload id. The slot, arm
 * and attempt number live only in the results dir, outside the agent's path.
 */
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Bytes of randomness in an attempt id — 12 hex characters. */
const ATTEMPT_ID_BYTES = 6;

/** macOS's real prefix for `/var`, `/tmp` and `/etc`. */
const PRIVATE_PREFIX = "/private";

/** A fresh opaque attempt id: lowercase hex only. */
export const newAttemptId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(ATTEMPT_ID_BYTES)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** `root` and its other spelling across macOS's `/private` symlinks. */
const spellings = (root: string): readonly string[] =>
  root.startsWith(`${PRIVATE_PREFIX}/`)
    ? [root, root.slice(PRIVATE_PREFIX.length)]
    : [root, `${PRIVATE_PREFIX}${root}`];

/**
 * Paths relative to `root` when they sit under it in either spelling; any
 * other path (relative, or outside the fixture) is returned unchanged. Pure.
 */
export const relativeTo = (root: string, paths: readonly string[]): readonly string[] =>
  paths.map((path) => {
    const base = spellings(root).find((candidate) => path.startsWith(`${candidate}/`));
    return base === undefined ? path : path.slice(base.length + 1);
  });

/**
 * Creates `<realpath(base)>/<attemptId>` and returns it. Never reuses a
 * directory: an existing one throws, so a re-run cannot collide with an
 * earlier attempt's fixture or hub data.
 */
export const createWorkRoot = async (base: string, attemptId: string): Promise<string> => {
  const root = join(await realpath(base), attemptId);
  await mkdir(root);
  return root;
};

/**
 * A PATH value without the entries inside `dir` (A2.4): a launcher run via
 * `bun run` carries `<checkout>/node_modules/.bin`, and `echo $PATH` is a
 * read-only command the agent runs unprompted, so the harness checkout's name
 * must not ride along. Pure.
 */
export const pathWithout = (pathVar: string, dir: string): string =>
  pathVar
    .split(":")
    .filter((entry) => entry !== dir && !entry.startsWith(`${dir}/`))
    .join(":");
