/**
 * The one gate every user-facing subcommand's argv passes BEFORE the command
 * runs: --help/-h answers with usage and nothing else, and a flag the command
 * does not know is an error, never silently ignored.
 *
 * Why central rather than per-command: `crosscheck init --help` RAN a full
 * init in the wrong repo (2026-08-18 trial onboarding) because init's
 * indexOf-based parser read "--help" as "not one of my flags, carry on" —
 * and every hand-rolled parser re-creates that bug independently. One gate,
 * one table (cli/index.ts), one test file (test/cli-help.test.ts).
 */
import { EXIT_OK, EXIT_USAGE } from "../constants.ts";
import type { CliResult } from "./login.ts";

const HELP_FLAGS = new Set(["--help", "-h"]);

export interface HelpSpec {
  readonly usage: string;
  /** Flags that consume the NEXT token as a value — it is never inspected. */
  readonly valueFlags?: readonly string[];
  readonly booleanFlags?: readonly string[];
}

/**
 * Returns the intercepted result, or null when the command should run.
 * Help wins over an unknown flag (`init --hepl --help` prints usage, exit 0):
 * the human is asking what the command takes, which is exactly the answer.
 */
export const interceptHelpOrUnknownFlag = (
  command: string,
  args: readonly string[],
  spec: HelpSpec,
): CliResult | null => {
  const valueFlags = new Set(spec.valueFlags ?? []);
  const booleanFlags = new Set(spec.booleanFlags ?? []);
  let index = 0;
  let firstUnknown: string | null = null;
  while (index < args.length) {
    const token = args[index] ?? "";
    if (HELP_FLAGS.has(token)) {
      return { stdout: spec.usage, exitCode: EXIT_OK };
    }
    if (valueFlags.has(token)) {
      index += 2;
      continue;
    }
    if (
      token.startsWith("-") &&
      !booleanFlags.has(token) &&
      firstUnknown === null
    ) {
      firstUnknown = token;
    }
    index += 1;
  }
  if (firstUnknown !== null) {
    return {
      stdout: `unknown flag for crosscheck ${command}: ${firstUnknown}\n${spec.usage}`,
      exitCode: EXIT_USAGE,
    };
  }
  return null;
};
