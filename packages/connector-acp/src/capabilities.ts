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
import { UNPROJECTED_LEDGER_KINDS_REFUSAL } from "@crosscheck/connector-core/derive/capabilities.ts";
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
    {
      name: "event_seq",
      rung: "reduced",
      sentence:
        "the proxy positions everything it can see off the parse copy, and three sources are missing: no ACP host runs the Stop-time git lane, so a codemod's edits produce no file.modified to order; intent and claim events need the crosscheck MCP server, which reaches an ACP session only in --inject mode and only when the client already sent an mcpServers array; and the engine positions an edit only from the tool_call UPDATE that reports it, never from the pending row that announces it, so an edit's position is an upper bound — the hub stores those `observed` and refuses a happens-before question against them rather than answering one from a race",
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
        "no `commit.observed` event exists on this host: the git authorship scan runs only in Claude Code's SessionStart, and a proxy that shelled out to git per session would be doing work the forward path never asked for",
    },
    {
      name: "MCP-borne events",
      sentence:
        "claim.created via publish_claim and claim.invalidated need the crosscheck MCP server, which this proxy appends to session/new|load|resume only in --inject mode and only when the client already sent an mcpServers ARRAY — so a --no-inject proxy, and an --inject one whose client sent no array, emit neither kind; the proxy's own log for that run (`~/.crosscheck/logs/acp-<pid>.log`) carries an `inject skip why=<reason>` line naming which of the documented reasons applied, and `doctor` does NOT: it reads the log directory for file NAMES only and never a byte of their content",
    },
    {
      name: "second evidence lane",
      sentence:
        "the Stop-time `git diff --name-only HEAD` lane is registered only by Claude Code's Stop hook, so a file this host changed through `sed -i`, a codemod or a generator raises no edit event and produces no file.modified to order or to attribute — `crosscheck suspect` will name the session that used an edit tool and never this one",
    },
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
