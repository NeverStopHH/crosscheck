/**
 * Preloaded into a hook child by the cost tests (test/subagent-return-cost
 * .test.ts): every `git` the process ATTEMPTS to spawn leaves ONE FILE in
 * CX_GIT_SPAWN_LOG_DIR, written synchronously before the spawn is made.
 *
 * WHY NOT A LOGGING `git` ON PATH, which this replaces (round 3, F-L8b). A
 * shim logs only once the shell it is has STARTED, and the hook's budget race
 * can end the hook first: the child exits, the orphaned shims log after the
 * test has read the log, and a hook that spawned four gits read as zero. The
 * reviewer saw exactly that — mutations X2 and X5 survived one combined run
 * and were caught in the next. Counted here, at the call, the number is the
 * number of attempts whatever the machine's load, and one file per attempt
 * means no two writers ever share a line.
 */
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const LOG_DIR = process.env["CX_GIT_SPAWN_LOG_DIR"] ?? "";

/** The argv a Bun.spawn or Bun.spawnSync call was handed, in either of its two forms. */
const argvOf = (first: unknown): readonly string[] => {
  const cmd = Array.isArray(first)
    ? first
    : typeof first === "object" && first !== null
      ? (first as { readonly cmd?: unknown }).cmd
      : undefined;
  return Array.isArray(cmd) ? cmd.filter((part): part is string => typeof part === "string") : [];
};

const isGit = (argv: readonly string[]): boolean => {
  const [executable] = argv;
  return executable !== undefined && basename(executable) === "git";
};

const attempts = { count: 0 };

const record = (argv: readonly string[]): void => {
  attempts.count += 1;
  writeFileSync(join(LOG_DIR, `${String(process.pid)}-${String(attempts.count)}.call`), JSON.stringify(argv));
};

if (LOG_DIR.length > 0) {
  const spawn = Bun.spawn;
  const spawnSync = Bun.spawnSync;
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    const argv = argvOf(args[0]);
    if (isGit(argv)) {
      record(argv);
    }
    return spawn(...args);
  }) as typeof Bun.spawn;
  Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    const argv = argvOf(args[0]);
    if (isGit(argv)) {
      record(argv);
    }
    return spawnSync(...args);
  }) as typeof Bun.spawnSync;
}
