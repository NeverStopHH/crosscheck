/**
 * Entries a removal LEFT that still look like crosscheck's (review
 * 2026-10-05): an install made with `init --command-prefix /opt/tools/cx-wrap`
 * writes `/opt/tools/cx-wrap hook session-start`, which the ownership rule
 * cannot recognise — an operator's arbitrary launcher is not a pattern
 * (connector-claude settings-merge.ts). `init --remove` then reported "no
 * crosscheck entries" and "sessions now load no crosscheck hooks" while seven
 * hooks stayed.
 *
 * This NEVER widens what is removed. It only names what was left, so a person
 * can decide: a command that ends in one of the subcommands crosscheck itself
 * writes (`… hook session-start`, `… statusline`, `… cursor-hook stop`),
 * read off the install plans rather than written out again, and an mcp
 * server under crosscheck's own key that its owner check did not accept.
 */
import { MCP_SERVER_KEY } from "@crosscheck/connector-core/constants.ts";
import { buildSettingsPlan } from "@crosscheck/connector-claude";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

/** " hook session-start", " statusline", … — the plan's commands with no launcher. */
const claudePlan = buildSettingsPlan("", false);
const CLAUDE_SUBCOMMANDS: readonly string[] = [
  ...Object.values(claudePlan.hooks).flatMap((group) => group.hooks.map((hook) => hook.command)),
  claudePlan.statusLine.command,
];

const endsInSubcommand = (subcommands: readonly string[]) => (command: unknown): command is string =>
  typeof command === "string" && subcommands.some((suffix) => command.trimEnd().endsWith(suffix));

/** Hook and statusline commands left in a Claude settings object that look like crosscheck's. */
export const claudeLookalikes = (settings: Record<string, unknown>): readonly string[] =>
  [
    ...Object.values(asRecord(settings["hooks"]))
      .flatMap(asArray)
      .flatMap((group) => asArray(asRecord(group)["hooks"]))
      .map((hook) => asRecord(hook)["command"]),
    asRecord(settings["statusLine"])["command"],
  ].filter(endsInSubcommand(CLAUDE_SUBCOMMANDS));

/** Hook commands left in a Cursor hooks.json that look like crosscheck's. */
export const cursorLookalikes = (
  file: Record<string, unknown>,
  subcommands: readonly string[],
): readonly string[] =>
  Object.values(asRecord(file["hooks"]))
    .flatMap(asArray)
    .map((definition) => asRecord(definition)["command"])
    .filter(endsInSubcommand(subcommands));

/** A server left under crosscheck's own key: install wrote it there, its owner check said no. */
export const mcpLookalikes = (config: Record<string, unknown>): readonly string[] => {
  const entry = asRecord(config["mcpServers"])[MCP_SERVER_KEY];
  if (entry === undefined) {
    return [];
  }
  const server = asRecord(entry);
  const launch = [server["command"], ...asArray(server["args"])]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return [`mcpServers.${MCP_SERVER_KEY}: ${launch}`];
};
