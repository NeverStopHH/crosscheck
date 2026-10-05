/**
 * The HUMAN text of a prompt turn (DESIGN.md §4). A harness delivers machine
 * text as user turns: Claude Code hands a background task's notification to
 * the model as a user message headed SYSTEM_NOTIFICATION_MARKER and/or wrapped
 * in <task-notification>, and messages from another agent or session arrive
 * as <agent-message from=…> and <cross-session-message from=…>. Their words —
 * PR, CI, checks, pass, event — are nobody's task, and on 0.10.0 they pointed
 * a live session at unrelated teammate trees on four consecutive turns.
 *
 * HERE, IN THE SHARED SCHEMA, so the connector (which then sends only the
 * human text, and nothing at all for a turn that is all harness) and the hub
 * (which strips again, for every connector already installed) apply one rule.
 *
 * EXACT, NEVER AN HTML STRIPPER: the marker only at the head of the turn, and
 * exactly these three element names, attributes allowed. Any other angle
 * brackets are the human's — a prompt about `<Player/>` keeps every word. A
 * wrapper that never closes (a turn cut at the wire bound) wraps the rest.
 */

/** The head Claude Code gives a turn it delivers on a background task's behalf. */
export const SYSTEM_NOTIFICATION_MARKER = "[SYSTEM NOTIFICATION - NOT USER INPUT]";

/** The elements a harness wraps machine-delivered text in. */
export const HARNESS_WRAPPER_ELEMENTS = [
  "task-notification",
  "agent-message",
  "cross-session-message",
] as const;

/**
 * One wrapper, to its close or the end of the turn. No whitespace around it
 * in the pattern: a leading `\s*` backtracks quadratically over a pasted run
 * of spaces, inside an 800 ms hook — the gaps are collapsed afterwards.
 */
const wrapperPattern = (element: string): RegExp =>
  new RegExp(`<${element}(?:\\s[^>]*)?>[\\s\\S]*?(?:</${element}>|$)`, "g");

const WRAPPERS: readonly RegExp[] = HARNESS_WRAPPER_ELEMENTS.map(wrapperPattern);

/**
 * The turn without what the harness wrote: "" for a turn headed by the
 * marker, the text outside every wrapper otherwise (whitespace collapsed —
 * it is a search query from here on) — and the prompt exactly as typed when
 * it carries neither.
 */
export const humanPromptText = (prompt: string): string => {
  if (prompt.trimStart().startsWith(SYSTEM_NOTIFICATION_MARKER)) {
    return "";
  }
  const stripped = WRAPPERS.reduce((text, wrapper) => text.replace(wrapper, " "), prompt);
  return stripped === prompt ? prompt : stripped.replace(/\s+/g, " ").trim();
};

/** A turn that said something, all of it the harness's. */
export const isHarnessTurn = (prompt: string): boolean =>
  prompt.trim().length > 0 && humanPromptText(prompt).length === 0;
