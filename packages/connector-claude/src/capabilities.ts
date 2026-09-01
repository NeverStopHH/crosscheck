/**
 * WHAT CROSSCHECK CAN INFER INSIDE CLAUDE CODE — the reference manifest, and
 * the one every other connector's rungs are read against.
 *
 * It is declared here rather than assumed anywhere for the same reason the
 * Cursor one is: `doctor` must be able to answer "is anything being derived
 * for me" per host, and a connector whose answer is implicit is a connector
 * whose answer drifts. The meta-test
 * (connector-core/test/derive-capability-registry.test.ts) reads this file
 * against what this package actually ships, in both directions — an
 * undeclared trigger and an undelivered declaration are both red.
 */
import { DEFAULT_AGENT_KIND } from "@crosscheck/connector-core/constants.ts";
import type { DeriveCapabilityManifest } from "@crosscheck/connector-core/derive/capabilities.ts";

export const CLAUDE_CAPABILITY_MANIFEST: DeriveCapabilityManifest = {
  connector: DEFAULT_AGENT_KIND,
  capabilities: [
    {
      name: "intent",
      rung: "full",
      sentence:
        "UserPromptSubmit carries the prompt, and the first substantive one fires the derived-intent worker",
    },
    {
      name: "ghost",
      rung: "full",
      sentence:
        "the debt a recorded intent opens is paid on the next UserPromptSubmit",
    },
    {
      name: "summarizer",
      rung: "full",
      sentence:
        "the Stop payload carries transcript_path and Claude Code's JSONL format is read by byte range, so the gate sees the whole turn with its ask",
    },
    {
      name: "conference",
      rung: "full",
      sentence:
        "`crosscheck conference` is a command a human runs, not a hook, so it needs nothing from the host — only a working model runner (see the summarizer runner check)",
    },
  ],
  refusals: [],
};
