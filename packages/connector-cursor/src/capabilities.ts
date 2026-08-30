/**
 * WHAT CROSSCHECK CAN INFER INSIDE CURSOR — declared as data so `doctor`
 * prints it, and so a rung this connector ships without declaring is a red
 * build (connector-core/test/derive-capability-registry.test.ts).
 *
 * Every sentence below is about CURSOR — a documented payload field, a
 * documented output field, a documented absence — because the reader of these
 * lines is someone whose Cursor is quiet and who needs to know whether that
 * is a platform limit or a broken install. All hook facts re-read from
 * cursor.com/docs/hooks on 2026-08-28; the offline copy is
 * test/fixtures/cursor-contract/docs-excerpt-cursor-hooks.md.
 */
import type { DeriveCapabilityManifest } from "@crosscheck/connector-core/derive/capabilities.ts";
import { CURSOR_AGENT_KIND } from "@crosscheck/connector-core/state/host-session-key.ts";

export const CURSOR_CAPABILITY_MANIFEST: DeriveCapabilityManifest = {
  connector: CURSOR_AGENT_KIND,
  capabilities: [
    {
      name: "intent",
      rung: "full",
      sentence:
        "beforeSubmitPrompt carries the prompt, so the first substantive one fires the same derived-intent worker Claude uses",
    },
    {
      name: "ghost",
      rung: "full",
      sentence:
        "the debt a recorded intent opens is paid on whichever of stop and postToolUse fires first, and the worker is the shared one",
    },
    {
      name: "summarizer",
      rung: "reduced",
      sentence:
        "the stop payload carries a transcript POINTER but Cursor documents no transcript FORMAT, so the slice is the bounded TAIL rather than the turn (no documented marker separates turns), it is decoded shape-tolerantly, and a tail that decodes to nothing is booked and named rather than guessed at",
    },
    {
      name: "conference",
      rung: "full",
      sentence:
        "`crosscheck conference` is a command a human runs, not a hook, so it needs nothing from Cursor at all — only a working model runner (see the summarizer runner check)",
    },
  ],
  refusals: [
    {
      name: "pre-edit ask",
      sentence:
        "not possible — Cursor treats ask as advisory in preToolUse and enforces only a hard deny, and crosscheck never hard-blocks",
    },
    {
      name: "prompt-time injection",
      sentence:
        "beforeSubmitPrompt is registered capture-only: its documented output is {continue, user_message}, which can block a prompt and cannot add context, so this connector answers it with no directives at all",
    },
    {
      name: "response-text capture",
      sentence:
        "afterAgentResponse is not registered — it carries agent prose with no work anchor, and the Tier-1 gate demands an executed shape beside a conclusion; accumulating a turn across Cursor's separate hook processes would need a standing content buffer on disk, which the privacy rule forbids",
    },
    {
      name: "cloud and background agents",
      sentence:
        "sessionStart and sessionEnd are documented unavailable in cloud agents, so a cloud run registers through the recovery path on its first connected file touch and its hub session ends by staleness; and a user-level install (~/.cursor/hooks.json) runs NO hooks in a cloud agent at all — Cursor loads only project and team hooks there, so a cloud agent needs `crosscheck init --cursor` in the repo",
    },
  ],
};
