/**
 * Non-destructive merge of the team's .claude/settings.json. Foreign hooks are
 * the norm, not the exception — clobbering them is how an install gets
 * reverted (DESIGN.md §2: install = one PR).
 */
import {
  POST_TOOL_USE_MATCHER,
  PRE_TOOL_USE_MATCHER,
} from "@crosscheck/connector-core/constants.ts";
/**
 * Matches every launcher form `init` resolves on its OWN: the `crosscheck`
 * binary, an absolute path to the entry script (optionally shell-quoted), and
 * the legacy package invocation. Without all three a second `init` would not
 * recognise its own entries and would duplicate them.
 *
 * A `--command-prefix` that does not name crosscheck falls outside it, and has
 * to: an operator's arbitrary launcher cannot be recognised by pattern. Such an
 * entry is added alongside rather than replaced by a second `init`, and
 * `doctor` reports those hooks as unregistered.
 */
const OWNED_COMMAND_PATTERN =
  /(^|[\s"'/])@?crosscheck(?:\/[\w.-]+)*(?:\.[cm]?[jt]s)?["']?\s+(?:hook|statusline)\b/;

export interface HookEntry {
  readonly type: string;
  readonly command: string;
  readonly async?: boolean;
}

export interface MatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookEntry[];
}

export interface StatuslineEntry {
  readonly type: string;
  readonly command: string;
}

export interface SettingsPlan {
  readonly hooks: Readonly<Record<string, MatcherGroup>>;
  readonly statusLine: StatuslineEntry;
  readonly forceStatusline: boolean;
}

export interface MergeResult {
  readonly settings: Record<string, unknown>;
  readonly statuslineInstalled: boolean;
  readonly foreignStatuslineCommand: string | null;
}

export const isOwnedCommand = (command: unknown): boolean =>
  typeof command === "string" && OWNED_COMMAND_PATTERN.test(command);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asGroups = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];

const stripOwnedHooks = (
  group: Record<string, unknown>,
): Record<string, unknown> | null => {
  const hooks = Array.isArray(group["hooks"]) ? group["hooks"] : [];
  const kept = hooks.filter(
    (hook) => !isOwnedCommand(asRecord(hook)["command"]),
  );
  if (kept.length === 0) {
    return null;
  }
  return { ...group, hooks: kept };
};

const mergeEvent = (
  existing: unknown,
  ours: MatcherGroup,
): readonly unknown[] => {
  const preserved = asGroups(existing)
    .map(stripOwnedHooks)
    .filter((group): group is Record<string, unknown> => group !== null);
  return [...preserved, ours];
};

const mergeStatusline = (
  existing: unknown,
  plan: SettingsPlan,
): {
  readonly value: StatuslineEntry | unknown;
  readonly installed: boolean;
  readonly foreign: string | null;
} => {
  const current = asRecord(existing);
  const currentCommand = current["command"];
  const hasStatusline = typeof currentCommand === "string";
  if (!hasStatusline || isOwnedCommand(currentCommand) || plan.forceStatusline) {
    return { value: plan.statusLine, installed: true, foreign: null };
  }
  return {
    value: existing,
    installed: false,
    foreign: currentCommand as string,
  };
};

/** Pure: takes the parsed settings, returns a new object. Never mutates. */
export const mergeClaudeSettings = (
  existing: Record<string, unknown>,
  plan: SettingsPlan,
): MergeResult => {
  const existingHooks = asRecord(existing["hooks"]);
  const mergedHooks = Object.entries(plan.hooks).reduce<
    Record<string, unknown>
  >(
    (hooks, [event, group]) => ({
      ...hooks,
      [event]: mergeEvent(existingHooks[event], group),
    }),
    { ...existingHooks },
  );
  const statusline = mergeStatusline(existing["statusLine"], plan);
  return {
    settings: {
      ...existing,
      hooks: mergedHooks,
      statusLine: statusline.value,
    },
    statuslineInstalled: statusline.installed,
    foreignStatuslineCommand: statusline.foreign,
  };
};

export interface RemovalResult {
  readonly settings: Record<string, unknown>;
  /** False = nothing crosscheck-owned was found; the input passes through. */
  readonly changed: boolean;
}

/**
 * The inverse of `mergeClaudeSettings`, for `init --global --remove`
 * (finding #11): strips exactly what a crosscheck init wrote and leaves
 * every foreign byte where it was. Pure, order-preserving — the object is
 * rebuilt by walking the existing entries in place, never delete-then-
 * append, so a JSON render of the result is byte-identical to the original
 * render everywhere crosscheck never touched.
 *
 * The emptiness rules mirror what install CREATED rather than guessing at
 * history: an event array that changed and ended empty held only our
 * entries, so the key goes; one that was already empty is untouched and
 * stays. The `hooks` record itself goes only when it both changed and ended
 * empty. A statusLine goes only when `isOwnedCommand` says it is ours — a
 * foreign one that `--force-statusline` replaced is NOT restored (the
 * force was the operator's choice, and the backup beside the file is the
 * recovery path); an untouched foreign one stays byte-identical.
 */
