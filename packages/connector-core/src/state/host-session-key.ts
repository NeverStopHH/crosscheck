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
/**
 * A Cursor session whose payload says `is_background_agent: true` (design
 * §3.2): registered under its own kind so presence readers can tell a
 * background run from a person's IDE session. Same `cur-` key prefix — the
 * conversation id namespace is one namespace either way.
 */
export const CURSOR_BACKGROUND_AGENT_KIND = "cursor-background";

/** What an unidentifiable agent name slugs to — mirrors acp:unknown. */
const UNKNOWN_AGENT_SLUG = "unknown";

/** Runs of anything outside [a-z0-9], folded to one dash each. */
const NON_SLUG_RUN = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/**
 * Cap on the slug: the name is agent-controlled, the slug lands inside
 * filenames, and NAME_MAX is 255 bytes — a 10-kilobyte "name" must not eat
 * the whole budget. No real agent name comes near this.
 */
export const MAX_AGENT_SLUG_CHARS = 64;

/**
 * An agent name as a key- and kind-safe slug: lowercase, alphanumeric runs
 * joined by single dashes, never empty, length-capped. The design's examples
 * are literal outputs of this function: "Gemini CLI" → `gemini-cli`,
 * "cursor-agent" → `cursor-agent`. Slugging (rather than passing the name
 * through) is a DECISION the design only sketches: the name comes from the
 * agent's own `initialize` response — untrusted — and it lands inside
 * filenames (via sessionSlug) and the hub's agent_kind column, so it gets
 * the narrowest shape that stays readable. The trailing edge-dash strip runs
 * AGAIN after the cap: a cut mid-run must not reintroduce the edge dash the
 * `--` delimiter's uniqueness argument forbids.
 */
export const agentSlug = (agentName: string): string => {
  const slugged = agentName
    .toLowerCase()
    .replace(NON_SLUG_RUN, "-")
    .replace(EDGE_DASHES, "")
    .slice(0, MAX_AGENT_SLUG_CHARS)
    .replace(EDGE_DASHES, "");
  return slugged.length === 0 ? UNKNOWN_AGENT_SLUG : slugged;
};

/**
 * The slug/id boundary inside an ACP key. A slug can never contain this run
 * (single dashes only, no edge dashes), so the key parses back uniquely.
 */
export const ACP_KEY_DELIMITER = "--";

/**
 * Bound on a shaped ACP session id. Legitimate ids (UUIDs, `sess_…` tokens)
 * sit far below it; anything past it folds to the sha256 form below rather
 * than truncating, so distinct hostile ids stay distinct keys.
 */
export const MAX_ACP_SESSION_ID_CHARS = 128;

/**
 * Bound on the id's URI-ENCODED form, which is what actually lands in a
 * filename (config/paths.ts sessionSlug): NAME_MAX is 255 bytes, and the
 * worst key spends `acp-` (4) + slug (≤ MAX_AGENT_SLUG_CHARS = 64, encoded
 * 1:1) + `--` (2) + this + extensions — 160 leaves comfortable room.
 */
const MAX_ENCODED_SESSION_ID_CHARS = 160;

/** Control (Cc), format (Cf) and separator (Z) — nothing an id may carry. */
const ID_UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Z}]/gu;

const digestSessionId = (shaped: string): string =>
  `sha256-${new Bun.CryptoHasher("sha256").update(shaped).digest("hex")}`;

/**
 * A HOST-MINTED session id is untrusted — unlike a Claude Code UUID, nothing
 * guarantees its charset, and it lands in log lines, `cc_`/`wc_` ids and
 * state filenames. This shapes one before it may enter any of those: a
 * newline could otherwise forge whole log lines during incident forensics,
 * an ESC could drive the operator's terminal, and separators would let
 * forged text read as prose. Deliberately a STRIP, not an allowlist: two
 * legitimate ids must never collapse into one key, and no host mints ids
 * that differ only in unprintables — one hostile enough to try can already
 * reuse an id outright, which both load paths treat as a resume anyway.
 *
 * An id past either bound folds to a deterministic `sha256-<hex>` — still
 * one distinct key per distinct id, still stable across load/resume replays,
 * and structurally unable to overflow a filename (ENAMETOOLONG in the
 * register flow would otherwise kill capture for the session). Null when
 * nothing printable remains: the caller treats that as no usable id (ACP
 * capture skips, the cursor runner drift-counts `conversation_id`).
 * Idempotent — shaped ids re-shape to themselves, digests included.
 *
 * SHARED across every host whose id is not a Claude-minted UUID: the ACP
 * wire parsers and the cursor runner call the one function, so an id that
 * is safe for one host's filenames is safe for the other's. The bounds are
 * named MAX_ACP_* for history; `cur-` is a character shorter than `acp-`
 * plus its slug, so the encoded-filename budget holds a fortiori.
 */
export const safeHostSessionId = (raw: string): string | null => {
  const shaped = raw.replace(ID_UNPRINTABLE, "");
  if (shaped.length === 0) {
    return null;
  }
  return shaped.length <= MAX_ACP_SESSION_ID_CHARS &&
    encodeURIComponent(shaped).length <= MAX_ENCODED_SESSION_ID_CHARS
    ? shaped
    : digestSessionId(shaped);
};

/**
 * The ACP wire parsers' name for the shared shaping — the SAME function by
 * reference (the claude-re-exports-core's-extractor discipline), kept so the
 * v1 parse sites read as what they are.
 */
export const safeAcpSessionId = safeHostSessionId;

/**
 * `acp-<agentSlug>--<acpSessionId>` — e.g. `acp-gemini-cli--sess_abc123`.
 * Callers pass ids that already went through `safeAcpSessionId` (the ACP
 * wire parsers are the single choke point).
 */
export const acpHostSessionKey = (
  agentName: string,
  acpSessionId: string,
): string =>
  `${ACP_HOST_KEY_PREFIX}${agentSlug(agentName)}${ACP_KEY_DELIMITER}${acpSessionId}`;

/**
 * `cur-<conversation_id>`. Callers pass ids that already went through
 * `safeHostSessionId` (the cursor runner's prepare step is the single choke
 * point) — a conversation id is Cursor-minted, but "the docs say opaque" is
 * not a charset guarantee, and the same id lands in the same filenames and
 * `cc_`/`wc_` ids the ACP shape rule exists for.
 */
export const cursorHostSessionKey = (conversationId: string): string =>
  `${CURSOR_HOST_KEY_PREFIX}${conversationId}`;

/** `acp:<agentSlug>` from the initialize response; absent/empty → fallback. */
export const acpAgentKind = (agentName: string | undefined): string =>
  agentName === undefined || agentName.trim().length === 0
    ? ACP_AGENT_KIND_FALLBACK
    : `${ACP_AGENT_KIND_PREFIX}${agentSlug(agentName)}`;
