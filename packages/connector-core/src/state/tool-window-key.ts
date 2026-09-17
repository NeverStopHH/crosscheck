/**
 * THE ONE THING BOTH HOOKS OF A TOOL CALL ARE HANDED — and therefore the only
 * way a window can be paired to the tool that opened it.
 *
 * PreToolUse opens the window an edit will happen in and PostToolUse closes it
 * once the tool has returned, but the host gives the two hooks NO shared tool
 * id: the payload carries `session_id`, `cwd`, `tool_name` and `tool_input`
 * and nothing that identifies this invocation. Before this key the close was
 * driven by `isEditTool(tool_name)` alone and the bracket was the OLDEST open
 * window's floor, so a tool whose own PreToolUse was refused closed a PARALLEL
 * tool's window and stamped its edit with a floor taken AFTER that edit
 * happened — the hub then answered `predeclared`, the value that exonerates,
 * for an explanation written afterwards.
 *
 * SO THE KEY IS A DIGEST OF THE CALL: `tool_name`, a newline, and the tool
 * input serialised with OBJECT KEYS SORTED. The sort is what makes it survive
 * a re-serialisation — the two hooks are handed the same input, but nothing
 * promises the same byte order — and it is recursive, because a nested object
 * re-orders just as easily as a top-level one.
 *
 * WHAT A MISMATCH COSTS, and why that is the right failure. Two calls with the
 * same name and the same input collide on one key (handled where the window is
 * closed: every closer in a colliding group takes the group's OLDEST floor, so
 * the interval only ever widens). A host that hands PostToolUse an input
 * PreToolUse did not see produces NO match, and no match means no bracket —
 * the upper bound the hub already knows how to refuse, never a floor belonging
 * to something else.
 *
 * IT IS INTERNAL. The digest lives in the session state and nowhere else: no
 * record carries it, no renderer prints it, nothing ships it to the hub. It is
 * derived from a tool input that may contain anything, so keeping it out of
 * every reader is a privacy rule as much as a design one — sha256 is one-way,
 * but a key nobody reads cannot leak what it was made of either.
 */

/**
 * JSON with every object's keys in sorted order. Arrays keep their order —
 * `["a","b"]` and `["b","a"]` are different inputs — and every non-object
 * value serialises as itself.
 */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const pairs = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${pairs.join(",")}}`;
  }
  // `undefined` has no JSON form and a missing `tool_input` is a real payload,
  // so it is spelled rather than left to `JSON.stringify`'s `undefined`.
  return value === undefined ? "null" : JSON.stringify(value);
};

/** The pairing key for one tool call, hex sha256, stable across hooks. */
export const toolWindowKey = (
  toolName: string | undefined,
  toolInput: unknown,
): string =>
  new Bun.CryptoHasher("sha256")
    .update(`${toolName ?? ""}\n${canonicalJson(toolInput)}`)
    .digest("hex");
