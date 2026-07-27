import { EXIT_USAGE } from "../constants.ts";
import type { Env } from "../config/paths.ts";
import { runDoctor } from "./doctor.ts";
import { runInit } from "./init.ts";
import { readSecretFromStdin, runLogin } from "./login.ts";
import type { CliResult, SecretReader } from "./login.ts";
import { runStatus } from "./status.ts";

export type { CliResult, SecretReader } from "./login.ts";

const USAGE = [
  "usage: crosscheck <command>",
  "",
  "  login <hubUrl>            store credentials; key from stdin or CROSSCHECK_API_KEY",
  "  login <hubUrl> <apiKey>   discouraged: the key lands in your shell history",
  "  init [--command-prefix <p>] [--hub <url>] [--force-statusline]",
  "  status                    hub, repo, teammates, spool, last sync",
  "  doctor                    diagnose the local install",
  "  statusline                one presence line (reads session json on stdin)",
  "  hook <name>               session-start | post-tool-use | session-end",
  "",
].join("\n");

export const runCli = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
  readSecret: SecretReader = readSecretFromStdin,
): Promise<CliResult> => {
  const [command, ...rest] = argv;
  switch (command) {
    case "login":
      return runLogin(rest, env, readSecret);
    case "init":
      return runInit(rest, env, cwd);
    case "status":
      return runStatus(env, cwd);
    case "doctor":
      return runDoctor(env, cwd);
    default:
      return { stdout: USAGE, exitCode: EXIT_USAGE };
  }
};
