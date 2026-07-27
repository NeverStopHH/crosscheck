import { GIT_TIMEOUT_MS } from "../constants.ts";

/**
 * Runs git and returns trimmed stdout, or null for any failure at all
 * (missing binary, not a repo, non-zero exit, timeout). Hooks treat null as
 * "this information does not exist" and keep going.
 */
export const runGit = async (
  args: readonly string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<string | null> => {
  try {
    const proc = Bun.spawn({
      cmd: ["git", ...args],
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        return null;
      }
      const trimmed = stdout.trim();
      return trimmed.length === 0 ? null : trimmed;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
};
