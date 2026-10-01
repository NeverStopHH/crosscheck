/**
 * The one conversation this CLI holds with a person (1.0 spec 07 §12):
 * `crosscheck pilot label` reads ONE KEY per intervention, and a LINE only
 * when the person asked to add a reason.
 *
 * EVERY OTHER COMMAND RETURNS ONE STRING and the bin prints it at the end. A
 * walk cannot: the person has to see an intervention before choosing its
 * key. So the walk writes as it goes and reads through this seam, which is
 * INJECTED — tests drive a scripted terminal, and nothing here can be
 * reached through the environment, for `pin`'s reason: an env var would be a
 * bypass any agent could set.
 *
 * RAW MODE FOR A KEY, COOKED FOR A LINE, AND ALWAYS PUT BACK. A key is read
 * with the terminal in raw mode so one press answers without Enter; the
 * mode is restored in a `finally`, or a walk that ended badly would leave
 * the person's shell with no echo and no line editing. A reason is read in
 * cooked mode, so the terminal itself echoes and edits the line.
 *
 * Ctrl-C AND Ctrl-D ARE "STOP". In raw mode the terminal delivers them as
 * bytes, not as a signal, so they are mapped to the same end-of-input the
 * walk already treats as `q`: what was labelled stays, nothing else is sent.
 *
 * ONE CHUNK IS ONE ANSWER. A human types one key and waits for the next
 * line; a paste of several keys at once is read as its first key, which
 * re-asks rather than guesses for whatever followed.
 */

/** What the walk needs from a terminal, and nothing else. */
export interface LabelTerminal {
  /** Print now — a walk is read as it goes, never buffered to the end. */
  readonly write: (text: string) => void;
  /** One key press as typed; null when input ended (Ctrl-C, Ctrl-D, a closed stream). */
  readonly readKey: () => Promise<string | null>;
  /** One line without its line ending; null when input ended before the line did. */
  readonly readLine: () => Promise<string | null>;
}

/** The part of `process.stdin` the reads use — so a test can stand in for it. */
export interface KeyInput {
  readonly setRawMode?: (mode: boolean) => unknown;
  readonly resume: () => unknown;
  readonly pause: () => unknown;
  readonly on: (event: string, listener: (chunk?: unknown) => void) => unknown;
  readonly off: (event: string, listener: (chunk?: unknown) => void) => unknown;
}

/** Ctrl-C (ETX) and Ctrl-D (EOT), as raw mode delivers them. */
const STOP_BYTES: readonly string[] = ["\u0003", "\u0004"];

const LINE_END = /\r?\n/;

/**
 * The next chunk the input delivers, or null at its end. Every listener it
 * adds is removed before it settles, so no later read inherits one.
 */
const nextChunk = (input: KeyInput): Promise<string | null> =>
  new Promise((resolve) => {
    const settle = (value: string | null): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.pause();
      resolve(value);
    };
    const onData = (chunk?: unknown): void => {
      settle(String(chunk ?? ""));
    };
    const onEnd = (): void => {
      settle(null);
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.resume();
  });

const readKeyFrom = async (input: KeyInput): Promise<string | null> => {
  input.setRawMode?.(true);
  try {
    const chunk = await nextChunk(input);
    const [key] = chunk === null ? [] : [...chunk];
    return key === undefined || STOP_BYTES.includes(key) ? null : key;
  } finally {
    input.setRawMode?.(false);
  }
};

/** Chunks until a line ending; input that ends first is a stop, never half a sentence. */
const readLineFrom = async (input: KeyInput, sofar = ""): Promise<string | null> => {
  const chunk = await nextChunk(input);
  if (chunk === null) {
    return null;
  }
  const text = `${sofar}${chunk}`;
  const end = LINE_END.exec(text);
  return end === null ? readLineFrom(input, text) : text.slice(0, end.index);
};

export const terminalFrom = (
  input: KeyInput,
  write: (text: string) => void,
): LabelTerminal => ({
  write,
  readKey: () => readKeyFrom(input),
  readLine: () => readLineFrom(input),
});

/** This process's own terminal. Built only when a walk runs, never on import. */
export const processTerminal = (): LabelTerminal =>
  terminalFrom(process.stdin, (text) => {
    process.stdout.write(text);
  });
