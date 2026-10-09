/** @jsxImportSource hono/jsx */
/**
 * /ui/feed — recent hub activity for humans (task item 3).
 *
 * DATA SOURCE: the same opt-out-filtered events reader the API serves
 * (services/events.ts listRecentEvents) — the presence filter arrives with
 * the query, never re-implemented here. Payloads carry only ids and
 * metadata (outbox discipline), so the page renders labels + links, never
 * claim bodies.
 *
 * MUTE (task item 7, decided): the reader's mute list does NOT apply to
 * this page. The web UI is a deliberate pull surface — the reader navigated
 * here — and visibility.ts already rules that "the raw events feed is a
 * subscription, not an injection, so it is not muted". The web feed renders
 * exactly that subscription; muting here would make the page disagree with
 * the API it renders. The footer note below states this on the page.
 *
 * LIVE-ISH UPDATES: meta refresh (UI_FEED_REFRESH_SECONDS), not SSE — SSE
 * needs script and this surface ships zero JS; one bounded request per
 * viewer per minute cannot become a polling storm.
 */
import type { FC } from "hono/jsx";

import { EVENT_KINDS } from "../../constants.ts";
import {
  UI_FEED_REFRESH_SECONDS,
  UI_MAX_LABEL_CHARS,
} from "../constants.ts";
import { capped, formatUiAge, workContextHref } from "../format.ts";
import { Layout } from "../layout.tsx";
import type { ViewerChrome } from "../layout.tsx";

/** One feed row, boundary-validated by the route from an outbox payload. */
export interface FeedEntry {
  readonly id: number;
  readonly kind: string;
  readonly actorName: string | null;
  readonly workContextId: string | null;
  readonly repo: string | null;
  readonly branch: string | null;
  readonly kindLabel: string | null;
  readonly statusLabel: string | null;
  /** "derived" on a claim nobody vouched for (a draft or a discard's copy). */
  readonly provenanceLabel: string | null;
  /** Who acted, when the event says (`developer_key_rotated`: self | admin). */
  readonly by: string | null;
  readonly ageMs: number;
}

/**
 * Renderer-owned phrases per event kind. Unknown kinds render the generic
 * phrase — consumers must ignore unknown kinds, never crash on them
 * (DESIGN.md §5 wire discipline).
 */
const EVENT_PHRASES: Readonly<Record<string, string>> = {
  [EVENT_KINDS.DEVELOPER_CREATED]: "joined the hub",
  [EVENT_KINDS.DEVELOPER_KEY_ROTATED]: "rotated their API key",
  [EVENT_KINDS.PRESENCE_REENABLED]: "had their presence opt-out switched off through an API key",
  [EVENT_KINDS.SESSION_STARTED]: "started a session",
  [EVENT_KINDS.SESSION_ENDED]: "ended a session",
  [EVENT_KINDS.WORK_CONTEXT_CREATED]: "opened work context",
  [EVENT_KINDS.WORK_CONTEXT_UPDATED]: "updated work context",
  [EVENT_KINDS.CLAIM_ADDED]: "added a claim in",
  [EVENT_KINDS.CLAIM_EDGE_ADDED]: "linked two claims",
};

const UNKNOWN_KIND_PHRASE = "recorded activity";

const UNNAMED_ACTOR = "A teammate";

/**
 * An admin rotating someone's key is not the owner rotating it, and the feed
 * is the audit trail a teammate reads after a leak — so it says which.
 */
const ADMIN_KEY_ROTATION_PHRASE = "had their API key rotated by an admin";

const phraseFor = (entry: FeedEntry): string =>
  entry.kind === EVENT_KINDS.DEVELOPER_KEY_ROTATED && entry.by === "admin"
    ? ADMIN_KEY_ROTATION_PHRASE
    : (EVENT_PHRASES[entry.kind] ?? UNKNOWN_KIND_PHRASE);

