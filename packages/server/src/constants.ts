/** Sessions with a heartbeat older than this are no longer present (DESIGN.md §5). */
export const PRESENCE_TTL_SECONDS = 90;

/** SSE outbox poll cadence; pg NOTIFY wiring is a later latency optimization. */
export const POLL_INTERVAL_MS = 1000;

/** SSE comment-line heartbeat so proxies do not close idle streams. */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export const EVENTS_DEFAULT_LIMIT = 100;
export const EVENTS_MAX_LIMIT = 500;

/** Upper bound for one POST /api/records spool flush; larger batches get 422. */
export const MAX_INGEST_BATCH = 100;

export const DEFAULT_PORT = 7100;

// ── Absence detection ───────────────────────────────────────────────────────

/**
 * Commit-evidence rows whose newest commit is older than this are pruned on
 * the next ingest for their repo — the bound on commit_evidence table growth.
 */
export const COMMIT_EVIDENCE_RETENTION_DAYS = 30;
/**
 * Evidence older than this never fires a finding. Every SessionStart of every
 * connected teammate refreshes collection, so evidence this stale means nobody
 * connected has run a session in a week — at which point per-developer absence
 * lines would indict everyone and say nothing; silence is the honest output
 * (staleness honesty, task item 4).
 */
export const ABSENCE_EVIDENCE_MAX_AGE_DAYS = 7;
/** A commit older than the connector's scan window is history, not absence. */
export const ABSENCE_COMMIT_MAX_AGE_DAYS = 14;
/**
 * Committing right after (or during) an agent session is the normal workflow,
 * not a reporting gap — the motivating incident was DAYS of unreported work.
 * A finding fires only when the newest commit postdates the last reported
 * session by more than this.
 */
export const ABSENCE_MIN_GAP_HOURS = 24;
/** Upper bound on findings per response; commit-freshest win the slots. */
export const ABSENCE_MAX_FINDINGS = 20;
/** Read bound on evidence rows considered per absence query. */
export const ABSENCE_MAX_EVIDENCE_ROWS = 200;

// ── Solved-tree matching (VISION.md §1 collective memory) ───────────────────

/**
 * How recently a live context must have been active for a solved tree
 * sharing its target to count as "matching current work". Mirrors the
 * briefing's related-work window (CONTEXT_MAX_AGE_DAYS in the connector).
 */
export const SOLVED_MATCH_ACTIVE_WINDOW_DAYS = 14;
/** Upper bound on findings per response; fingerprint matches win the slots. */
export const SOLVED_MATCH_MAX_FINDINGS = 5;
/** Read bound on shared-target pair rows considered per query. */
export const SOLVED_MATCH_MAX_PAIR_ROWS = 200;
/**
 * Read bound on the LIVE side of the shared-target join: the repo's most
 * recently active contexts, and no more. "Current work" is a small set by
 * definition — the briefing itself shows a handful — and this is the cap that
 * keeps a self-join of the target table from being quadratic in the traffic
 * of one busy repo (services/solved-matches.ts states the measurement).
 */
export const SOLVED_MATCH_MAX_LIVE_CONTEXTS = 200;

/**
 * The INTENT tier (VISION.md §1: symptoms are fingerprints, targets AND the
 * session intent). Its inputs are the CALLER'S OWN live intents on this repo
 * — an intent is a statement about what THIS developer is doing, so unlike
 * the target tiers it is not read repo-wide.
 */
export const SOLVED_MATCH_MAX_LIVE_INTENTS = 5;
/**
 * How many DISTINCT intent words a solved tree's searchable doc must match
 * before the tier will point at it. Text overlap is not identity, so this is
 * the whole precision story of the tier, and it is a COUNT rather than a
 * relevance score on purpose: a tuned float is a number nobody can argue
 * with, while "three different words of what I said I am doing" is a
 * sentence a tired reader can check against the line they were shown. Two
 * would fire on any pair of workhorse words ("fix", "test"); the floor test
 * in solved-intent.test.ts is what keeps this honest.
 */
