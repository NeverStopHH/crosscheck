/**
 * The two per-developer privacy conditions (DESIGN.md §2.1 "per-developer
 * presence opt-out and mute", §10 risk 3) — enforced HUB-side, inside each
 * bounded query's WHERE, never by connector-side filtering: a hostile or
 * modified connector must not be able to see what these hide, and a filter
 * applied after a LIMIT would let hidden rows crowd includable ones out of
 * the bound.
 *
 * PRESENCE OPT-OUT (self-set, hides me from everyone else). THE POLICY, in
 * the words DESIGN.md uses (review round 4, narrowed on purpose):
 *
 *   Opt-out withholds your live location (branch, commits, session start,
 *   heartbeat and update instants, fallback titles) from every structured
 *   field every hub route serves, and from presence. It does not hide the
 *   time that your shared work itself carries: when a claim or work context
 *   was created, honest coverage that some session went silent, team-level
 *   pilot counts, event sequence gaps, and words you write yourself. A
 *   determined teammate can infer roughly when you work from the work you
 *   share.
 *
 * WHAT IT DOES NOT HIDE — the residuals, each tagged so the executable
 * boundary (test/live-location-differential.test.ts RESIDUALS) can point at
 * the sentence that accepts a difference one action of hers makes:
 *
 *   «creation»  when a claim, work context, edge or question was created,
 *               and a solved tree's solvedAt (its newest claim's
 *               creation): the shared row's own time. NOT a pin's: a pin
 *               is created by its first verification, and her
 *               verification's time and HEAD are withheld (below), so a
 *               pin of hers carries no instant of hers at all. The docs
 *               once listed it here; the code withholds it, which is the
 *               harmless direction (review round 5, L2). Nor a DERIVED
 *               claim's to the second: her connector stamps a draft when it
 *               derives it from her session's work, so its creation is
 *               shown to the day (batch-2 integration review, L8)
 *   «coverage»  honest coverage that SOME session went quiet or reported:
 *               the agent_event rung's state, its reason and whether its
 *               gap is withheld (`session_silent` with `withheld: true`) —
 *               never whose session, never when: its start is withheld for
 *               as long as she has a session on the repo, so nothing she
 *               does moves it (services/coverage.ts). The coverage record's
 *               order block reads the same window (no session in it, or the
 *               weakest declaration of those in it), so whether SOME session
 *               reported inside the window moves it too
 *   «pilot»     team-level pilot counts: sessions, deliveries and pulls,
 *               the integrity counters, which prior work was opened
 *   «sequence»  event sequence gaps (the feed's ids, below)
 *   «landed»    that her work landed, TO THE DAY, and what follows from
 *               it: the conference leaves landed work out, the page says
 *               landed
 *   «evidence»  what her SessionStart's commit evidence found: it counts
 *               for every reader like anyone's — the git rung's state and
 *               the absence findings — because evidence withheld from the
 *               count would make coverage look better (review round 5, C1).
 *               WHEN she collected it is withheld: an absence finding's
 *               evidenceCollectedAt reads LOCATION_WITHHELD, and the rung
 *               prints the newest instant a viewer may be told
 *   «content»   what her shared work says — a claim, a target's path, an
 *   «words»     intent, a pin's surface, a status, a revalidation's
 *               finding — the words she writes herself, and the counts and
 *               rankings that follow from them
 *   «security»  that a security event about her credentials happened, and
 *               when: a key rotation (constants.ts SECURITY_EVENT_KINDS)
 *               stays in every member's feed after she opts out. The opt-out
 *               is a switch anybody holding her API key can flip, her agents
 *               included, so it must not hide what that key did. The row
 *               names her id and who acted (`self` or `admin`), never a
 *               branch, HEAD or heartbeat. A self-rotation's instant is an
 *               instant she, or something holding her key, was active.
 *               And a PASSKEY ENROLMENT of hers (batch-2 integration review,
 *               L9): GET /api/passkeys/announcements and the /ui/passkeys
 *               page list every member's recent enrolments — name, label,
 *               authenticator, when it was created and becomes usable,
 *               whether it was revoked — because the announcement IS the
 *               control against a planted passkey (1.0 spec 04a §4.3), and
 *               the admin's per-developer list is how one is revoked.
 *               Team-wide by design, never the caller's own
 *
 * Every one of them holds at a colleague's POLL interval: a colleague who
 * reads again and again sees when a residual changed — when a claim
 * appeared, when coverage went incomplete, when her work left the
 * conference. That is what "roughly" means above.
 *
 * It is enforced at two grains. Whole ROWS go on the LIVE-presence surfaces,
 * where the row itself is the statement "this person is here now":
 *
 *   1. GET /api/presence          — briefing "active teammates", statusline,
 *                                   `crosscheck status` teammate lines
 *   2. GET /api/hints/tripwire    — the PreToolUse "working on the same
 *                                   file" ask about my active sessions
 *   3. GET /api/absences          — "inactive" findings about me (absence
 *                                   reporting IS presence surveillance: it
 *                                   reports when I last ran an agent)
 *   4. GET /api/events(+/stream)  — EVERY row attributed to me via payload
 *                                   developerId but the security events
 *                                   («security» above), knowledge kinds
 *                                   included:
 *                                   each row carries a server timestamp, so
 *                                   the feed is a live activity timeline
 *                                   (work_context_created fires when I
 *                                   START a piece of work) and a kind-scoped
 *                                   filter would leave the raw feed a
 *                                   modified connector reads as a presence
 *                                   bypass
 *   5. GET /api/ghost-checks      — the "teammates working where you are"
 *                                   block in my briefing and in set_intent's
 *                                   answer (VISION.md §3). A ghost line
 *                                   asserts that a NAMED teammate is working
 *                                   in these files NOW, which is presence-
 *                                   class exactly as the tripwire is, and it
 *                                   carries their last-active age out loud
 *   6. GET /api/sessions?open=1   — the open-session listing without mine=1.
 *                                   A row with its branch and heartbeat gone
 *                                   says only THAT the session exists, which
 *                                   is presence, so the row goes
 *
 * Location FIELDS go everywhere else, per viewer, and the row stays — the
 * work, the claims and the collision are the product. ONE projection does
 * it (services/live-location.ts `projectRow`), WITHHOLDING BY DEFAULT: every
 * value that IS an instant goes, at any depth — and a bare sha or epoch in a
 * field typed as an instant or a commit — unless the row's kind lists it as
 * the time the shared work itself carries (a claim's, context's, edge's or
 * question's createdAt). Her words are never judged by their shape: a body,
 * description, summary, reason, note, surface or check that opens with a
 * timestamp or IS a sha is published as written (review round 5, H1). Every serializer of these rows
 * hands its rows to it, each nested row by its own owner:
 *
 *   - branch                      — the GET /api/work-contexts listing, in
 *                                   its SQL by this file's
 *                                   visiblePresenceCondition (the field is
 *                                   omitted); GET /api/suspect, as
 *                                   LOCATION_WITHHELD
 *   - fallback title              — `<branch> @ <repo>` IS the branch, so it
 *                                   reads as WITHHELD_TITLE on the work-
 *                                   context listing and diagnosis, search,
 *                                   hint candidates, referee briefs, the
 *                                   conference (its contexts AND its open
 *                                   questions), the questions inbox (the
 *                                   briefing's and answerable=1), the
 *                                   landed-change stop (POST /api/landed/
 *                                   context), the pilot's label walk (GET
 *                                   /api/pilot-marks/unlabeled) and report
 *                                   (prior work), suspect and the /ui
 *                                   pages. A question's or a delivery's
 *                                   title is judged by its CONTEXT's owner,
 *                                   never by who asked or who received it.
 *                                   WHICH titles: the connector says how it
 *                                   wrote one (`titleSource`: fallback,
 *                                   host, person) and only `fallback` goes;
 *                                   an unmarked row (an older connector's)
 *                                   goes when it is a branch any of her
 *                                   sessions reported (developer_branches),
 *                                   `<branch> @ <label>`, or opens with
 *                                   `detached@<hex>` (@crosscheck/schema
 *                                   isLocationTitle). A title a person or
 *                                   host wrote stays, ` @ api` ending or not
 *   - base commit                 — omitted from the work-context listing
 *                                   and every diagnosis; "" (unknown) on
 *                                   hint candidates
 *   - a claim's observedAtCommit  — null on diagnosis, hint candidates,
 *                                   referee briefs and solved matches: a
 *                                   claim bound to `session_base` names the
 *                                   author's HEAD. The claim, its state and
 *                                   its binding stay; the reader just cannot
 *                                   revalidate it against their own clone
 *   - last-active time            — GET /api/suspect and GET /api/conference,
 *                                   as LOCATION_WITHHELD
 *   - session start               — the landed stop's workStartedAt, as
 *                                   LOCATION_WITHHELD (every shipped reader
 *                                   drops a value it cannot parse)
 *   - last update                 — `updatedAt` on every work-context row
 *                                   (listing, by-id, diagnosis, search, hint
 *                                   candidates, the /ui pages), as null
 *   - her activity on shared rows — a claim she re-observed reads as seen
 *                                   once (`lastSeenAt` null, `dedupCount`
 *                                   1); a matched target's and an evidence
 *                                   rung's time, null; her pin's HEAD and
 *                                   verification, break and rename times,
 *                                   LOCATION_WITHHELD, and her verification
 *                                   does not age the registry's
 *                                   oldestVerifiedAt; her work's `landedAt`,
 *                                   to the day (review round 4, H3 and M3)
 *   - her revalidation readings   — a reading is its REPORTER's, on anyone's
 *                                   claim: what it found (state, basis, the
 *                                   default-branch commits that touched the
 *                                   files) stays, its ref goes (null) and
 *                                   its instant reads LOCATION_WITHHELD
 *                                   (services/claim-validity.ts)
 *   - activity as a FILTER or an  — every read that windows or ranks by
 *     ORDER                         activity counts a hidden owner's work
 *                                   from creation alone (activitySeenBy):
 *                                   the listing's since= and order, search's
 *                                   since= and recency, the conference's
 *                                   fortnight and order, suspect's window,
 *                                   the solved pointers' live side. A row
 *                                   admitted or put first BECAUSE she just
 *                                   touched it says what the withheld
 *                                   updatedAt no longer does
 *
 * Pinned route by route in test/live-location-privacy.test.ts, which walks
 * EVERY route the app registers — GET and POST, each with its own variants
 * from test/live-location-routes.ts — as a colleague of an opted-out
 * developer, and fails on any spelling of her location anywhere in an
 * answer, body or header: branch, HEAD and HEAD prefixes, and every instant
 * of hers in any spelling within a minute (ISO, Postgres text, minute
 * precision, epoch, an age). A route the table does not name fails it, and
 * so does a parameter a handler reads that no variant sends; the same walk
 * as her checks, route by route, that her own view is never withheld. And
 * test/live-location-differential.test.ts walks two worlds that differ by
 * ONE action of hers, failing on any difference not tagged above.
 *
 * WRITES THAT WOULD READ IT BACK. `landedAt` is stamped when a reported
 * commit is a session's base commit, and every colleague sees the stamp — so
 * a colleague who could report a guessed sha about her sessions would read
 * her HEAD back one guess at a time. Landed evidence about a hidden owner's
 * sessions is therefore accepted from that owner only (services/landed.ts).
 * The cost, stated: teammates' SessionStart no longer marks her work
 * landed; only her own sessions do, so it reads unlanded longer than it is.
 *
 * ACCEPTED: A HIDDEN AUTHOR'S CLAIMS REVALIDATE LESS. With observedAtCommit
 * withheld, a colleague cannot re-check her claim against their own clone,
 * so her claims collect fewer revalidations and stay `unknown` or `stale`
 * longer. The touching commits a validity keeps — default-branch commits
 * that touched the claim's files since — still bound roughly where her base
 * sat. Both are accepted because both only WEAKEN: a claim nobody could
 * re-check is never promoted, and the default branch is published history,
 * not her live branch.
 *
 * ACCEPTED: FREE TEXT IS NOT SCANNED FOR LOCATION. The projection withholds
 * FIELDS. A branch name or a sha a person, a host or an agent wrote INTO
 * text — a host's session title, a context's description, a claim or a
 * draft body — is published as written, and so is a copy the hub made
 * before the opt-out (an event row, a draft composed from her claims). The
 * search index is not such a copy any more: a location title is kept out of
 * it while its owner is opted out, and her docs are rebuilt when she
 * toggles (services/live-location.ts isTitleWithheldFromIndex, review round
 * 4, H4). Recognising location inside prose would mean
 * guessing at every word that looks like a ref, and it would redact real
 * knowledge on every false positive; the author controls what they write.
 *
 * «sequence» ACCEPTED, AND NOT BUILT AROUND: the events feed's ids are ONE sequence
 * every developer's rows share, and a hidden developer's rows are left out
 * of a colleague's feed (surface 4 above) — so the ids a colleague does
 * see have gaps where hers were. Sequence gaps reveal that some hidden
 * activity happened around then, never what or where. Closing them would
 * take per-viewer cursors, a second id space for every feed consumer to
 * resume by; that is not worth the residual.
 *
 * ACCEPTED: the withholding is itself visible. A colleague who sees a
 * teammate's work but never their presence line, or reads LOCATION_WITHHELD
 * and WITHHELD_TITLE, can tell that teammate opted out. That is the price of
 * keeping the row, and it reveals the CHOICE, never the location; hiding the
 * choice too would mean hiding the work, which the policy keeps shared.
 *
 * The subject's OWN reads are unaffected on every surface — the control is
 * over what OTHERS see. Deliberately NOT withheld, because opt-out hides live
 * location and does not retract published knowledge (append-only knowledge
 * is the product; the control is over the surveillance surface, not over
 * authorship): work contexts, claims, edges, search results, diagnosis
 * trees, solved matches, contradictions, referee briefs — all stay visible
 * and attributed on every PULL surface, minus the location fields above.
 * Hiding an event ROW about a claim hides its timing from the feed, never
 * the claim itself. Also not coverable: an "unconnected" absence line for a
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
 *   8. GET /api/questions         — the "Questions for you" block in my
 *                                   briefing (roadmap R2). Addressed
 *                                   communication, but the BRIEFING is an
 *                                   unasked surface, which is exactly what
 *                                   mute covers
 *   9. GET /api/ghost-checks      — the same block as 5 above, reached
 *                                   unasked at SessionStart. Both conditions
 *                                   sit in the WHERE of BOTH tiers AND of
 *                                   the hot-value pre-filter that decides
 *                                   which values reach them, so a muted or
 *                                   opted-out developer cannot decide what
 *                                   the reader is shown either
 *  10. POST /api/landed/context  — the teammate work a landed-change stop
 *                                   names (step 3). Presence opt-out does
 *                                   not decide WHICH work is named: her work
 *                                   is published, live or ended, and the
 *                                   match reads no time and no state of her
 *                                   sessions — "is it live" is presence
 *                                   (integration review H4); its times are
 *                                   withheld from the answer
 *  11. GET /api/landed/notices   — the author's notice (landed changes,
 *                                   step 4): X's stop at my landed change,
 *                                   in my briefing and, on the same list, in
 *                                   GET /api/hints/candidates for my prompt
 *
 * Mute is a reader preference, not a boundary: the deliberate pull paths —
 * GET /api/search (search_related_work), GET /api/work-contexts/:id/diagnosis
 * (get_diagnosis), GET /api/contradictions/:id/brief (get_referee_brief),
 * GET /api/questions?answerable=1 (list_open_questions) — stay unfiltered,
 * and the raw events feed is a subscription, not an injection, so it is not
 * muted either. The ANSWER to a question I asked is likewise never muted: it
 * is solicited, and hiding the answer to my own question would be absurd
 * whatever I think of the answerer.
 *
 * PRESENCE OPT-OUT deliberately does NOT cover questions. It hides where a
 * developer is and when they last ran an agent; a question addressed to them
 * by name is neither, they receive it exactly as anybody else does, and the
 * asker learns nothing about their presence through it.
 *
 * Nor does it cover the AUTHOR'S NOTICE (landed changes, decision 9), and
 * that one IS presence-class: "Nick ran into your landed change before editing
 * src/lines.ts, 2h ago" says where the reader was and when. It is said
 * anyway because the reader's own stop said so first ("Mike is told about
 * this stop", decision 11): nothing is reported behind anybody's back.
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