const FeedLine: FC<{ readonly entry: FeedEntry }> = ({ entry }) => (
  <li class="entry">
    <strong>{entry.actorName ?? UNNAMED_ACTOR}</strong>{" "}
    {phraseFor(entry)}
    {entry.workContextId === null ? null : (
      <>
        {" "}
        <a href={workContextHref(entry.workContextId)}>
          {capped(entry.workContextId, UI_MAX_LABEL_CHARS)}
        </a>
      </>
    )}
    {entry.kindLabel === null ? null : (
      <>
        {" "}
        <span class="label">{capped(entry.kindLabel, UI_MAX_LABEL_CHARS)}</span>
      </>
    )}
    {entry.statusLabel === null ? null : (
      <>
        {" "}
        <span class="label">
          {capped(entry.statusLabel, UI_MAX_LABEL_CHARS)}
        </span>
      </>
    )}
    {entry.provenanceLabel === null ? null : (
      <>
        {" "}
        <span class="label">{entry.provenanceLabel}</span>
      </>
    )}
    {entry.repo === null ? null : (
      <>
        {" "}
        <span class="meta">
          {capped(entry.repo, UI_MAX_LABEL_CHARS)}
          {entry.branch === null
            ? ""
            : ` · ${capped(entry.branch, UI_MAX_LABEL_CHARS)}`}
        </span>
      </>
    )}{" "}
    <span class="meta">{formatUiAge(entry.ageMs)}</span>
  </li>
);

/**
 * The viewer's own presence re-enable, if any (review of the hub hardening,
 * L7): the one place the notice reaches the person outside the surfaces an
 * agent sits on, since the briefing goes into the agent's context and status
 * and doctor run in a terminal it can drive.
 */
export interface PresenceReenableBanner {
  readonly at: string;
  readonly isOptedOutNow: boolean;
}

const PresenceReenabledNotice: FC<{ readonly banner: PresenceReenableBanner }> = ({ banner }) => (
  <div class="card" role="alert">
    <p>
      Your presence opt-out was switched off at {banner.at} through an API key, which any agent holding
      your key can do.{" "}
      {banner.isOptedOutNow
        ? "It is on again now, but teammates could see your live presence in between."
        : "Teammates can see your live presence now."}{" "}
      If that was not you, run <code>crosscheck presence off</code> and replace the key with{" "}
      <code>crosscheck key rotate</code>.
    </p>
  </div>
);

/** The viewer's own drafts that wait for their passkey (review M7, spec §8). */
export interface WaitingDrafts {
  readonly total: number;
  /** A request to show their presence again is among them. */
  readonly presenceOn: boolean;
}

const WaitingDraftsNotice: FC<{ readonly waiting: WaitingDrafts }> = ({ waiting }) => (
  <div class="card" role="status">
    <p>
      {String(waiting.total)} of your drafts {waiting.total === 1 ? "waits" : "wait"} for your passkey: nothing in{" "}
      {waiting.total === 1 ? "it" : "them"} counts or changes anything until you{" "}
      <a href="/ui/confirm">confirm or discard {waiting.total === 1 ? "it" : "them"}</a>.
    </p>
    {waiting.presenceOn ? <p>Among them, a request to show your presence again is waiting for your passkey.</p> : null}
  </div>
);

interface FeedPageProps {
  readonly viewer: ViewerChrome;
  readonly entries: readonly FeedEntry[];
  readonly presenceReenable: PresenceReenableBanner | null;
  readonly waiting: WaitingDrafts;
}

export const FeedPage: FC<FeedPageProps> = ({ viewer, entries, presenceReenable, waiting }) => (
  <Layout title="Feed" viewer={viewer} refreshSeconds={UI_FEED_REFRESH_SECONDS}>
    <h1>Recent activity</h1>
    {waiting.total === 0 ? null : <WaitingDraftsNotice waiting={waiting} />}
    {presenceReenable === null ? null : <PresenceReenabledNotice banner={presenceReenable} />}
    {entries.length === 0 ? (
      <p class="notice">Nothing yet — activity appears as sessions report.</p>
    ) : (
      <ul class="plain">
        {entries.map((entry) => (
          <FeedLine entry={entry} />
        ))}
      </ul>
    )}
    <p class="notice">
      This feed shows all hub activity you are allowed to see. Presence
      opt-outs are enforced here; your mute list is not — mutes cover
      agent-injected hints, not pages you open yourself.
    </p>
  </Layout>
);
