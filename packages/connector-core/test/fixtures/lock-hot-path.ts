/**
 * The UNCONTENDED acquire path, run in its own process so that anything the
 * lock spawns is a real child of a process the caller controls.
 *
 * Its caller puts a counting `ps` shim first on PATH: a liveness probe that
 * reached this path would leave a trace on disk, and the test asserts there is
 * none. The mean is printed so the same run reports what the path costs.
 *
 * argv: <lockPath> <cycles>
 * stdout: JSON { cycles, acquired, meanUs }
 */
import { withLock } from "../../src/spool/lock.ts";

const NS_PER_US = 1000;

const [lockPath, cyclesRaw] = process.argv.slice(2);

if (lockPath === undefined || cyclesRaw === undefined) {
  process.stderr.write("usage: lock-hot-path <lockPath> <cycles>\n");
  process.exit(64);
}

const cycles = Number.parseInt(cyclesRaw, 10);
let acquired = 0;

const startedAt = Bun.nanoseconds();
for (let index = 0; index < cycles; index += 1) {
  // Nothing else is running, so every cycle creates its own lock and returns
  // without ever having to ask who holds anything.
  await withLock(lockPath, false, async () => {
    acquired += 1;
    return true;
  });
}
const elapsedNs = Bun.nanoseconds() - startedAt;

process.stdout.write(
  JSON.stringify({
    cycles,
    acquired,
    meanUs: elapsedNs / cycles / NS_PER_US,
  }),
);