export const SOLVED_MATCH_INTENT_MIN_TOKEN_HITS = 3;
/** Read bound on candidate rows the intent tier scores per query. */
export const SOLVED_MATCH_MAX_INTENT_CANDIDATES = 20;
/**
 * Findings the intent tier may contribute. ONE: it is the weakest signal
 * here and must never crowd out an identity match, and a briefing shows
 * MAX_SOLVED_POINTERS = 2 entries in total anyway.
 */
export const SOLVED_MATCH_MAX_INTENT_FINDINGS = 1;

/**
 * The FINGERPRINT PROBE (`?fingerprint=`), asked the moment a tool fails
 * rather than at SessionStart. Read bound on the contexts carrying one exact
 * fingerprint THAT COULD BE ANSWERS — the query applies
 * `solvedCandidateCondition` first, so the crowd of ordinary sessions that
 * merely hit the same failure never fills this window. That qualifier is the
 * whole reason 200 is a comfortable bound rather than a low one: a hot
 * fingerprint on a real hub is shared by hundreds of contexts (the block's
 * own scale probe seeded 2000), while the trees that hold a diagnosis of it
 * are a handful. The (kind, value) index makes the lookup one seek either
 * way.
 */
export const SOLVED_MATCH_MAX_PROBE_ROWS = 200;
/**
 * Findings one probe answers with. The caller renders ONE hint; the surplus
 * exists only so a match this session has already been shown does not make
 * the probe answer "nothing".
 */
export const SOLVED_MATCH_MAX_PROBE_FINDINGS = 3;
/**
 * Longest `?fingerprint=` the route accepts. A fingerprint is
 * `sha256:` + FINGERPRINT_HASH_CHARS hex (39 characters,
 * connector-core/capture/fingerprint.ts); the slack is for a future
 * algorithm label, not for prose — an unbounded value would be a free
 * string parameter on an indexed lookup.
 */
export const SOLVED_MATCH_MAX_FINGERPRINT_CHARS = 128;

/**
 * The precision loop's window (services/solved-counts.ts): how far back
 * "solved-tree pointers: N shown, M opened" looks. Long enough that a quiet week
 * does not read as a dead surface, short enough that the numbers describe
 * how the tool behaves NOW rather than how it behaved in the spring.
 */
export const SOLVED_COUNT_WINDOW_DAYS = 30;
/**
 * Read bound on delivery rows the counter reads. Past it the numbers are a
 * floor, which is why every surface prints the window with them.
 */
export const SOLVED_COUNT_MAX_DELIVERY_ROWS = 200;

/**
 * Most unreviewed Tier-1 drafts one GET /api/drafts response carries
 * (DESIGN.md §3 Tier 1 promotion loop). Well above what the summarizer cap
 * lets one session mint, and bounded like every list query:
 *
 * VERIFY: bun -e 'const s=await import("./packages/server/src/constants.ts");const c=await import("./packages/connector-core/src/constants.ts");console.log(s.MAX_DRAFTS_LISTED > c.SUMMARIZER_MAX_FIRES_PER_SESSION)'
 * PRINTS: true
 */
export const MAX_DRAFTS_LISTED = 20;

// ── The asynchronous question channel (roadmap R2) ─────────────────────────

/**
 * How long an unanswered question stays open. Applied LAZILY on read (no
 * cron, no background job): every listing demands `expires_at > now()` in
 * SQL, and the asker's own route flips the status of their own expired rows
 * when it passes over them. A question that outlived its window is a haunted
 * briefing — Slack's follow-up bots track a question "for a chosen amount of
 * time" for the same reason, and two weeks is one sprint plus slack.
 */
export const QUESTION_TTL_DAYS = 14;

/**
 * Spam budgets, hub-enforced (a modified connector must not be able to lift
 * them). Three axes, because they fail differently:
 *
 *   PER AUTHOR — how many questions one person may have waiting anywhere. The
 *   ceiling on "I asked everyone about everything and now nobody answers
 *   anything".
 *   PER TARGET — how many of those may point at ONE teammate. Without it a
 *   single author can spend their whole allowance on one person's briefing,
 *   which is exactly the "Questions for you" block filling up with one voice.
 *   PER DAY — a rate limit over a rolling 24 h, so an agent in a loop cannot
 *   burn and re-burn the open budget by withdrawing and re-asking.
 */
