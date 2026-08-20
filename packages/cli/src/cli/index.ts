import { EXIT_OK, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { runDoctor } from "./doctor.ts";
import { interceptHelpOrUnknownFlag } from "./help.ts";
import type { HelpSpec } from "./help.ts";
import {
  INIT_COMMAND_PREFIX_FLAG,
  INIT_CURSOR_FLAG,
  INIT_FORCE_STATUSLINE_FLAG,
  INIT_HUB_FLAG,
  INIT_USAGE,
  parseInitArgs,
  runInit,
} from "./init.ts";
import {
  INIT_GLOBAL_FLAG,
  INIT_REMOVE_FLAG,
  runInitGlobal,
} from "./init-global.ts";
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
  "  init [--command-prefix <p>] [--hub <url>] [--force-statusline] [--cursor]",
  "                            --cursor additionally merges .cursor/hooks.json +",
  "                            .cursor/mcp.json (Cursor IDE capture, same one-PR install)",
  "  status                    hub, repo, teammates, spool, last sync",
  "  doctor                    diagnose the local install",
  "  presence [off|on]         hide/show your live presence to teammates",
  "  mute <developer>          stop seeing hints/pointers about them (mute list to review)",
  "  unmute <developer>        see their hints/pointers again",
  "  statusline                one presence line (reads session json on stdin)",
  "  hook <name>               session-start | post-tool-use | session-end",
  "  cursor-hook <event>       Cursor IDE hook entry (init --cursor registers these)",
  "  mcp                       run the mcp tool server on stdio (the agent starts it)",
  "  acp [--agent-kind <kind>] [--record <file>] -- <agent cmd…>",
  "                            transparent ACP proxy: wrap an ACP agent",
  "                            (Zed/JetBrains custom agent command)",
  "  acp-report <record-file>  which capture signals an agent emitted, from",
  "                            an `acp --record` transcript (per-agent",
  "                            capture-quality measurement)",
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
    booleanFlags: [
      INIT_FORCE_STATUSLINE_FLAG,
      INIT_CURSOR_FLAG,
      INIT_GLOBAL_FLAG,
      INIT_REMOVE_FLAG,
    ],
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
    case "init": {
      if (rest.includes(INIT_GLOBAL_FLAG)) {
        const parsed = parseInitArgs(rest);
        // --hub has no meaning at machine scope: each repo's committed
        // .crosscheck.json carries its hub url. Refusing beats ignoring.
        if (parsed.hubUrl !== undefined) {
          return {
            stdout: `${INIT_HUB_FLAG} does not apply to ${INIT_GLOBAL_FLAG} — the hub url lives in each repo's committed .crosscheck.json\n${INIT_USAGE}`,
            exitCode: EXIT_USAGE,
          };
        }
        return runInitGlobal(
          {
            commandPrefix: parsed.commandPrefix,
            forceStatusline: parsed.forceStatusline,
            cursor: parsed.cursor,
            remove: rest.includes(INIT_REMOVE_FLAG),
          },
          env,
        );
      }
      if (rest.includes(INIT_REMOVE_FLAG)) {
        return {
          stdout: `${INIT_REMOVE_FLAG} applies to the user-level install: run \`crosscheck init ${INIT_GLOBAL_FLAG} ${INIT_REMOVE_FLAG}\`\n${INIT_USAGE}`,
          exitCode: EXIT_USAGE,
        };
      }
      return runInit(rest, env, cwd);
    }
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
    // DYNAMIC import like the bin's `acp` branch: hooks and the statusline
    // must not pay connector-acp's load on every invocation.
    case "acp-report": {
      const path = rest[0];
      if (path === undefined) {
        return { stdout: USAGE, exitCode: EXIT_USAGE };
      }
      const { runAcpReport } = await import("@crosscheck/connector-acp");
      return runAcpReport(path);
    }
    default:
      return { stdout: USAGE, exitCode: EXIT_USAGE };
  }
};
