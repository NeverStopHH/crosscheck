/**
 * The HUMAN text of a prompt turn (DESIGN.md §4). A harness delivers machine
 * text as user turns: Claude Code hands a background task's notification to
 * the model as a user message headed SYSTEM_NOTIFICATION_MARKER and/or wrapped
 * in <task-notification>, other agents and sessions arrive as <agent-message>,
 * <cross-session-message> and <teammate-message>, the IDE prepends the file
 * and selection it has open, and /loop and idle notices arrive as headed
 * turns. Their words — PR, CI, checks, pass, event — are nobody's task, and
 * on 0.10.0 they pointed a live session at unrelated teammate trees on four
 * consecutive turns.
 *
 * HERE, IN THE SHARED SCHEMA, so the connector (which then sends only the
 * human text, and nothing at all for a turn that is all harness) and the hub
 * (which strips again, for every connector already installed) apply one rule.
 *
 * A REGISTRY, NEVER AN HTML STRIPPER: HARNESS_SHAPES names every shape seen,
 * each with a synthetic sample its test runs. An ELEMENT is stripped and the
 * text around it kept — case-insensitive name, attributes allowed but bounded,
 * a wrapper that never closes wraps the rest. A turn that STARTS with an
 * element is wrapped to that element's LAST close, so a hand-back quoting
 * `</agent-message>` cannot end it early (review 1006b, M1). A HEAD marker at
 * the start of the turn or of a line makes everything from it on the
 * harness's; quoted mid-line it is the human's.
 *
 * LINEAR AND BOUNDED (M2): one window of HARNESS_SCAN_MAX_CHARS after the
 * leading whitespace is read, attribute scans stop at
 * MAX_WRAPPER_ATTRIBUTE_CHARS, and every search moves forward. The text is a
 * search query and a one-sentence intent from here on; nothing past the
 * window could reach either — but the human text after a wrapper the window
 * ends inside (round 4, M3): that wrapper's close is looked for once, within
 * the prompt's first mebibyte, and the rest read with a window of its own.
 *
 * ACCEPTED (L4): a human prompt that names an unclosed wrapper loses the text
 * after it. That costs one hint on that prompt, never a hint nobody earned.
 */

/** The head Claude Code gives a turn it delivers on a background task's behalf. */
export const SYSTEM_NOTIFICATION_MARKER = "[SYSTEM NOTIFICATION - NOT USER INPUT]";

/** How much of a turn is read, after its leading whitespace. */
export const HARNESS_SCAN_MAX_CHARS = 32_768;

/** The longest attribute run a wrapper's opening tag may carry. */
const MAX_WRAPPER_ATTRIBUTE_CHARS = 256;

export interface HarnessShape {
  /**
   * An element is stripped; a head makes the rest of the turn the harness's;
   * a marker — a token the harness puts inline — is stripped wherever it
   * stands (round 4, M2).
   */
  readonly kind: "element" | "head" | "marker";
  /** The element's tag, the head's literal text, or the marker as written, N for its number. */
  readonly name: string;
  /** A synthetic turn of exactly this shape, run by the registry's test. */
  readonly sample: string;
}

const element = (tag: string, sample: string): HarnessShape => ({ kind: "element", name: `<${tag}>`, sample });
const head = (text: string, sample: string): HarnessShape => ({ kind: "head", name: text, sample });
const marker = (text: string, sample: string): HarnessShape => ({ kind: "marker", name: text, sample });