export const MAX_OPEN_QUESTIONS_PER_AUTHOR = 5;
export const MAX_OPEN_QUESTIONS_PER_TARGET = 3;
export const MAX_QUESTIONS_PER_AUTHOR_PER_DAY = 20;

/** Most inbox questions one GET /api/questions response carries. */
export const MAX_QUESTIONS_LISTED = 20;

/**
 * How far back the UNDELIVERED-ANSWER probe looks, counted on the QUESTION.
 *
 * WHY IT EXISTS: without it the probe's outer set is every question this
 * developer ever asked, so its cost grows monotonically with the lifetime of
 * the account and never shrinks — `hint_deliveries` has no reaper, and a
 * delivered answer does not stop being scanned. Measured on a seeded hub: 11
 * ms at 3 000 lifetime answers and 25 ms at 7 300 (about a year at a modest
 * rate), on the UserPromptSubmit path, every prompt. With the window the
 * outer set is bounded by the ASKER'S OWN BUDGET instead — at most
 * MAX_QUESTIONS_PER_AUTHOR_PER_DAY a day over this many days — so it is
 * bounded by a rule rather than by how long somebody has used the product.
 *
 * TWICE THE TTL, so nothing reachable is cut: a question cannot be answered
 * after it expires (QUESTION_TTL_DAYS), which leaves a full further TTL for
 * the asker to start a session and be handed the answer. An answer older than
 * that is not injected; the asker's `answered` counter still reports it.
 */
export const QUESTION_ANSWER_WINDOW_DAYS = QUESTION_TTL_DAYS * 2;

/**
 * Most undelivered ANSWERS one response carries. Small on purpose: they ride
 * the UserPromptSubmit path, one per prompt, inside the hint budget — a
 * bigger window would only buy rows the connector throws away.
 */
export const MAX_QUESTION_ANSWERS_LISTED = 3;

// ── Ghost commits: deterministic plan overlap (VISION.md §3) ───────────────

/**
 * How recently a teammate's work context must have moved before this surface
 * calls it a LIVE PLAN. Shorter than the solved window
 * (SOLVED_MATCH_ACTIVE_WINDOW_DAYS = 14) because the two answer different
 * questions: a solved tree is history and stays useful for as long as the
 * code does, while a ghost check asserts that somebody is working on this
 * NOW. One working week is the horizon in which two plans still meet; past
 * it the honest sentence is "Ken looked at this once", which is what search
 * is for. ConE (Maddila et al., TOSEM 2021) drops a pull request from its
 * concurrent-edit analysis after 30 days for the same reason — theirs is a
 * branch's lifetime, ours a session's.
 *
 * IT IS ONE OF THREE BOUNDS AND THE WEAKEST, which is worth stating because
 * it was once the only one. Recency is not liveness: inside these seven days
 * a session that ENDED and a context that already LANDED both look freshly
 * touched, and most contexts on an active repo inside a week are merged
 * branches. Those two are excluded by their own columns
 * (services/ghost-overlap.ts liveWorkConditions); this window only decides
 * how far back unfinished work still counts.
 */
export const GHOST_ACTIVE_WINDOW_DAYS = 7;

/**
 * The reader's own contexts the overlap is computed FROM, freshest first. A
 * session has one work context by construction; the slack is for a developer
 * running parallel worktrees on one repo, whose plans are all theirs.
 */
export const GHOST_MAX_OWN_CONTEXTS = 3;

/**
 * A work context carrying more target values than this is EXCLUDED from both
 * sides of the SHARED-TARGET tier — mine and theirs alike. The INTENT tier is
 * deliberately untouched by it: that tier shares no value, so the argument
 * below does not reach it (services/ghost-overlap.ts listIntentHits).
 *
 * It is a sweep, not a plan: a mass rename, a formatter run, a dependency
 * bump. Sharing a file with a sweep says nothing about whether two designs
 * collide, and a sweep shares files with everybody, so admitting one would
 * make every session on the repo collide with it. This is ConE's own filter
 * (pull requests touching more than 50 files are dropped, their 90th
 * percentile of change size) applied to the unit we have.
 */