export const removeClaudeSettings = (
  existing: Record<string, unknown>,
): RemovalResult => {
  let changed = false;
  const settings = Object.entries(existing).reduce<Record<string, unknown>>(
    (kept, [key, value]) => {
      if (key === "hooks") {
        const { hooks, hooksChanged } = strippedHooks(asRecord(value));
        changed = changed || hooksChanged;
        return hooksChanged && Object.keys(hooks).length === 0
          ? kept
          : { ...kept, [key]: hooksChanged ? hooks : value };
      }
      if (key === "statusLine" && isOwnedCommand(asRecord(value)["command"])) {
        changed = true;
        return kept;
      }
      return { ...kept, [key]: value };
    },
    {},
  );
  return { settings, changed };
};

/**
 * One event's groups with the owned hooks stripped. Change detection is
 * per HOOK, not per group count: a group mixing a foreign hook with an
 * owned one keeps its length while losing content, and a count comparison
 * would return the original — owned entry included — as "unchanged".
 */
const strippedEvent = (
  groups: unknown,
): { readonly value: unknown; readonly eventChanged: boolean } => {
  if (!Array.isArray(groups)) {
    return { value: groups, eventChanged: false };
  }
  let eventChanged = false;
  const preserved = groups.flatMap((item) => {
    // Non-object entries are foreign junk this removal has no opinion on:
    // preserved verbatim, never counted as a change.
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [item];
    }
    const group = item as Record<string, unknown>;
    const hooks = Array.isArray(group["hooks"]) ? group["hooks"] : [];
    const kept = hooks.filter(
      (hook) => !isOwnedCommand(asRecord(hook)["command"]),
    );
    if (kept.length === hooks.length) {
      return [group];
    }
    eventChanged = true;
    return kept.length === 0 ? [] : [{ ...group, hooks: kept }];
  });
  return { value: eventChanged ? preserved : groups, eventChanged };
};

const strippedHooks = (
  existingHooks: Record<string, unknown>,
): { readonly hooks: Record<string, unknown>; readonly hooksChanged: boolean } => {
  let hooksChanged = false;
  const hooks = Object.entries(existingHooks).reduce<Record<string, unknown>>(
    (kept, [event, groups]) => {
      const { value, eventChanged } = strippedEvent(groups);
      hooksChanged = hooksChanged || eventChanged;
      if (!eventChanged) {
        return { ...kept, [event]: groups };
      }
      return Array.isArray(value) && value.length === 0
        ? kept
        : { ...kept, [event]: value };
    },
    {},
  );
  return { hooks, hooksChanged };
};

/**
 * The Claude Code hook plan `crosscheck init` installs — MOVED VERBATIM from
 * `cli/init.ts` when Block 8 extracted `packages/cli`: the plan is knowledge
 * about CLAUDE'S settings file shapes (which events exist, which run async,
 * which need matchers), so it lives beside the merge that writes it, and the
 * host-agnostic init command imports both from this package.
 */
export const buildSettingsPlan = (
  prefix: string,
  forceStatusline: boolean,
): SettingsPlan => {
  const group = (
    command: string,
    matcher?: string,
    isAsync?: boolean,
  ): MatcherGroup => ({
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [
      {
        type: "command",
        command,
        ...(isAsync === true ? { async: true } : {}),
      },
    ],
  });
  return {
    hooks: {
      SessionStart: group(`${prefix} hook session-start`),
      PostToolUse: group(
        `${prefix} hook post-tool-use`,
        POST_TOOL_USE_MATCHER,
        true,
      ),
      SessionEnd: group(`${prefix} hook session-end`),
      // The injection pipeline (DESIGN.md §4): both SYNC, deliberately — one
      // returns additionalContext, the other a permission decision, and an
      // async hook can deliver neither.
      UserPromptSubmit: group(`${prefix} hook user-prompt-submit`),
      PreToolUse: group(`${prefix} hook pre-tool-use`, PRE_TOOL_USE_MATCHER),
      // The Tier-1 summarizer gate (DESIGN.md §3 Tier 1): ASYNC, because the
      // hook returns nothing — it gates deterministically and spawns the
      // detached worker; the model must never wait on it.
      Stop: group(`${prefix} hook stop`, undefined, true),
    },
    statusLine: { type: "command", command: `${prefix} statusline` },
    forceStatusline,
  };
};
