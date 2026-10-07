/**
 * A Claude Code HOST for the release gate: it fires the hooks exactly as
 * `crosscheck init` wires them on THIS build, by reading the real settings
 * plan (cli/settings-merge.ts `buildSettingsPlan`) — events, matchers, async
 * flags, and every group of an event. A build that wires SubagentStop
 * (feat/topic-contexts) or a sync PostToolUse on the subagent tools
 * (feat/collision-visible, `subagent-return`) gets those hooks fired; a build
 * that does not, does not. No branch is named in here.
 *
 * WHAT THE PERSON SEES is the only channel the gate's positive assertions
 * accept (`personLines`): a `systemMessage` from a SYNC hook of the MAIN
 * thread. An async hook's fields reach Claude on the next turn and are never
 * shown to the person; a hook inside a subagent (`agent_id` on its payload)
 * writes into the subagent's context, which is not the conversation the
 * person reads (hooks reference, "Common input fields").
 *
 * TOOLS HAVE THEIR EFFECT ON DISK between PreToolUse and PostToolUse, with
 * the payloads Claude Code sends: an Edit names old and new strings, a Write
 * carries the whole `content` (so a `.env` secret really is in the hook's
 * stdin), a Bash call carries only its command line.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { buildSettingsPlan, isHookName, runHook, runStatusline } from "../../../src/index.ts";
import type { Env } from "../../../src/index.ts";

export type HostEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "SessionEnd";

interface PlannedHook {
  readonly event: string;
  readonly matcher: string | null;
  readonly hook: string;
  readonly isAsync: boolean;
}

interface RawGroup {
  readonly matcher?: unknown;
  readonly hooks?: unknown;
}

interface RawHook {
  readonly command?: unknown;
  readonly async?: unknown;
}

/** `crosscheck hook <name>` → `<name>`; anything else is not a hook we fire. */
const hookNameOf = (command: string): string | null => {
  const parts = command.trim().split(/\s+/);
  const at = parts.lastIndexOf("hook");
  return at === -1 || at === parts.length - 1 ? null : (parts[at + 1] ?? null);
};

const groupHooks = (event: string, group: RawGroup): readonly PlannedHook[] => {
  const hooks = Array.isArray(group.hooks) ? (group.hooks as readonly RawHook[]) : [];
  return hooks.flatMap((entry) => {
    const name = typeof entry.command === "string" ? hookNameOf(entry.command) : null;
    return name === null
      ? []
      : [
          {
            event,
            matcher: typeof group.matcher === "string" && group.matcher.length > 0 ? group.matcher : null,
            hook: name,
            isAsync: entry.async === true,
          },
        ];
  });
};

/**
 * The plan's hooks, flattened. `hooks[event]` is one group on some builds and
 * a list of groups on others (collision-visible's PostToolUse carries two),
 * so both shapes are read — from data, never from a branch name.
 */
export const PLANNED_HOOKS: readonly PlannedHook[] = Object.entries(
  (buildSettingsPlan("crosscheck", false) as unknown as { readonly hooks: Readonly<Record<string, unknown>> }).hooks,
).flatMap(([event, value]) =>
  (Array.isArray(value) ? (value as readonly RawGroup[]) : [value as RawGroup]).flatMap((group) =>
    groupHooks(event, group),
  ),
);

/** Claude Code's matcher: a regex over the tool name, anchored; none matches all. */
const matches = (matcher: string | null, subject: string | null): boolean =>
  matcher === null || matcher === "*" || (subject !== null && new RegExp(`^(?:${matcher})$`).test(subject));

export interface HookOutput {
  readonly systemMessage: string | null;
  readonly additionalContext: string | null;
  readonly permissionDecision: string | null;
  readonly permissionDecisionReason: string | null;
}

const NO_OUTPUT: HookOutput = {
  systemMessage: null,
  additionalContext: null,
  permissionDecision: null,
  permissionDecisionReason: null,
};

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