export const GHOST_MAX_CONTEXT_TARGETS = 50;

/**
 * A target value shared by more work contexts than this is dropped before
 * anything is counted: a lockfile, the router, the config every session
 * edits. ConE's "rarely concurrently edited" heuristic, which is the half of
 * that paper doing the precision work.
 *
 * THEIRS IS A BINARY, OURS IS A COUNT, and the difference is the batch job we
 * cannot run. ConE builds its RCE list by SET SUBTRACTION — every file edited
 * in the last three months, minus every file that appeared in two overlapping
 * pull requests at once — and refreshes it weekly, so a file that was ever
 * concurrently edited in the window is not rare and gets no notification. A
 * hub answering a SessionStart GET has no three-month batch and no list to
 * keep, so rarity here is one indexed aggregate over the values the reader's
 * own session already holds, and the bar is a COUNT of how many contexts
 * share the value rather than "any at all". That is deliberately LOOSER than
 * ConE: they would drop a value two people ever touched together, and we
 * would not — dropping those is what a ghost check exists to report.
 *
 * It is also the fan-out bound, and the honest statement of it is a PRODUCT
 * rather than a sentence about one value: every surviving value is shared by
 * at most this many contexts, and the reader holds at most
 * GHOST_MAX_OWN_CONTEXTS x GHOST_MAX_CONTEXT_TARGETS of them, so the pair
 * query's whole answer is bounded by the three together (GHOST_MAX_PAIR_ROWS,
 * which says what that costs when the bound is read as a budget instead). The
 * defect measured on the solved surface at 1.2 s
 * (services/solved-matches.ts) is prevented here by that arithmetic rather
 * than by a cap on the crowd.
 */
export const GHOST_HOT_TARGET_MAX_CONTEXTS = 20;

/**
 * Distinct shared target values a foreign context needs before the
 * deterministic core will name it — UNLESS the shared kind is an error
 * fingerprint, where one is enough (GHOST_FINGERPRINT_MIN_SHARED).
 *
 * A COUNT rather than ConE's Extent-of-Overlap ratio, and the difference is
 * forced by the unit: their bar is EOO >= 50 % of the reference change's
 * files AND more than two overlapping files, and a ratio needs a denominator.
 * At SessionStart a live work context has captured two or three targets, so
 * one shared file is already 50 % of it — a ratio over a denominator that
 * small is the prediction theatre this feature is supposed to avoid. What
 * survives the translation is the half that carries: their file-count floor,
 * chosen because the distribution drops sharply after two. Two shared values
 * is also a sentence a reader can check.
 */
export const GHOST_MIN_SHARED_TARGETS = 2;

/**
 * Shared error fingerprints that qualify on their own. ONE: a fingerprint is
 * derived from the failure TEXT (connector-core/capture/fingerprint.ts), so
 * two contexts carrying it are hitting the same failure rather than sitting
 * near each other — the same content-identity argument that lets a
 * fingerprint travel across repos on the solved surface.
 */
export const GHOST_FINGERPRINT_MIN_SHARED = 1;

/**
 * Distinct words of the reader's OWN intent a foreign context's searchable
 * doc must match before text alone earns a notice. The same floor and the
 * same reasoning as SOLVED_MATCH_INTENT_MIN_TOKEN_HITS — a count somebody
 * can check, never a tuned relevance score — and it is what catches VISION
 * §3's own case: two plans that touch no common file yet and still collide.
 */
export const GHOST_INTENT_MIN_TOKEN_HITS = 3;

/** Read bound on candidate rows the intent tier scores per query. */
export const GHOST_MAX_INTENT_CANDIDATES = 20;

