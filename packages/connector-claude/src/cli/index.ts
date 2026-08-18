import { EXIT_OK, EXIT_USAGE } from "../constants.ts";
import type { Env } from "../config/paths.ts";
import { runDoctor } from "./doctor.ts";
import { interceptHelpOrUnknownFlag } from "./help.ts";
import type { HelpSpec } from "./help.ts";
import {
  INIT_COMMAND_PREFIX_FLAG,
  INIT_FORCE_STATUSLINE_FLAG,
  INIT_HUB_FLAG,
  INIT_USAGE,
  runInit,
} from "./init.ts";
import { LOGIN_USAGE, readSecretFromStdin, runLogin } from "./login.ts";
import type { CliResult, SecretReader } from "./login.ts";
import {
  MUTE_USAGE,
  PRESENCE_USAGE,
  runMute,
  runPresence,
  runUnmute,
} from "./privacy.ts";
import { runStatus } from "./status.ts";
import { resolveVersion } from "./version.ts";

export type { CliResult, SecretReader } from "./login.ts";

const USAGE = [
  "usage: crosscheck <command>",
  "",
  "  serve                     run the team hub on this machine (env: PORT,",
  "                            CROSSCHECK_DATA_DIR, ADMIN_TOKEN, CROSSCHECK_UI_SECRET)",
  "  login <hubUrl>            store credentials; key from stdin or CROSSCHECK_API_KEY",
  "  login <hubUrl> <apiKey>   discouraged: the key lands in your shell history",
  "  init [--command-prefix <p>] [--hub <url>] [--force-statusline]",
  "  status                    hub, repo, teammates, spool, last sync",
  "  doctor                    diagnose the local install",
  "  presence [off|on]         hide/show your live presence to teammates",
  "  mute <developer>          stop seeing hints/pointers about them (mute list to review)",
  "  unmute <developer>        see their hints/pointers again",
  "  statusline                one presence line (reads session json on stdin)",
  "  hook <name>               session-start | post-tool-use | session-end",
  "  mcp                       run the mcp tool server on stdio (the agent starts it)",
  "",
].join("\n");

const STATUS_USAGE = [
  "usage: crosscheck status",
  "",
  "  shows hub, repo, teammates, spool depth and last sync for this repo",
  "",
].join("\n");

const DOCTOR_USAGE = [
  "usage: crosscheck doctor",
  "",
  "  diagnoses the local install; exit 0 healthy, 1 warnings, 2 failures",
  "",
].join("\n");

/**
 * Every user-facing subcommand and what its argv may carry. The gate
 * (cli/help.ts) runs BEFORE dispatch: --help/-h answers with the usage here
 * and does nothing else, an unlisted flag is a usage error — `init --help`
 * once RAN a full init because nothing stood in front of the command.
 */
const SUBCOMMAND_HELP: Readonly<Record<string, HelpSpec>> = {
  login: { usage: LOGIN_USAGE },
  init: {
    usage: INIT_USAGE,
    valueFlags: [INIT_COMMAND_PREFIX_FLAG, INIT_HUB_FLAG],
    booleanFlags: [INIT_FORCE_STATUSLINE_FLAG],
  },
  status: { usage: STATUS_USAGE },
  doctor: { usage: DOCTOR_USAGE },
  presence: { usage: PRESENCE_USAGE },
  mute: { usage: MUTE_USAGE },
  unmute: { usage: MUTE_USAGE },
};

export const runCli = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
  readSecret: SecretReader = readSecretFromStdin,
): Promise<CliResult> => {
  const [command, ...rest] = argv;
  const helpSpec = command === undefined ? undefined : SUBCOMMAND_HELP[command];
  if (helpSpec !== undefined) {
    const intercepted = interceptHelpOrUnknownFlag(command ?? "", rest, helpSpec);
    if (intercepted !== null) {
      return intercepted;
    }
  }
  switch (command) {
    // Exit 0, unlike an unknown command: asking for help is not an error,
    // and `npx crosscheck-hub --help` is the first thing a stranger runs.
    case "--help":
    case "-h":
    case "help":
      return { stdout: USAGE, exitCode: EXIT_OK };
    case "--version":
      return {
        stdout: `crosscheck ${await resolveVersion(import.meta.dir)}\n`,
        exitCode: EXIT_OK,
      };
    case "login":
      return runLogin(rest, env, readSecret);
    case "init":
      return runInit(rest, env, cwd);
    case "status":
      return runStatus(env, cwd);
    case "doctor":
      return runDoctor(env, cwd);
    case "presence":
      return runPresence(rest, env, cwd);
    case "mute":
      return runMute(rest, env, cwd);
    case "unmute":
      return runUnmute(rest, env, cwd);
    default:
      return { stdout: USAGE, exitCode: EXIT_USAGE };
  }
};
