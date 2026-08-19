import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { handlePostToolUse } from "./post-tool-use.ts";
import { handlePreToolUse } from "./pre-tool-use.ts";
import { handleSessionEnd } from "./session-end.ts";
import { handleSessionStart } from "./session-start.ts";
import { handleStop } from "./stop.ts";
import { handleUserPromptSubmit } from "./user-prompt-submit.ts";
import { runHookWith } from "./runner.ts";
import type { HookHandler, HookName } from "./runner.ts";

const HANDLERS: Readonly<Record<HookName, HookHandler>> = {
  "session-start": handleSessionStart,
  "post-tool-use": handlePostToolUse,
  "session-end": handleSessionEnd,
  "user-prompt-submit": handleUserPromptSubmit,
  "pre-tool-use": handlePreToolUse,
  stop: handleStop,
};

export const isHookName = (value: string): value is HookName =>
  value in HANDLERS;

/** Single entry point for every hook: returns stdout text, never throws. */
export const runHook = async (
  name: HookName,
  stdin: string,
  env: Env,
): Promise<string> => runHookWith(name, HANDLERS[name], stdin, env);
