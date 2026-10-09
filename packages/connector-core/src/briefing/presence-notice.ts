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
 *
 * TOLD FOR THE WHOLE WINDOW, AND WITH THE STATE NOW (review of the hub
 * hardening, M1). An agent can switch presence on, let the team watch, and
 * switch it off again, so a later opt-out does not end the notice. The line
 * says whether presence is still on, from the `presenceOptOut` read beside it.
 */

/**
 * PRESENCE ON, WAITING (human provenance §8). Switching presence back on by
 * key is a draft: presence stays hidden until the person confirms it with
 * their passkey. Status and doctor say so; the briefing says it as a fact.
 */
export const PRESENCE_ON_WAITING_LINE =
  "a request to show your presence again is waiting for your passkey — it changes nothing until you confirm it (crosscheck confirm opens the page)";

/** For the briefing: a statement of fact, no imperative (DESIGN.md §4). */
export const PRESENCE_ON_WAITING_BRIEFING_LINE =
  "A request to show your presence again is waiting for your passkey; until it is confirmed, your presence stays hidden.";

/** The instant as this client writes it, or null when the hub's value is no instant. */
const instantOf = (iso: string): string | null => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** For the person's own terminal (status, doctor). */
export const presenceReenabledLine = (iso: string, isOptedOutNow: boolean): string | null => {
  const instant = instantOf(iso);
  if (instant === null) {
    return null;
  }
  return isOptedOutNow
    ? `presence was turned back on at ${instant} via an API key, and is off again now; ` +
        "if neither was you, something holding your API key did it (`crosscheck key rotate` replaces the key)"
    : `presence was turned back on at ${instant} via an API key, and is still on; ` +
        "run `crosscheck presence off` if that wasn't you";
};

/**
 * For the briefing: a statement of fact, no imperative. Injected context that
 * gives orders trips the host's prompt-injection defences (DESIGN.md §4).
 */
export const presenceReenabledBriefingLine = (iso: string, isOptedOutNow: boolean): string | null => {
  const instant = instantOf(iso);
  if (instant === null) {
    return null;
  }
  return isOptedOutNow
    ? `Your presence opt-out was switched off at ${instant} through an API key, which any agent holding the key can do, and is on again now: teammates could see your live presence in between.`
    : `Your presence opt-out was switched off at ${instant} through an API key, which any agent holding the key can do; \`crosscheck presence off\` restores it.`;
};