export const HARNESS_SHAPES: readonly HarnessShape[] = [
  element("task-notification", "<task-notification><task-id>t1</task-id><summary>Monitor event: CI checks pass</summary></task-notification>"),
  element("agent-message", '<agent-message from="a1">Report: all suites pass</agent-message>'),
  element("cross-session-message", '<cross-session-message from="s1">CI checks pass on main</cross-session-message>'),
  element("teammate-message", '<teammate-message teammate_id="researcher">Found the refresh race</teammate-message>'),
  element("system-reminder", "<system-reminder>Context left: 40%</system-reminder>"),
  element("ide_opened_file", "<ide_opened_file>The user opened the file /repo/src/a.ts in the IDE.</ide_opened_file>"),
  element("ide_selection", "<ide_selection>The user selected the lines 3 to 9 from /repo/src/a.ts</ide_selection>"),
  // round 4, M2: a slash command's echo, local-command output and a background shell's notice
  element("command-name", "<command-name>/review</command-name>"),
  element("command-message", "<command-message>review is running…</command-message>"),
  element("command-args", "<command-args>focus on the checkout webhook work</command-args>"),
  element("local-command-stdout", "<local-command-stdout>Compacted. ctrl+r to see full summary</local-command-stdout>"),
  element("local-command-stderr", "<local-command-stderr>Error: /model requires an argument</local-command-stderr>"),
  element("bash-notification", "<bash-notification><shell-id>bash_3</shell-id><status>completed</status></bash-notification>"),
  head(SYSTEM_NOTIFICATION_MARKER, `${SYSTEM_NOTIFICATION_MARKER}\nMonitor event: CI checks pass`),
  head("[Cross-session idle notice]", '[Cross-session idle notice] "s1" is idle now.'),
  head("# Autonomous loop tick", "# Autonomous loop tick (dynamic pacing)\nCheck the deploy."),
  head("# Autonomous loop check", "# Autonomous loop check\nCheck the deploy."),
  // round 4, M2: an interruption, the local-command caveat, the compaction's
  // continuation, Stop-hook feedback and a tool hook's error line
  head("[Request interrupted by user]", "[Request interrupted by user]"),
  head("[Request interrupted by user for tool use]", "[Request interrupted by user for tool use]"),
  head(
    "Caveat: The messages below were generated by the user while running local commands.",
    "Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages.",
  ),
  head(
    "This session is being continued from a previous conversation",
    "This session is being continued from a previous conversation that ran out of context. The summary below covers it.",
  ),
  head("Stop hook feedback:", "Stop hook feedback:\n- Tests were not run."),
  head("PostToolUse:", "PostToolUse:Edit hook error: prettier exited with code 2"),
  head("PreToolUse:", "PreToolUse:Write hook error: [Fact-Forcing Gate] present these facts"),
  // round 4, M2: a pasted image, inline
  marker("[Image #N]", "[Image #1]"),
];

/** The markers' pattern: each name as written, its N any number. */
const MARKERS = new RegExp(
  HARNESS_SHAPES.filter((shape) => shape.kind === "marker")
    .map((shape) => shape.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("N", "\\d+"))
    .join("|"),
  "gu",
);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ELEMENT_TAGS: readonly string[] = HARNESS_SHAPES.filter((shape) => shape.kind === "element").map(
  (shape) => shape.name.slice(1, -1),
);

/** The next opening of any registered element; the tag must end at `>` or whitespace. */
const OPENING = new RegExp(`<(${ELEMENT_TAGS.map(escapeRegExp).join("|")})(?=[\\s>])`, "gi");

/** The rest of an opening tag at a position: bounded attributes, then `>`. */
const TAG_END = new RegExp(`[^>]{0,${String(MAX_WRAPPER_ATTRIBUTE_CHARS)}}>`, "y");

/**
 * A head marker at the start of the text or of a line, after blanks of any
 * kind — a no-break, em or ideographic space included (hold-out review, L1) —
 * or a byte-order mark.
 */
const HEAD = new RegExp(
  `(?:^|\\n)[\\p{Zs}\\t\\uFEFF]*(?:${HARNESS_SHAPES.filter((shape) => shape.kind === "head")
    .map((shape) => escapeRegExp(shape.name))
    .join("|")})`,
  "iu",
);

/** ASCII-only lower case: same length, so its indices are the text's. */
const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

interface Opening {
  readonly tag: string;
  readonly start: number;
  readonly end: number;
}

/** The next valid opening at or after `from`, or null. */
const nextOpening = (text: string, from: number): Opening | null => {
  OPENING.lastIndex = from;
  for (let match = OPENING.exec(text); match !== null; match = OPENING.exec(text)) {
    TAG_END.lastIndex = match.index + match[0].length;
    if (TAG_END.test(text)) {
      return { tag: (match[1] ?? "").toLowerCase(), start: match.index, end: TAG_END.lastIndex };
    }
    OPENING.lastIndex = match.index + 1;
  }
  return null;
};

/** The next opening of the same element after this one, or -1. */
const nextSameOpening = (text: string, opening: Opening): number => {
  for (let next = nextOpening(text, opening.end); next !== null; next = nextOpening(text, next.end)) {
    if (next.tag === opening.tag) {
      return next.start;
    }
  }
  return -1;
};

/**
 * A leading wrapper's close: the last one BEFORE the next opening of the
 * same element (hold-out review, L1) — two hand-backs with the human's words
 * between them keep those words — else its last close at all, so a quoted
 * close inside one wrapper never ends it early (M1).
 */
const leadingClose = (text: string, lower: string, opening: Opening, close: string): number => {
  const nextSame = nextSameOpening(text, opening);
  const beforeNext = nextSame === -1 ? -1 : lower.lastIndexOf(close, nextSame);
  return beforeNext >= opening.end ? beforeNext : lower.lastIndexOf(close);
};

