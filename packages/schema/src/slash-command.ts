/**
 * A SLASH COMMAND is the developer typing to the harness, not naming a task
 * (DESIGN.md §4, hold-out review H1 d): "/compact", "/code-review", "/loop 5m
 * /babysit-prs". Its name is never a task word — "/code-review" used to
 * reach the hub as "code" and "review" and point at the review checklist —
 * so only its ARGUMENTS are scored, an argument that is itself a command is
 * a command too, and a bare command is content-free.
 *
 * ONLY A LEADING COMMAND IS ONE: a path ("/repo/src/a.ts") never matches,
 * since a command name holds no further slash, and "/health" inside a
 * sentence is that sentence's word. A registry like HARNESS_SHAPES: every
 * shape carries a sample its test runs.
 */

export interface SlashCommandShape {
  readonly name: string;
  readonly sample: string;
  /** What of the sample is scored. */
  readonly arguments: string;
}

export const SLASH_COMMAND_SHAPES: readonly SlashCommandShape[] = [
  { name: "a bare command", sample: "/compact", arguments: "" },
  { name: "a hyphenated name", sample: "/code-review", arguments: "" },
  { name: "a namespaced name", sample: "/everything-claude-code:plan", arguments: "" },
  { name: "a command with arguments", sample: "/model haiku", arguments: "haiku" },
  { name: "a command as an argument", sample: "/loop 5m /babysit-prs", arguments: "" },
  { name: "a unit-number argument", sample: "/loop 10m /babysit-prs", arguments: "" },
];

/** "/name": a slash, then a letter or digit, then no further slash or space. */
const COMMAND_NAME = /^\/[\p{L}\p{N}][\p{L}\p{N}_.:-]*$/u;

/**
 * A NUMBER WITH A UNIT, or none (round 3, H1): an interval or a count the
 * command takes — "/loop 10m", "/loop 90s", "/retry 3" — never a task word.
 * "10m" is three characters and was scored as one.
 */
const UNIT_NUMBER = /^\d+(?:ms|s|sec|secs|m|min|mins|h|hr|hrs|d|w)?$/iu;

const isCommandName = (word: string): boolean => COMMAND_NAME.test(word);

/** An argument that is the command's own, never the prompt's: another command, or a unit number. */
const isCommandOwn = (word: string): boolean => isCommandName(word) || UNIT_NUMBER.test(word);

/** The text a prompt's classifier scores: a leading command's arguments, else the prompt. */
export const commandArguments = (text: string): string => {
  const [head, ...rest] = text.trim().split(/\s+/u);
  if (head === undefined || !isCommandName(head)) {
    return text;
  }
  return rest.filter((word) => !isCommandOwn(word)).join(" ");
};
