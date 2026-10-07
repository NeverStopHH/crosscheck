/**
 * "YOUR PRESENCE OPT-OUT WAS SWITCHED BACK OFF" (hub hardening, item 6).
 *
 * The hub takes the opt-out from any holder of the API key, the person's
 * agents included, and cannot tell them apart yet. So switching it back off,
 * the less private direction, is told to the person wherever they look: the
 * SessionStart briefing, `crosscheck status` and `crosscheck doctor`. The
 * hub sends only the instant (`presenceReenabledAt` on GET /api/settings);
 * every word here is the client's own, and the instant is re-serialised, so
 * no hub-chosen text rides into the line.
 */

/** The instant as this client writes it, or null when the hub's value is no instant. */
const instantOf = (iso: string): string | null => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** For the person's own terminal (status, doctor). */
export const presenceReenabledLine = (iso: string): string | null => {
  const instant = instantOf(iso);
  return instant === null
    ? null
    : `presence was turned back on at ${instant} via an API key; run \`crosscheck presence off\` if that wasn't you`;
};

/**
 * For the briefing: a statement of fact, no imperative. Injected context that
 * gives orders trips the host's prompt-injection defences (DESIGN.md §4).
 */
export const presenceReenabledBriefingLine = (iso: string): string | null => {
  const instant = instantOf(iso);
  return instant === null
    ? null
    : `Your presence opt-out was switched off at ${instant} through an API key, which any agent holding the key can do; \`crosscheck presence off\` restores it.`;
};
