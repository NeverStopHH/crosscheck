/**
 * WHAT CROSSCHECK CAN INFER BEHIND THE ACP PROXY — declared as data so
 * `doctor` prints it, and so a rung this connector ships without declaring is
 * a red build (connector-core/test/derive-capability-registry.test.ts).
 *
 * Every sentence below is about THE WIRE, not about crosscheck's plans,
 * because the reader is someone whose agent is quiet and who needs to know
 * whether that is a protocol limit or a broken install. And the wire is the
 * honest place to point: unlike a hooks API, ACP's shape is a published
 * protocol, so "the prompt arrives as text ContentBlocks on session/prompt" is
 * checkable by anyone with a recorded transcript.
 *
 * THE ONE THING THAT MAKES THIS HOST DIFFERENT FROM ITS TWO SIBLINGS, and the
 * reason its refusals are worth reading: the proxy is BYTE-TRANSPARENT, and
 * every capability here rides the parse COPY. Nothing below can reorder,
 * delay or alter a forwarded byte, and nothing below needs `--inject`. Where
 * a rung would have required touching the forward path, it is refused
 * outright rather than built — transparency.test.ts is the authority, and a
 * parity feature that cost byte transparency would not be parity, it would be
 * a different product.
 */
import type { DeriveCapabilityManifest } from "@crosscheck/connector-core/derive/capabilities.ts";
import { ACP_AGENT_KIND_PREFIX } from "@crosscheck/connector-core/state/host-session-key.ts";

/**
 * The doctor line's suffix. Not a concrete `acp:<agent>` because ONE manifest
 * describes every agent this proxy can wrap — the rungs are properties of the
 * protocol, and the agent's name only decides how much of the wire it fills
 * (which is what `acp-report` measures per agent, and what makes the
 * summarizer rung REDUCED rather than full).
 */
export const ACP_MANIFEST_CONNECTOR = `${ACP_AGENT_KIND_PREFIX}*`;

export const ACP_CAPABILITY_MANIFEST: DeriveCapabilityManifest = {
  connector: ACP_MANIFEST_CONNECTOR,
  capabilities: [
    {
      name: "intent",
      rung: "full",
      sentence:
        "session/prompt carries the developer's prompt as text ContentBlocks, so the first substantive one fires the same derived-intent worker Claude uses, off the parse copy and with --no-inject",
    },
    {
      name: "ghost",
      rung: "full",
      sentence:
        "ACP guarantees a next-prompt event, so a debt a recorded intent opens is paid on the next session/prompt exactly where Claude pays it, by the shared worker",
    },
    {
      name: "summarizer",
      rung: "reduced",
      sentence:
        "the turn slice is only what the wire happens to carry — agent message chunks, a failed tool call's rawOutput, and terminal output tails — so an agent doing its work outside ACP's terminal/* methods yields a prose-only slice and weaker conclusions; run `crosscheck acp-report` on a recorded transcript to see which sources YOUR agent actually emits",
    },
    {
      name: "conference",
      rung: "full",
      sentence:
        "`crosscheck conference` is a command a human runs, not a wire event, so it needs nothing from the proxy or the agent at all — only a working model runner (see the summarizer runner check)",
    },
  ],
  refusals: [
    {
      name: "forward-path capture",
      sentence:
        "nothing here reads the wire by parsing and re-emitting it: every rung rides a bounded copy of each line, the proxy stays byte-transparent, and the only two writes to the wire remain the MCP server entry at session setup and the appended prompt block",
    },
    {
      name: "pre-edit ask",
      sentence:
        "permission requests originate agent-side on session/request_permission, so intercepting one would mean answering on the agent's behalf ON the forward path — the proxy forwards permission traffic untouched, never answers it, and never blocks a tool call",
    },
    {
      name: "agent reasoning capture",
      sentence:
        "agent_thought_chunk is deliberately not slice material: reasoning text is the model talking to itself, it is the most sensitive prose on this wire, and the Tier-1 gate wants what the agent SAID beside what actually RAN",
    },
    {
      name: "command and content capture",
      sentence:
        "terminal command text, diff bodies and fs write content are modelled by no schema in this connector, so they cannot reach a slice even by accident — which is also why the gate's commit-boundary anchor can only match when an agent says so in prose",
    },
  ],
};
