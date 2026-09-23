/**
 * THE ONE THING THAT NAMES A SINGLE TOOL CALL IN BOTH OF ITS HOOKS — and
 * therefore the only way a window can be paired to the call that opened it.
 *
 * PreToolUse opens the window an edit will happen in and PostToolUse closes it
 * once the tool has returned. The host hands BOTH hooks the same
 * `tool_use_id`, and no other call carries it: Claude Code's hooks reference
 * lists it among the PreToolUse input fields ("PreToolUse hooks receive
 * `tool_name`, `tool_input`, and `tool_use_id`") and shows it in the
 * PostToolUse and PostToolUseFailure examples (code.claude.com/docs/en/
 * hooks.md, read 2026-09-17). Read from the installed Claude Code 2.1.258
 * binary the same day: at both of its tool-execution call sites ONE variable
 * is passed as `tool_use_id` to all three hook inputs. The weekly
 * scripts/hook-contract-watch.ts job watches the field in both sections, so a
 * reference that stops documenting it turns that job red rather than turning
 * every bracket off in silence.
 *
 * WHY NOT A DIGEST OF `tool_name` + `tool_input`. That was the key first, on
 * the premise that the hooks share no id, and it leaves the defect open: two
 * IDENTICAL calls — the same edit issued twice in one batch — digest to ONE
 * key. A twin whose own open was refused (a busy lock) then found its
 * sibling's entry, took a floor recorded AFTER its own edit, and the hub
 * answered `predeclared` for an explanation written after the change —
 * measured through a real hub, and pinned in
 * connector-claude/test/hook-window-pairing.test.ts. No rule applied at the
 * close can repair a key that names two calls, because the close cannot tell
 * whether the entry it found is its own. The id can: it names one call.
 *
 * NO ID, NO KEY — AND NO WINDOW. A payload without `tool_use_id` (an older
 * host, or one that dropped the field) returns null, and a null key opens
 * nothing and closes nothing. Its edit travels as the upper bound it is and the
 * hub refuses every happens-before question against it. That is the documented
 * refusal: the alternative is a key that can name two calls, which is how the
 * defect above came back.
 *
 * WHAT A SURVIVING COLLISION COSTS. One call can still produce two entries
 * under one key — a double-wired install whose PreToolUse runs twice for the
 * same call (cli/doctor-global.ts, "a differing spelling runs twice") — and
 * both floors are then that call's own, so the close takes the OLDER one and
 * the interval only widens (state/session-state.ts `toolWindowFloorFor`).
 * Two DIFFERENT calls sharing an id would be a host that broke its own
 * contract; tool-window-pairing.test.ts pins exactly what that would cost, so
 * the assumption is written down rather than hoped for.
 *
 * IT IS INTERNAL. The digest lives in the session state and nowhere else: no
 * record carries it, no renderer prints it, nothing ships it to the hub.
 * Hashed rather than stored raw so that a host-supplied string of any length
 * costs one fixed-size entry in a list on the hook's hot path.
 */

/** The pairing key for one tool call, hex sha256 — or null with no host id. */
export const toolWindowKey = (
  toolName: string | undefined,
  toolUseId: string | undefined,
): string | null =>
  toolUseId === undefined || toolUseId.length === 0
    ? null
    : new Bun.CryptoHasher("sha256")
        .update(`${toolName ?? ""}\n${toolUseId}`)
        .digest("hex");