/** A wrapper end that never comes: the wrapper wraps the rest. */
const UNCLOSED = -1;

/**
 * Where a wrapper opened at `opening` ends: its LAST close when it starts the
 * text (M1, `leadingClose`), its FIRST close otherwise — pinned on purpose: a
 * wrapper after the human text cannot tell its own quoted close from a human
 * sentence that names the tag, and the human's words win — or UNCLOSED.
 */
const wrapperEnd = (text: string, lower: string, opening: Opening, isLeading: boolean): number => {
  const close = `</${opening.tag}>`;
  const at = isLeading ? leadingClose(text, lower, opening, close) : lower.indexOf(close, opening.end);
  return at < opening.end ? UNCLOSED : at + close.length;
};

/** A wrapper a text ends inside: where it opened, and whether it led the turn (round 4, M3). */
interface Unclosed {
  readonly opening: Opening;
  readonly isLeading: boolean;
}

/** The text with every registered element removed, each replaced by one space, and the wrapper it ends inside. */
const withoutElements = (text: string): { readonly kept: string; readonly unclosed: Unclosed | null } => {
  const lower = asciiLower(text);
  const kept: string[] = [];
  let position = 0;
  let isLeading = true;
  for (let opening = nextOpening(text, 0); opening !== null; opening = nextOpening(text, position)) {
    const before = text.slice(position, opening.start);
    kept.push(before);
    isLeading = isLeading && before.trim().length === 0;
    position = wrapperEnd(text, lower, opening, isLeading);
    if (position === UNCLOSED) {
      return { kept: kept.join(" "), unclosed: { opening, isLeading } };
    }
  }
  kept.push(text.slice(position));
  return { kept: kept.join(" "), unclosed: null };
};

/**
 * THE REST OF A PROMPT AFTER A WRAPPER THE WINDOW ENDED INSIDE (round 4, M3):
 * found in the whole prompt by the same rule a window applies — a leading
 * wrapper's last close before its next opening, another's first close — or
 * null when it never closes. The hold-out's A17 put a 37 KB IDE selection in
 * front of "why does this stripe webhook handler create duplicate charges",
 * and the window's end swallowed the question. Linear: one lower-casing, one
 * forward search, one backward search. Where the rest begins, or UNCLOSED.
 */
const closeAfter = (text: string, unclosed: Unclosed): number =>
  wrapperEnd(text, asciiLower(text), unclosed.opening, unclosed.isLeading);

/** How far into a prompt a wrapper's close is looked for, past the window (M3): a mebibyte. */
const HARNESS_CLOSE_SEARCH_MAX_CHARS = 1_048_576;

/**
 * The turn without what the harness wrote, whitespace collapsed — it is a
 * search query from here on — or the prompt exactly as typed when it carries
 * none of the registered shapes and fits the window.
 */
export const humanPromptText = (prompt: string): string => humanTextOf(prompt, true);

/**
 * The human text, and — ONCE per prompt, so the scan stays linear — the text
 * after a wrapper the window ended inside (M3), its close looked for within
 * the first HARNESS_CLOSE_SEARCH_MAX_CHARS of the prompt.
 */
const humanTextOf = (prompt: string, mayLookPast: boolean): string => {
  const trimmed = prompt.trimStart();
  const window = trimmed.slice(0, HARNESS_SCAN_MAX_CHARS);
  const { kept, unclosed } = withoutElements(window);
  const stripped = kept.replace(MARKERS, " ");
  const headAt = stripped.search(HEAD);
  const human = headAt === -1 ? stripped : stripped.slice(0, headAt);
  // THE WINDOW ENDED INSIDE A WRAPPER (M3): its close, and the human text
  // after it, may lie past the window — the rest is read the same way.
  const restAt =
    mayLookPast && headAt === -1 && unclosed !== null && window.length < trimmed.length
      ? closeAfter(trimmed.slice(0, HARNESS_CLOSE_SEARCH_MAX_CHARS), unclosed)
      : UNCLOSED;
  if (restAt !== UNCLOSED) {
    return `${human} ${humanTextOf(trimmed.slice(restAt), false)}`.replace(/\s+/g, " ").trim();
  }
  if (human === window && window.length === prompt.length) {
    return prompt;
  }
  return human.replace(/\s+/g, " ").trim();
};

/** A turn that said something, all of it the harness's. */
export const isHarnessTurn = (prompt: string): boolean =>
  prompt.trim().length > 0 && humanPromptText(prompt).length === 0;
