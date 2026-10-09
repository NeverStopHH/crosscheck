import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { runHookWith } from "./runner.ts";
import type { HookHandler, HookName } from "./runner.ts";

/**
 * EACH HOOK LOADS ITS OWN HANDLER, AND ONLY IT (batch-2 review, M6). A hook
 * process runs exactly one handler, and loading all ten — with every module
 * each one reaches — was evaluation every hook paid in its process's boot,
 * the part of a hook's wall clock no budget covers and the host still waits
 * for. The runner itself stays static: its early exits and the budget race
 * are every hook's.
 */
const HANDLERS: Readonly<Record<HookName, () => Promise<HookHandler>>> = {
  "session-start": async () => (await import("./session-start.ts")).handleSessionStart,
  "post-tool-use": async () => (await import("./post-tool-use.ts")).handlePostToolUse,
  "post-tool-use-failure": async () => (await import("./post-tool-use-failure.ts")).handlePostToolUseFailure,
  "session-end": async () => (await import("./session-end.ts")).handleSessionEnd,
  "user-prompt-submit": async () => (await import("./user-prompt-submit.ts")).handleUserPromptSubmit,
  "pre-tool-use": async () => (await import("./pre-tool-use.ts")).handlePreToolUse,
  stop: async () => (await import("./stop.ts")).handleStop,
  "subagent-stop": async () => (await import("./subagent-stop.ts")).handleSubagentStop,
  "subagent-return": async () => (await import("./subagent-return.ts")).handleSubagentReturn,
  "turn-end": async () => (await import("./turn-end.ts")).handleTurnEnd,
};

export const isHookName = (value: string): value is HookName =>
  value in HANDLERS;

/** Single entry point for every hook: returns stdout text, never throws. */
export const runHook = async (
  name: HookName,
  stdin: string,
  env: Env,
): Promise<string> => runHookWith(name, await HANDLERS[name](), stdin, env);
