/**
 * The one piece of text this hub cannot store, found before it is written.
 *
 * Postgres `text` is not `bytea`: an INSERT carrying U+0000 raises SQLSTATE
 * 22021 ("invalid byte sequence for encoding UTF8") from the DRIVER, below
 * every check the hub writes and below every guard the schemas apply. That is
 * why the refusal has to live here rather than in a column constraint — by
 * the time a constraint could speak, the statement has already failed and the
 * request is a 500.
 *
 * THIS IS NOT REDACTION AND NOT SANITISING. The sanitizer (connector-core's
 * briefing/sanitize.ts) decides what untrusted text may LOOK like when it is
 * rendered; this decides what any text may BE when it is stored. A NUL is not
 * dangerous, it is unwritable, and conflating the two would mean blanking a
 * body for a reason the author cannot act on.
 *
 * WHY A WALK AND NOT A FIELD LIST. A field list is a list to forget: the
 * record kinds are `looseObject`s by protocol rule (unknown fields are kept,
 * DESIGN.md §5), so a producer can put text in a field no schema here names,
 * and that text still reaches a column. Walking the parsed value is the only
 * check that stays true as the protocol grows.
 *
 * The walk is ITERATIVE on purpose. Depth comes from a network body, so a
 * deeply nested object would be a stack overflow — a 500 by another route —
 * on a recursive version.
 */

/**
 * Built rather than typed: a literal NUL in a source file is invisible in
 * every diff, review and terminal this project is read in.
 */
const NUL = String.fromCharCode(0);

/**
 * The dotted path of the first string that carries unstorable text, or null
 * when the whole value can be written.
 *
 * The path is what makes the refusal actionable — "body: …" tells an author
 * which field to fix, where "the hub refused the request" tells them nothing.
 */
export const unstorableTextPath = (value: unknown): string | null => {
  const pending: { readonly node: unknown; readonly path: string }[] = [
    { node: value, path: "" },
  ];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined) {
      break;
    }
    const { node, path } = entry;
    if (typeof node === "string") {
      if (node.includes(NUL)) {
        return path === "" ? "<root>" : path;
      }
      continue;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        pending.push({ node: item, path: `${path}[${String(index)}]` });
      });
      continue;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, item] of Object.entries(node)) {
        pending.push({ node: item, path: path === "" ? key : `${path}.${key}` });
      }
    }
  }
  return null;
};

/**
 * The sentence the author reads. It names the field, names the character, and
 * says what to do — the §8 rule for every refusal this product prints.
 */
export const describeUnstorableText = (path: string): string =>
  `${path}: text carries a NUL (U+0000), which no text column can hold — remove it and send again`;
