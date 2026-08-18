/**
 * Connector prefixes for `hostSessionKey` (DESIGN-agent-agnostic.md §1.3).
 *
 * Every connector mints the host session key for its sessions, and two hosts
 * must never be able to mint the SAME key — a collision would merge two
 * sessions' spools, state files and cc_ ids. The rule:
 *
 *   - Claude Code: the RAW `session_id`, deliberately unprefixed. It was the
 *     only connector before the rename, and every spool slug, state filename
 *     and `cc_<uuid>` on disk derives from the raw id — a prefix here would
 *     orphan all of them. Uniqueness holds because the other prefixes are
 *     reserved: no Claude UUID starts with `acp-` or `cur-`.
 *   - ACP proxy: `acp-<agentSlug>--<acpSessionId>` — the agent's name from the
 *     `initialize` response, slugged, then `--`, then the agent's own session
 *     id. The double dash is the slug/id boundary, and it is unambiguous
 *     BECAUSE of the slug's shape: a slug joins alphanumeric runs with single
 *     dashes and never starts or ends with one, so `--` cannot appear inside
 *     it — the first `--` after the prefix always splits the key back into
 *     exactly one (slug, id) pair. Without it, ("Gemini", "cli-x") and
 *     ("Gemini CLI", "x") would both mint acp-gemini-cli-x and merge two
 *     sessions (agent-kind.test.ts pins the distinctness).
 *   - Cursor IDE: `cur-<conversation_id>`.
 *
 * The agent_kind values that ride to the hub beside these keys live here too:
 * `claude-code` (constants.ts DEFAULT_AGENT_KIND, unchanged), `acp:<name>`
 * with fallback `acp:unknown`, and `cursor-ide`. The hub's `agent_kind`
 * column is free-form by design — no server change needed.
 */

export const ACP_HOST_KEY_PREFIX = "acp-";
export const CURSOR_HOST_KEY_PREFIX = "cur-";

export const ACP_AGENT_KIND_PREFIX = "acp:";
export const ACP_AGENT_KIND_FALLBACK = "acp:unknown";
export const CURSOR_AGENT_KIND = "cursor-ide";

/** What an unidentifiable agent name slugs to — mirrors acp:unknown. */
const UNKNOWN_AGENT_SLUG = "unknown";

/** Runs of anything outside [a-z0-9], folded to one dash each. */
const NON_SLUG_RUN = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/**
 * An agent name as a key- and kind-safe slug: lowercase, alphanumeric runs
 * joined by single dashes, never empty. The design's examples are literal
 * outputs of this function: "Gemini CLI" → `gemini-cli`, "cursor-agent" →
 * `cursor-agent`. Slugging (rather than passing the name through) is a
 * DECISION the design only sketches: the name comes from the agent's own
 * `initialize` response — untrusted — and it lands inside filenames (via
 * sessionSlug) and the hub's agent_kind column, so it gets the narrowest
 * shape that stays readable.
 */
export const agentSlug = (agentName: string): string => {
  const slugged = agentName
    .toLowerCase()
    .replace(NON_SLUG_RUN, "-")
    .replace(EDGE_DASHES, "");
  return slugged.length === 0 ? UNKNOWN_AGENT_SLUG : slugged;
};

/**
 * The slug/id boundary inside an ACP key. A slug can never contain this run
 * (single dashes only, no edge dashes), so the key parses back uniquely.
 */
export const ACP_KEY_DELIMITER = "--";

/** `acp-<agentSlug>--<acpSessionId>` — e.g. `acp-gemini-cli--sess_abc123`. */
export const acpHostSessionKey = (
  agentName: string,
  acpSessionId: string,
): string =>
  `${ACP_HOST_KEY_PREFIX}${agentSlug(agentName)}${ACP_KEY_DELIMITER}${acpSessionId}`;

/** `cur-<conversation_id>` — Cursor conversation ids are already opaque. */
export const cursorHostSessionKey = (conversationId: string): string =>
  `${CURSOR_HOST_KEY_PREFIX}${conversationId}`;

/** `acp:<agentSlug>` from the initialize response; absent/empty → fallback. */
export const acpAgentKind = (agentName: string | undefined): string =>
  agentName === undefined || agentName.trim().length === 0
    ? ACP_AGENT_KIND_FALLBACK
    : `${ACP_AGENT_KIND_PREFIX}${agentSlug(agentName)}`;
