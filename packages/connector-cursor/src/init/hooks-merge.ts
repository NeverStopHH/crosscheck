/**
 * Non-destructive merge of the team's `.cursor/hooks.json` — the
 * settings-merge DISCIPLINE (foreign hooks are the norm; clobbering them is
 * how an install gets reverted), new file shape. Not shared code with
 * `.claude/settings.json`'s merge for the same reason mcp-config.ts is not:
 * the shapes differ structurally. Cursor's file is
 * `{version, hooks: {<event>: [{command, timeout?, failClosed?, …}]}}` —
 * flat arrays of hook definitions, no matcher-group nesting.
 */
import {
  CURSOR_HOOKS_VERSION,
  CURSOR_HOOK_TIMEOUT_SECONDS,
} from "../constants.ts";
import { CURSOR_HOOK_EVENTS } from "../payload.ts";
import type { CursorHookEvent } from "../payload.ts";

/**
 * Matches every launcher form init resolves on its own — the `crosscheck`
 * binary, an absolute path to the entry script (optionally shell-quoted),
 * the legacy package invocation — followed by the `cursor-hook` subcommand.
 * The sibling of settings-merge.ts's OWNED_COMMAND_PATTERN (which keys on
 * ` hook `/` statusline` and can never match these entries); without it a
 * second `init --cursor` would not recognise its own entries and would
 * duplicate them.
 */
const OWNED_CURSOR_COMMAND_PATTERN =
  /(^|[\s"'/])@?crosscheck(?:\/[\w.-]+)*(?:\.[cm]?[jt]s)?["']?\s+cursor-hook\b/;

export const isOwnedCursorCommand = (command: unknown): boolean =>
  typeof command === "string" && OWNED_CURSOR_COMMAND_PATTERN.test(command);

export interface CursorHooksPlan {
  /** One command per registered event: `<prefix> cursor-hook <event>`. */
  readonly commands: Readonly<Record<CursorHookEvent, string>>;
  /** Explicit per-hook timeout (SECONDS — the documented unit). */
  readonly timeoutSeconds: number;
}

export const buildCursorHooksPlan = (prefix: string): CursorHooksPlan => ({
  commands: Object.fromEntries(
    CURSOR_HOOK_EVENTS.map((event) => [event, `${prefix} cursor-hook ${event}`]),
  ) as Record<CursorHookEvent, string>,
  timeoutSeconds: CURSOR_HOOK_TIMEOUT_SECONDS,
});

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asDefinitions = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];

/**
 * Pure: takes the parsed hooks.json, returns a new object. Never mutates.
 *
 * Rules, each load-bearing:
 *   - foreign entries (any command the owned pattern does not match) are
 *     preserved in place, foreign EVENTS untouched entirely;
 *   - our entry per event is appended after the preserved ones, with an
 *     explicit `timeout` and NEVER `failClosed` — fail-open is
 *     non-negotiable (§3.2), and a build that flipped that here would turn
 *     a dead hub into blocked file reads;
 *   - an existing numeric `version` is preserved (a future Cursor bumping
 *     it knows more than we do); absent → the documented version 1;
 *   - unknown top-level keys ride through untouched.
 */
export const mergeCursorHooks = (
  existing: Record<string, unknown>,
  plan: CursorHooksPlan,
): Record<string, unknown> => {
  const existingHooks = asRecord(existing["hooks"]);
  const mergedHooks = Object.entries(plan.commands).reduce<
    Record<string, unknown>
  >(
    (hooks, [event, command]) => {
      const preserved = asDefinitions(existingHooks[event]).filter(
        (definition) => !isOwnedCursorCommand(definition["command"]),
      );
      return {
        ...hooks,
        [event]: [
          ...preserved,
          { command, timeout: plan.timeoutSeconds },
        ],
      };
    },
    { ...existingHooks },
  );
  const version = existing["version"];
  return {
    ...existing,
    version: typeof version === "number" ? version : CURSOR_HOOKS_VERSION,
    hooks: mergedHooks,
  };
};