/**
 * Read bound on shared-target pair rows — ARITHMETIC rather than a budget,
 * and it has to be. The reader holds at most GHOST_MAX_OWN_CONTEXTS x
 * GHOST_MAX_CONTEXT_TARGETS distinct values (the sweep rule makes that a
 * ceiling rather than a hope), and every value that survives the hot rule is
 * carried by at most GHOST_HOT_TARGET_MAX_CONTEXTS foreign contexts the
 * reader may be told about. Their product is the most rows the pair query can
 * return, so this window cannot cut.
 *
 * A SMALLER NUMBER IS NOT A SAFE ONE, and the 400 that stood here was not.
 * The reasoning it rested on was about ONE hot value, and no single value can
 * crowd the window — the AGGREGATE of many merely-warm values does. Forty-five
 * values on nine foreign contexts each is 405 legal rows, and because the
 * window is spent value-alphabetically the teammate whose paths sort late
 * loses BOTH of his rows. Truncating this query does not hide rows, it
 * corrupts a count: at GHOST_MIN_SHARED_TARGETS = 2 a context whose two rows
 * straddle the cut is judged below the floor and dropped whole, so the answer
 * is not a short list but an EMPTY one. That shape is pinned by "a crowd of
 * warm values never empties the pair window" in test/ghost-overlap.test.ts.
 *
 * VERIFY: bun -e 'const s=await import("./packages/server/src/constants.ts");console.log(s.GHOST_MAX_PAIR_ROWS === s.GHOST_MAX_OWN_CONTEXTS * s.GHOST_MAX_CONTEXT_TARGETS * s.GHOST_HOT_TARGET_MAX_CONTEXTS, s.GHOST_MAX_PAIR_ROWS)'
 * PRINTS: true 3000
 */
export const GHOST_MAX_PAIR_ROWS =
  GHOST_MAX_OWN_CONTEXTS *
  GHOST_MAX_CONTEXT_TARGETS *
  GHOST_HOT_TARGET_MAX_CONTEXTS;

/** Findings one response carries, strongest reason first. */
export const GHOST_MAX_FINDINGS = 3;

/**
 * Findings ONE DEVELOPER may hold in that answer. One, and the argument is
 * the one MAX_QUESTION_POINTERS makes on the connector side: a block filled
 * by a single voice is a block the second voice never reaches. A developer
 * running three worktrees on this repo has three contexts, each of them a
 * legitimate overlap, and by raw strength they take all GHOST_MAX_FINDINGS
 * slots — so the teammate who is in the reader's way for a different reason
 * never reaches the wire at all, and the reader, who is expected to ACT on
 * this block, never learns about them.
 *
 * Their STRONGEST context survives, so nothing about the person is lost:
 * the ranking has already run when this cap is applied, and `get_diagnosis`
 * on that context reaches the rest of their tree.
 *
 * VERIFY: bun -e 'const s=await import("./packages/server/src/constants.ts");console.log(s.GHOST_MAX_FINDINGS_PER_DEVELOPER < s.GHOST_MAX_FINDINGS)'
 * PRINTS: true
 */
export const GHOST_MAX_FINDINGS_PER_DEVELOPER = 1;

/**
 * Shared values named on the wire per finding. The reader is told the total
 * separately, so this bounds the LINE, not the fact. Three is what fits on
 * one briefing line beside a name, an age and an intent.
 */
export const GHOST_MAX_SHARED_SHOWN = 3;

export const EVENT_KINDS = {
  DEVELOPER_CREATED: "developer_created",
  SESSION_STARTED: "session_started",
  SESSION_ENDED: "session_ended",
  WORK_CONTEXT_CREATED: "work_context_created",
  WORK_CONTEXT_UPDATED: "work_context_updated",
  CLAIM_ADDED: "claim_added",
  CLAIM_EDGE_ADDED: "claim_edge_added",
  // NO question kinds here on purpose. A question is addressed to ONE person
  // and the outbox is a team-wide feed; an event row saying "Nick asked Ken
  // something" would put addressed communication on a surface nobody asked
  // for, and the feed's opt-out filter is written for the SUBJECT of a row,
  // which a question has two of. The channel's own counters (GET
  // /api/questions) are where its activity is visible, to the two people it
  // concerns.
} as const;

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];
// ── Agent conferences (VISION.md §2) ────────────────────────────────────────

/**
 * How far back a conference reads. Fourteen days, the solved matcher's window
 * rather than the ghost check's seven, because the two answer different
 * questions: a ghost check asks who is in my way RIGHT NOW, a conference asks
 * what this team has been circling — and an investigation somebody paused over
 * a weekend is exactly the kind a synthesis is supposed to find again.
 */
