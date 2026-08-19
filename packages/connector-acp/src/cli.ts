/**
 * Argument parsing for `crosscheck acp`. The one place in this package that
 * is allowed to refuse loudly: nothing has been spawned yet, so a refusal
 * can kill no session — and a silently-ignored typo'd flag would stay
 * swallowed forever. Everything after `--` belongs to the agent, argv
 * untouched (§2.2).
 */

export interface AcpInvocation {
  readonly recordPath: string | undefined;
  /** `--agent-kind`: overrides the initialize-derived agent kind (§2.4). */
  readonly agentKind: string | undefined;
  readonly command: readonly string[];
}

export interface AcpUsageError {
  readonly error: string;
}

export const ACP_USAGE = [
  "usage: crosscheck acp [--agent-kind <kind>] [--record <file>] -- <agent command…>",
  "",
  "  Wraps an ACP agent as a transparent stdio proxy: bytes pass through",
  "  verbatim, the agent's exit code and signals are mirrored, and a per-",
  "  proxy log lands under the crosscheck home. Everything after -- is",
  "  spawned as the agent, arguments untouched, environment inherited.",
  "",
  "  Sessions in a crosscheck-connected repo (its cwd decides) report",
  "  presence, touched files and failure fingerprints to that repo's hub;",
  "  everywhere else the proxy is a pure pipe that talks to nobody.",
  "",
  "  --agent-kind <kind>  report sessions under this agent kind instead of",
  "                       acp:<name> from the agent's initialize response",
  "                       (CROSSCHECK_AGENT_KIND in the env outranks both)",
  "  --record <file>   append every observed NDJSON line to <file>",
  "                    (development aid for capture work; never required;",
  "                    entries dropped under load leave {gap: n} markers;",
  "                    analyze with: crosscheck acp-report <file>)",
].join("\n");

export const isUsageError = (
  parsed: AcpInvocation | AcpUsageError,
): parsed is AcpUsageError => "error" in parsed;

export const parseAcpArgs = (
  args: readonly string[],
): AcpInvocation | AcpUsageError => {
  const separator = args.indexOf("--");
  if (separator === -1) {
    return { error: "missing `--` before the agent command" };
  }
  const flags = args.slice(0, separator);
  const command = args.slice(separator + 1);
  if (command.length === 0) {
    return { error: "no agent command after `--`" };
  }
  let recordPath: string | undefined;
  let agentKind: string | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--record") {
      const value = flags[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: "--record needs a file path" };
      }
      recordPath = value;
      index += 1;
      continue;
    }
    if (flag === "--agent-kind") {
      const value = flags[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: "--agent-kind needs a value" };
      }
      agentKind = value;
      index += 1;
      continue;
    }
    return { error: `unknown flag before --: ${flag ?? ""}` };
  }
  return { recordPath, agentKind, command };
};
