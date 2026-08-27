/**
 * The ONE character-budget reducer the briefing's bounded blocks share.
 *
 * A block bounded only in ITEMS is not bounded: a question body may be 400
 * characters and a ghost line 491, so "at most three" and "at most two" say
 * nothing about what is left for the sections below. Every block that carries
 * untrusted, variable-length text therefore carries a second bound in
 * CHARACTERS, and this is the one place that bound is spent.
 *
 * ENTRIES ARE DROPPED WHOLE, never truncated. A cut question is unanswerable
 * and a cut ghost line loses the `get_diagnosis` id that is its whole next
 * action; a row left out is merely a row the section's own "+N more not
 * shown" tail reports. The FIRST entry is always kept whatever its length —
 * a block with something to say must never render as a header with nothing
 * under it, and briefing/render.ts's global MAX_BRIEFING_CHARS pass is what
 * catches a first entry too long for the briefing as a whole.
 *
 * It never touches the text: strings go in already rendered and already
 * sanitized by their own module, and what comes back is a subset of them in
 * order. That is why this is not a render-layer module — there is no way to
 * mint a frame or a field from a reducer that only drops.
 */
export const fitEntries = (
  entries: readonly string[],
  maxChars: number,
): readonly string[] =>
  entries.reduce<readonly string[]>((kept, entry) => {
    if (kept.length === 0) {
      return [entry];
    }
    const candidate = [...kept, entry];
    return candidate.join("\n").length > maxChars ? kept : candidate;
  }, []);
