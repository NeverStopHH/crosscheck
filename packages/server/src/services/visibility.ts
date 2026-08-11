/**
 * The two per-developer privacy conditions (DESIGN.md §2.1 "per-developer
 * presence opt-out and mute", §10 risk 3) — enforced HUB-side, inside each
 * bounded query's WHERE, never by connector-side filtering: a hostile or
 * modified connector must not be able to see what these hide, and a filter
 * applied after a LIMIT would let hidden rows crowd includable ones out of
 * the bound.
 *
 * PRESENCE OPT-OUT (self-set, hides me from everyone else) covers exactly
 * the LIVE-presence surfaces:
 *
 *   1. GET /api/presence          — briefing "active teammates", statusline,
 *                                   `crosscheck status` teammate lines
 *   2. GET /api/hints/tripwire    — the PreToolUse "working on the same
 *                                   file" ask about my active sessions
 *   3. GET /api/absences          — "inactive" findings about me (absence
 *                                   reporting IS presence surveillance: it
 *                                   reports when I last ran an agent)
 *   4. GET /api/events(+/stream)  — EVERY row attributed to me via payload
 *                                   developerId, knowledge kinds included:
 *                                   each row carries a server timestamp, so
 *                                   the feed is a live activity timeline
 *                                   (work_context_created fires when I
 *                                   START a piece of work) and a kind-scoped
 *                                   filter would leave the raw feed a
 *                                   modified connector reads as a presence
 *                                   bypass
 *
 * The subject's OWN reads are unaffected on every surface — the control is
 * over what OTHERS see. Deliberately NOT covered, because opt-out hides live
 * presence and does not retract published knowledge (append-only knowledge
 * is the product; the control is over the surveillance surface, not over
 * authorship): work contexts, claims, edges, search results, diagnosis
 * trees, solved matches, contradictions, referee briefs — all stay visible
 * and attributed on every PULL surface. Hiding an event ROW about a claim
 * hides its timing from the feed, never the claim itself. Also not coverable: an "unconnected" absence line for a
 * git author email the hub cannot match to any account — the hub cannot
 * know it is the opted-out developer. Opt-out is a live switch, not
 * retroactive redaction: opting back in restores surfaces, including
 * lifecycle events appended while hidden.
 *
 * MUTE (reader-set, hides developer X from MY unasked surfaces) covers
 * exactly the surfaces the connector injects or displays UNASKED:
 *
 *   1. GET /api/hints/candidates  — prompt hints (and therefore, structurally,
 *                                   hint_deliveries telemetry: a suppressed
 *                                   candidate is never delivered, so the
 *                                   connector never records it)
 *   2. GET /api/hints/tripwire    — PreToolUse asks about X's sessions
 *   3. GET /api/presence          — X's presence lines in my briefing,
 *                                   statusline, and `crosscheck status`
 *   4. GET /api/work-contexts     — my briefing's related-work pointers
 *   5. GET /api/solved-matches    — my briefing's solved-tree pointers
 *   6. GET /api/contradictions    — my briefing's deadlock pointers (a pair
 *                                   is dropped when EITHER side is muted —
 *                                   the pointer names both authors)
 *   7. GET /api/absences          — my briefing's absence lines about X
 *
 * Mute is a reader preference, not a boundary: the deliberate pull paths —
 * GET /api/search (search_related_work), GET /api/work-contexts/:id/diagnosis
 * (get_diagnosis), GET /api/contradictions/:id/brief (get_referee_brief) —
 * stay unfiltered, and the raw events feed is a subscription, not an
 * injection, so it is not muted either.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** A developer-id-valued expression: a (possibly aliased) column or SQL. */
type SubjectDeveloperId = AnyPgColumn | SQL;

/**
 * True for rows whose subject developer has NOT opted out of presence — or
 * is the viewer, whose own view of themself is always unaffected. Raw table
 * name in the subquery because the outer query may already join `developers`
 * under an alias (same technique as repoTouchCondition in contradictions.ts).
 */
export const visiblePresenceCondition = (
  viewerDeveloperId: string,
  subjectDeveloperId: SubjectDeveloperId,
): SQL =>
  sql`(${subjectDeveloperId} = ${viewerDeveloperId} OR NOT EXISTS (
    SELECT 1 FROM developers privacy_subject
    WHERE privacy_subject.id = ${subjectDeveloperId}
      AND privacy_subject.presence_opt_out
  ))`;

/** True for rows whose subject developer is not muted by this reader. */
export const notMutedCondition = (
  readerDeveloperId: string,
  subjectDeveloperId: SubjectDeveloperId,
): SQL =>
  sql`NOT EXISTS (
    SELECT 1 FROM developer_mutes reader_mutes
    WHERE reader_mutes.reader_developer_id = ${readerDeveloperId}
      AND reader_mutes.muted_developer_id = ${subjectDeveloperId}
  )`;
