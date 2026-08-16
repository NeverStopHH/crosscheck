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
  readonly ageMs: number;
}

/**
 * Renderer-owned phrases per event kind. Unknown kinds render the generic
 * phrase — consumers must ignore unknown kinds, never crash on them
 * (DESIGN.md §5 wire discipline).
 */
const EVENT_PHRASES: Readonly<Record<string, string>> = {
  [EVENT_KINDS.DEVELOPER_CREATED]: "joined the hub",
  [EVENT_KINDS.SESSION_STARTED]: "started a session",
  [EVENT_KINDS.SESSION_ENDED]: "ended a session",
  [EVENT_KINDS.WORK_CONTEXT_CREATED]: "opened work context",
  [EVENT_KINDS.WORK_CONTEXT_UPDATED]: "updated work context",
  [EVENT_KINDS.CLAIM_ADDED]: "added a claim in",
  [EVENT_KINDS.CLAIM_EDGE_ADDED]: "linked two claims",
};

const UNKNOWN_KIND_PHRASE = "recorded activity";

const UNNAMED_ACTOR = "A teammate";

const FeedLine: FC<{ readonly entry: FeedEntry }> = ({ entry }) => (
  <li class="entry">
    <strong>{entry.actorName ?? UNNAMED_ACTOR}</strong>{" "}
    {EVENT_PHRASES[entry.kind] ?? UNKNOWN_KIND_PHRASE}
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

interface FeedPageProps {
  readonly viewer: ViewerChrome;
  readonly entries: readonly FeedEntry[];
}

export const FeedPage: FC<FeedPageProps> = ({ viewer, entries }) => (
  <Layout title="Feed" viewer={viewer} refreshSeconds={UI_FEED_REFRESH_SECONDS}>
    <h1>Recent activity</h1>
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