export const CONFERENCE_ACTIVE_WINDOW_DAYS = 14;

/**
 * Work contexts one conference may read, freshest first.
 *
 * Twelve is what a report a human reads in a minute can name, and it is also
 * what the model layer can be shown without the input becoming a document
 * nobody can check: every context contributes an intent sentence and up to
 * CONFERENCE_MAX_CLAIMS_PER_CONTEXT claim lines, so the whole prompt stays
 * inside a few thousand characters whose cost the run prints BEFORE it spends
 * anything.
 */
export const CONFERENCE_MAX_CONTEXTS = 12;

/**
 * Declared claims read per context, newest first — the per-context bound that
 * makes the whole read arithmetic rather than a race between contexts. One
 * indexed lookup per context (claims_work_context_created_idx), so a tree with
 * nine hundred claims spends five rows here exactly like a tree with six; a
 * single `IN (…)` over all twelve would let that one tree take the entire
 * window and empty the eleven beside it, which is the defect Block 4 measured
 * on the reader's own targets.
 */
export const CONFERENCE_MAX_CLAIMS_PER_CONTEXT = 5;

/** Rows the claim read can return in total — the product, stated once. */
export const CONFERENCE_MAX_CLAIM_ROWS =
  CONFERENCE_MAX_CONTEXTS * CONFERENCE_MAX_CLAIMS_PER_CONTEXT;

/**
 * A claim body as the conference reads it. Long enough for a real finding,
 * short enough that twelve contexts of them stay a bounded prompt; the report
 * quotes the same cut text, so what the model saw and what the human reads are
 * the same sentence.
 */
export const CONFERENCE_CLAIM_BODY_MAX_CHARS = 300;

/** Open questions one report may name, oldest first (the stalest is the finding). */
export const CONFERENCE_MAX_QUESTIONS = 10;

/** Contradiction candidates one report may name — each is a referee brief away. */
export const CONFERENCE_MAX_CONTRADICTIONS = 5;

/**
 * Duplicated-work pairs one report may name. Pairs, never a matrix: twelve
 * contexts admit sixty-six comparisons and a report listing them all is the
 * "wall of text" §8 of the spec forbids.
 */
export const CONFERENCE_MAX_OVERLAP_PAIRS = 5;

/**
 * How far the "read 12 of N" count is allowed to look. A count is a scan, and
 * a report line is not worth an unbounded one on a hub with ten thousand work
 * contexts — past this the line says "500+" and means it.
 */
export const CONFERENCE_MAX_COUNTED_CONTEXTS = 500;

// ── Suspect attribution (regression-guard Stage 1) ──────────────────────────

/**
 * How far back `crosscheck suspect` reads. The same 14 days the briefing's
 * related-work window and the solved matcher use — a bound on the QUESTION,
 * not on the corpus: work older than this is history, and a "suspect" from
 * five weeks ago is a research project, not an answer to "who broke this".
 */
export const SUSPECT_WINDOW_DAYS = 14;

/**
 * Upper bound on the paths one lookup may intersect. A pin is capped at
 * MAX_PIN_FILES (30) by the schema; this bounds the OTHER caller — a reader
 * naming files by hand — so the `IN (…)` list can never grow with a repo.
 */
export const SUSPECT_MAX_PATHS = 30;

/**
 * Read bound on candidate (context, session) rows. The query is already
 * bounded by the path list through the (kind, value) index; this is the
 * belt-and-braces bound for a pinned file that a whole team swept.
 */
export const SUSPECT_MAX_CANDIDATES = 50;

/** How many candidates are printed. Three, with their scores, always. */
export const SUSPECT_TOP_CANDIDATES = 3;

/**
 * How much clear air the top score needs before the answer is "this one"
 * rather than "these are the three". Below it the outcome is
 * `no_separation` — the rows still print WITH their scores, because the
 * honesty belongs in the label rather than in hiding the data. 1.5 is a
 * DELIBERATE non-tuning: it is "half again as concentrated", the coarsest
 * threshold that still separates a focused session from a sweep, and no
 * dataset here could justify a second decimal.
 */
export const SUSPECT_SEPARATION_RATIO = 1.5;
