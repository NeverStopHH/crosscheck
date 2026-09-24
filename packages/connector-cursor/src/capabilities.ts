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
import { UNPROJECTED_LEDGER_KINDS_REFUSAL } from "@crosscheck/connector-core/derive/capabilities.ts";
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
    {
      name: "event_seq",
      rung: "reduced",
      sentence:
        "Cursor's handlers position every record they emit through the same allocator, but two sources are missing: Cursor runs no Stop-time `git diff` lane, so a file changed by `sed -i`, a codemod or a generator produces no file.modified here to order at all; and this connector registers no pre-tool handler, so an edit's position is taken only AFTER the tool returned and is an upper bound — the hub stores those `observed` and refuses a happens-before question against them rather than answering one from a race",
    },
  ],
  refusals: [
    // The two canonical kinds nothing projects, on any host — one sentence
    // for the whole product, shared by reference so the three manifests
    // cannot drift apart while it is true.
    UNPROJECTED_LEDGER_KINDS_REFUSAL,
    {
      name: "commit collection",
      sentence:
        "no `commit.observed` event exists on this host: the git authorship scan runs only in Claude Code's SessionStart, so absence detection here is fed by whatever teammates on that host report, and this connector's sessions contribute none of it",
    },
    {
      name: "second evidence lane",
      sentence:
        "the Stop-time `git diff --name-only HEAD` lane is registered only by Claude Code's Stop hook, so a file this host changed through `sed -i`, a codemod or a generator raises no edit event and produces no file.modified to order or to attribute — `crosscheck suspect` will name the session that used an edit tool and never this one",
    },
    {
      name: "pre-edit ask",
      sentence:
        "not possible — Cursor treats ask as advisory in preToolUse and enforces only a hard deny, and crosscheck never hard-blocks",
    },
    // 07 §8.6, PIL-8: the pilot channel this host cannot feed, printed by
    // this connector's doctor on every run rather than read as a zero.
    {
      name: "pilot tripwire channel",
      sentence:
        "never fed from this host: with no pre-edit ask there is no ask to count, so the pilot report's tripwire figure counts only sessions on hosts that can ask — a low figure on a team working here means fewer sessions that could have asked, not fewer collisions",
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