const parseOutput = (stdout: string): HookOutput => {
  if (stdout.trim().length === 0) {
    return NO_OUTPUT;
  }
  try {
    const parsed = JSON.parse(stdout) as {
      readonly systemMessage?: unknown;
      readonly hookSpecificOutput?: Readonly<Record<string, unknown>>;
    };
    const specific = parsed.hookSpecificOutput ?? {};
    return {
      systemMessage: stringOrNull(parsed.systemMessage),
      additionalContext: stringOrNull(specific["additionalContext"]),
      permissionDecision: stringOrNull(specific["permissionDecision"]),
      permissionDecisionReason: stringOrNull(specific["permissionDecisionReason"]),
    };
  } catch {
    // Plain stdout of a SessionStart/UserPromptSubmit hook is model context.
    return { ...NO_OUTPUT, additionalContext: stdout };
  }
};

export interface HookRun {
  readonly label: string;
  readonly developer: string;
  readonly sessionId: string;
  readonly event: HostEvent;
  readonly hook: string;
  readonly isAsync: boolean;
  /** False when the plan names a hook this build's runner does not know. */
  readonly isImplemented: boolean;
  readonly agentId: string | null;
  readonly toolName: string | null;
  readonly filePath: string | null;
  readonly stdout: string;
  readonly output: HookOutput;
}

/** A line the PERSON is shown: a sync main-thread hook's systemMessage. */
export const personLines = (runs: readonly HookRun[]): readonly string[] =>
  runs.flatMap((run) =>
    !run.isAsync && run.agentId === null && run.output.systemMessage !== null ? [run.output.systemMessage] : [],
  );

/** Everything the MODEL is handed (any thread): additionalContext and ask reasons. */
export const agentTexts = (runs: readonly HookRun[]): readonly string[] =>
  runs.flatMap((run) =>
    [run.output.additionalContext, run.output.permissionDecisionReason].filter(
      (text): text is string => text !== null,
    ),
  );

export interface Actor {
  readonly agentId: string | null;
  readonly agentType: string | null;
}

export const MAIN_THREAD: Actor = { agentId: null, agentType: null };

export interface HostDeveloper {
  readonly name: string;
  readonly env: Env;
}

export interface HostSession {
  readonly sessionId: string;
  readonly developer: HostDeveloper;
  readonly runs: () => readonly HookRun[];
  readonly label: (phase: string) => void;
  readonly start: (source?: "startup" | "resume", title?: string) => Promise<readonly HookRun[]>;
  readonly prompt: (text: string) => Promise<readonly HookRun[]>;
  /** Edit (file exists) or Write (it does not) of `path` to `content`. */
  readonly edit: (path: string, content: string, actor?: Actor) => Promise<readonly HookRun[]>;
  /** A Bash call whose effect on disk is `effect`, run in `cwd`. */
  readonly bash: (
    command: string,
    effect: () => Promise<void>,
    options: { readonly cwd: string; readonly actor?: Actor },
  ) => Promise<readonly HookRun[]>;
  /**
   * A foreground subagent: `body` runs its tool calls under a fresh agent id,
   * then SubagentStop fires and the main thread's PostToolUse on the Task
   * tool — the subagent RETURNING — exactly as the host orders them. Returns
   * the runs of that return.
   */
  readonly subagent: (agentType: string, body: (actor: Actor) => Promise<void>) => Promise<readonly HookRun[]>;
  readonly stop: () => Promise<readonly HookRun[]>;
  readonly end: () => Promise<readonly HookRun[]>;
  readonly statusline: () => Promise<string>;
}

const exists = async (path: string): Promise<boolean> =>
  readFile(path, "utf8").then(
    () => true,
    () => false,
  );

const previousText = async (path: string): Promise<string> => readFile(path, "utf8").catch(() => "");

export const openSession = (developer: HostDeveloper, sessionId: string, cwd: string): HostSession => {
  const runs: HookRun[] = [];
  const state = { label: "start", toolSeq: 0, agentSeq: 0 };

  const fire = async (event: HostEvent, payload: Readonly<Record<string, unknown>>): Promise<readonly HookRun[]> => {
    const toolName = stringOrNull(payload["tool_name"]);
    const subject = event === "SessionStart" ? stringOrNull(payload["source"]) : toolName;
    const agentId = stringOrNull(payload["agent_id"]);
    const input = payload["tool_input"] as Readonly<Record<string, unknown>> | undefined;
    const fired: HookRun[] = [];
    for (const planned of PLANNED_HOOKS) {
      if (planned.event !== event || !matches(planned.matcher, subject)) {
        continue;
      }
      const isImplemented = isHookName(planned.hook);
      const stdout = isImplemented
        ? await runHook(planned.hook as Parameters<typeof runHook>[0], JSON.stringify(payload), developer.env)
        : "";
      fired.push({
        label: state.label,
        developer: developer.name,
        sessionId,
        event,
        hook: planned.hook,
        isAsync: planned.isAsync,
        isImplemented,
        agentId,
        toolName,
        filePath: stringOrNull(input?.["file_path"]),
        stdout,
        output: parseOutput(stdout),
      });
    }
    runs.push(...fired);
    return fired;
  };

  const base = (event: HostEvent, actor: Actor, at: string = cwd): Record<string, unknown> => ({
    session_id: sessionId,
    cwd: at,
    hook_event_name: event,
    ...(actor.agentId === null ? {} : { agent_id: actor.agentId, agent_type: actor.agentType }),
  });

  const toolCall = async (
    actor: Actor,
    at: string,
    toolName: string,
    toolInput: Readonly<Record<string, unknown>>,
    perform: () => Promise<Readonly<Record<string, unknown>>>,
  ): Promise<readonly HookRun[]> => {
    state.toolSeq += 1;
    const toolUseId = `toolu_${sessionId}_${String(state.toolSeq)}`;
    const call = { tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId };
    const pre = await fire("PreToolUse", { ...base("PreToolUse", actor, at), ...call });
    const toolResponse = await perform();
    const post = await fire("PostToolUse", { ...base("PostToolUse", actor, at), ...call, tool_response: toolResponse });
    return [...pre, ...post];
  };

  const edit = async (path: string, content: string, actor: Actor = MAIN_THREAD): Promise<readonly HookRun[]> => {
    const isUpdate = await exists(path);
    const before = await previousText(path);
    const toolInput = isUpdate
      ? { file_path: path, old_string: before, new_string: content, replace_all: false }
      : { file_path: path, content };
    return toolCall(actor, cwd, isUpdate ? "Edit" : "Write", toolInput, async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return isUpdate
        ? { filePath: path, oldString: before, newString: content, structuredPatch: [], userModified: false }
        : { type: "create", filePath: path, content, structuredPatch: [] };
    });
  };

  const bash: HostSession["bash"] = async (command, effect, options) =>
    toolCall(options.actor ?? MAIN_THREAD, options.cwd, "Bash", { command, description: command }, async () => {
      await effect();
      return { stdout: "", stderr: "", interrupted: false, isImage: false };
    });

  const subagent: HostSession["subagent"] = async (agentType, body) => {
    state.agentSeq += 1;
    const actor: Actor = { agentId: `agent_${sessionId}_${String(state.agentSeq)}`, agentType };
    await body(actor);
    const stopped = await fire("SubagentStop", { ...base("SubagentStop", actor), stop_hook_active: false });
    state.toolSeq += 1;
    const returned = await fire("PostToolUse", {
      ...base("PostToolUse", MAIN_THREAD),
      tool_name: "Task",
      tool_input: { description: `${agentType} work`, prompt: `do the ${agentType} part`, subagent_type: agentType },
      tool_use_id: `toolu_${sessionId}_${String(state.toolSeq)}`,
      tool_response: { content: [{ type: "text", text: "done" }], totalToolUseCount: 1 },
    });
    return [...stopped, ...returned];
  };

  return {
    sessionId,
    developer,
    runs: () => [...runs],
    label: (phase) => {
      state.label = phase;
    },
    start: async (source = "startup", title) =>
      fire("SessionStart", {
        ...base("SessionStart", MAIN_THREAD),
        source,
        ...(title === undefined ? {} : { session_title: title }),
      }),
    prompt: async (text) => fire("UserPromptSubmit", { ...base("UserPromptSubmit", MAIN_THREAD), prompt: text }),
    edit,
    bash,
    subagent,
    stop: async () => fire("Stop", { ...base("Stop", MAIN_THREAD), stop_hook_active: false }),
    end: async () => fire("SessionEnd", { ...base("SessionEnd", MAIN_THREAD), reason: "other" }),
    statusline: async () =>
      runStatusline(
        JSON.stringify({
          session_id: sessionId,
          cwd,
          hook_event_name: "Status",
          workspace: { current_dir: cwd, project_dir: cwd },
        }),
        developer.env,
      ),
  };
};
