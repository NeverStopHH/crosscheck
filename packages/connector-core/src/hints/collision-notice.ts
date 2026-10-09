/**
 * THE COLLISION, TOLD TO THE PERSON (pilot, 2026-10-07).
 *
 * Two teammates edited eleven of the same files on different branches over
 * three days. Crosscheck saw it — two tripwire asks and a stream of prompt
 * pointers — and put every word of it into an AGENT's context: no agent ever
 * relayed one, and the person found out at merge time. "Collisions must be
 * visible to humans." This module is the one spelling of what the person is
 * shown, on whichever channel a host gives a hook to reach them (Claude
 * Code's `systemMessage`, its statusline; docs/RESEARCH.md §7 has the
 * per-host findings, and the hosts without such a channel are refusals in
 * their own capability manifests rather than a faked one).
 *
 * WHAT IT IS BUILT FROM. Only the row the collision lane itself acted on —
 * the tripwire's `TripwireSession`, a briefing's `GhostCheckEntry` — and
 * never another source. That is how presence opt-out is respected exactly as
 * the agent-facing lane respects it: the hub drops an opted-out or muted
 * teammate's rows from both endpoints (server services/visibility.ts), so a
 * hidden teammate never reaches this file, and a branch the projection
 * withheld (LOCATION_WITHHELD) or a detached HEAD is never printed as one.
 *
 * WHAT IT MAY SAY. Renderer-owned words around BARE fields: the teammate's
 * display name, the BASENAME of one of the reader's own files, a branch —
 * each through `bareUntrusted`, which strips the separators this line owns
 * (`:`, `·`, `—`), so no field can mint a second verdict. No title, no
 * intent, no claim body: the person needs who, what and where, and the agent
 * holds the rest one `get_diagnosis` away.
 *
 * A render-layer module, registered in RENDER_LAYER_MODULES and attacked by
 * the injection corpus through its own surfaces (`collision-notice`,
 * `collision-overlap-indicator`, `collision-subagent-relay`).
 */
import { LOCATION_WITHHELD } from "@crosscheck/schema";

import {
  COLLISION_INDICATOR_MAX_CHARS,
  COLLISION_INDICATOR_MAX_NAMES,
  COLLISION_NOTICE_BRANCH_CHARS,
  COLLISION_NOTICE_FILE_CHARS,
  COLLISION_NOTICE_MAX_CHARS,
  COLLISION_NOTICE_MAX_LINES,
  PRESENCE_TTL_MS,
  COLLISION_NOTICE_NAME_CHARS,
  COLLISION_NOTICE_PATH_CHARS,
  STATUSLINE_NAME_CHARS,
  UNSOLICITED_CLAIM_BODY_MAX_CHARS,
} from "../constants.ts";
import { formatGhostAge, largeChangeClause, largeChangeOf } from "../briefing/ghost.ts";
import { cutWellFormed } from "../briefing/cut.ts";
import { bareCleaned, tripsPhraseFilter } from "../briefing/sanitize.ts";
import { hasIncompleteRung } from "../coverage/render.ts";
import { isDetachedBranch } from "../git/detached-branch.ts";
import type { CoverageRecord } from "../http/coverage.ts";
import type { GhostCheckEntry, TripwireSession } from "../http/hub.ts";
import type { CollisionNotice } from "../state/session-state.ts";

/** The name a row without a usable one is given — never a guess at who. */
const UNKNOWN_TEAMMATE = "A teammate";

/** What a group whose one named file sanitized to nothing is called. */
const UNNAMED_FILE = "a file you touched";

/** The only target kind a person-facing notice counts: a FILE both touched. */
const FILE_KIND = "file";

const ELLIPSIS = "…";

/**
 * THE ONE SENTENCE THE AGENT IS ASKED TO ACT ON, appended to the tripwire's
 * agent-facing text exactly once per group (and to a subagent's queued relay).
 * The tripwire's own lines stay factual and unchanged; this is crosscheck's
 * request, attributed as such, with no teammate field in it.
 */
export const COLLISION_RELAY_SENTENCE =
  "crosscheck asks that your next reply mention this overlap to the person you work for, so they can talk to the teammate first.";

/**
 * The main thread's header for overlaps its SUBAGENTS ran into: the subagent's
 * own context is not the conversation the person reads.
 */
export const SUBAGENT_RELAY_HEADER =
  "crosscheck: a subagent of this session ran into a teammate's work while editing.";

/**
 * The relay's request when it can only COUNT what a subagent ran into (round
 * 3, F-L2): with no group named there is no "this overlap" or "the teammate"
 * to mention, and a request that named them would point at nothing.
 */
export const COUNT_ONLY_RELAY_SENTENCE =
  "crosscheck asks that your next reply tell the person you work for about these overlaps, so they can check with their team first.";

/**
 * COV-9 ON A PERSON-FACING LINE ("fails if a person has to run doctor to
 * learn that an answer was based on partial observation"). A tripwire hit is
 * a POSITIVE answer — a gap cannot make Mike's session less real — so the
 * full coverage clause the agent's ask carries would be noise on one line;
 * what a gap CAN do is hide more of the overlap, and that is what the person
 * is told, whenever the record behind the answer is positively incomplete.
 */
export const PARTIAL_RECORD_CLAUSE =
  "; crosscheck's record of this repo is incomplete, so the overlap may be wider";

/** The dedup key: one teammate's one work context, the pair spelled unambiguously. */
export const collisionKey = (developerId: string, workContextId: string): string =>
  JSON.stringify([developerId, workContextId]);

/** Cut at `maxChars` with a visible ellipsis, never through an astral pair. */
const capped = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${cutWellFormed(text, maxChars - ELLIPSIS.length)}${ELLIPSIS}`;

/**
 * What a field on a PERSON's line loses beyond the BARE strip (review L2,
 * and round two's L5). The bare strip guards an agent's context; this line is
 * read by a human on a terminal or an IDE panel that may render markdown, so
 * it also DROPS every default-ignorable code point and any lone surrogate,
 * the blank fillers that pad a name into a second "sentence" (U+3164, U+115F,
 * U+FFA0, U+2800), the parentheses this line writes its own facts in —
 * `(merged)`, `(last active 2d ago)` — and the AMPERSAND that opens an HTML
 * entity reference (round 3, F-L3): a markdown panel decodes `&#58;`,
 * `&colon;` or `&mdash;` into the very separators this line owns. The
 * markdown beacons `[ ] !` and the emphasis markers `*` `~` are punctuation
 * and symbols, so SEPARATOR_LOOKALIKES below turns them into spaces with the
 * rest. Built from code-point NUMBERS, so no invisible or lookalike character
 * sits in this file's source.
 */
const BLANK_FILLERS = String.fromCodePoint(0x3164, 0x115f, 0xffa0, 0x2800);
const INVISIBLE_CLASS = `\\p{Default_Ignorable_Code_Point}\\p{Cs}${BLANK_FILLERS}`;
const PERSON_DROP = new RegExp(`[${INVISIBLE_CLASS}()&]`, "gu");

/**
 * The punctuation and symbols a person's field may keep (round 3, F-L3) —
 * what real names, branches and file names are written with: hyphen,
 * underscore, dot, comma, colon, slash, at, parentheses and the apostrophe.
 * The colon and the parentheses are allowed only HERE: the bare strip and
 * PERSON_DROP have already taken them out of every field.
 */
const PERSON_KEPT_PUNCTUATION = "-_.,:/@()'";

/**
 * The separators this line and the statusline segment own — `:`, `—`, `·` —
 * have lookalikes NFKC leaves alone, and two rounds of review found more of
 * them than any list held (round 3: Z NOTATION TYPE COLON, the Ethiopic
 * wordspace and colon, BAMUM COLON, TIBETAN TSHEG, RING OPERATOR, AEGEAN WORD
 * SEPARATOR DOT). So the rule is a CLASS, not a list: EVERY punctuation or
 * symbol code point outside PERSON_KEPT_PUNCTUATION becomes a space. A list
 * remains only for lookalikes the class cannot see because Unicode files them
 * as LETTERS: MODIFIER LETTER TRIANGULAR and HALF TRIANGULAR COLON, LISU
 * LETTER TONE MYA JEU, LATIN LETTER SINOLOGICAL DOT and CANADIAN SYLLABICS
 * FINAL MIDDLE DOT. Replaced by a SPACE, never deleted: the katakana middle
 * dot is how a Japanese name separates given from family name, and the two
 * halves stay two words where deleting it would fuse them into one.
 */
const LETTER_LOOKALIKES = String.fromCodePoint(0x02d0, 0x02d1, 0xa4fd, 0xa78f, 0x1427);
const SEPARATOR_LOOKALIKES = new RegExp(
  `[${LETTER_LOOKALIKES}]|(?![${PERSON_KEPT_PUNCTUATION}])[\\p{P}\\p{S}]`,
  "gu",
);

/**
 * A SPACING MARK with no letter of its own script before it (round 3, F-L3):
 * DEVANAGARI SIGN VISARGA after a Latin `k` reads as `crosscheck: all clear`,
 * and Unicode files it as a mark, not punctuation. After a letter of a script
 * that writes with spacing marks it is part of the word and stays — a Hindi
 * name keeps its visarga; after a Latin, Greek or Cyrillic letter, a digit,
 * a space or punctuation, where no such script writes one, it becomes a
 * space.
 */
const STRAY_SPACING_MARK =
  /(^|[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}])\p{Mc}+/gu;

/**
 * An underscore that could open or close emphasis: one NOT between two
 * letters or digits. CommonMark never emphasises an intraword `_`, so
 * `player_mapping.ts` and `feat/refresh_v2` keep theirs.
 */
const LOOSE_UNDERSCORE = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;

/**
 * A bare `www.` host, which GitHub-flavoured markdown links with no scheme at
 * the start, after whitespace, or after an `_` (the only one of its other
 * openers the strip keeps): the dot goes, the letters stay.
 */
const BARE_WWW = /(^|[\s_])(www)\./giu;

/** One pass of the person strip — run before NFKC and again after it, which folds `＊` into `*`. */
const personPass = (text: string): string =>
  text
    .replace(PERSON_DROP, "")
    .replace(STRAY_SPACING_MARK, "$1 ")
    .replace(SEPARATOR_LOOKALIKES, " ")
    .replace(LOOSE_UNDERSCORE, "")
    .replace(BARE_WWW, "$1$2");

/**
 * The invisible half of it, for a path the STATE keeps: brackets stay, so
 * `app/(shop)/cart.tsx` and `app/shop/cart.tsx` remain two files.
 */
const STORED_STRIP = new RegExp(`[${INVISIBLE_CLASS}]`, "gu");

/** Stripped BEFORE NFKC and again after it, whitespace folded. */
const cleanedWith = (raw: string, strip: RegExp): string =>
  bareCleaned(raw.replace(strip, ""))
    .replace(strip, "")
    .replace(/\s+/g, " ")
    .trim();

/** The person strip BEFORE NFKC and again after it (NFKC folds `［` into `[`), whitespace folded. */
const personCleaned = (raw: string): string =>
  personPass(bareCleaned(personPass(raw)))
    .replace(/\s+/g, " ")
    .trim();

const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * The head of an untrusted value, bounded at the unsolicited cap BEFORE the
 * left cut below: this line arrives unasked, so no byte from past
 * UNSOLICITED_CLAIM_BODY_MAX_CHARS of what a teammate's row carried may reach
 * it (test/anchoring-separation.test.ts) — a left cut alone would print the
 * TAIL of a 10,000-character value. Every real path fits inside it whole.
 */
const unsolicitedHead = (raw: string): string => cutWellFormed(raw, UNSOLICITED_CLAIM_BODY_MAX_CHARS);

/**
 * Cut from the LEFT at `maxChars`: the TAIL survives behind a visible
 * ellipsis — for a path that is the file name, the one part the person reads
 * — and never from inside an astral pair.
 */
const cappedFromLeft = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) {
    return text;
  }
  const tail = text.slice(text.length - (maxChars - ELLIPSIS.length));
  return `${ELLIPSIS}${isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail}`;
};

/**
 * A PATH as the session state stores it: every bare strip, cut from the left
 * so the file name survives a deep monorepo path, and NO phrase decision. The
 * redaction marker is a rendering, never data — stored,
 * `src/overrides/button.tsx` and `src/overrides/input.tsx` would both become
 * the same marker and one teammate on two files would count as one.
 */
const storedPath = (path: string): string =>
  cappedFromLeft(cleanedWith(unsolicitedHead(path), STORED_STRIP), COLLISION_NOTICE_PATH_CHARS);

/**
 * A field as the PERSON reads it — and, for a name or a branch, as the state
 * stores it: every bare strip, then the phrase filter on the WHOLE value (a
 * cap applied first could cut the phrase off), "" when nothing survives or
 * the value reads like an instruction, and each caller says what stands in
 * its place. Never `[redacted …]` on a person's screen or in the state file:
 * a colleague called "Pact Ashley" or a branch `fix/override-timeout` is an
 * ordinary word the filter fears, not an attack worth a marker.
 */
const personField = (raw: string, maxChars: number): string => {
  const cleaned = personCleaned(raw);
  return cleaned.length === 0 || tripsPhraseFilter(cleaned) ? "" : capped(cleaned, maxChars);
};

const displayName = (raw: string | undefined): string => {
  const name = raw === undefined ? "" : personField(raw, COLLISION_NOTICE_NAME_CHARS);
  return name.length === 0 ? UNKNOWN_TEAMMATE : name;
};

/**
 * The person strip ALONE (round 3, F-L4), for a field ANOTHER person-facing
 * segment prints: the statusline's presence list, whose names sat unstripped
 * beside the stripped `⚠ overlap:` segment on the same line. No phrase
 * decision and no cap — an empty field drops a presence row, so the caller
 * makes both where it prints.
 */
export const personText = (raw: string): string => personCleaned(unsolicitedHead(raw));

/** A teammate's name as every person-facing segment prints it: stripped, phrase-checked, capped, never empty. */
export const personName = (raw: string): string => displayName(raw);

/**
 * Whether a branch may be named at all: never the projection's opt-out marker
 * (tested on the RAW value, before any strip could reshape it), never a
 * detached HEAD.
 */
const isNameableBranch = (raw: string): boolean => raw !== LOCATION_WITHHELD && !isDetachedBranch(raw);

/** The branch a notice may print and the state may keep, or null — which also covers a phrase hit. */
const visibleBranch = (raw: string): string | null => {
  const branch = isNameableBranch(raw) ? personField(raw, COLLISION_NOTICE_BRANCH_CHARS) : "";
  return branch.length === 0 ? null : branch;
};

/**
 * The tripwire's one row, as the group the person is told about — with the
 * coverage the same answer carried, absent from a hub that reported none.
 */
export const tripwireCollision = (
  session: TripwireSession,
  file: string,
  coverage?: CoverageRecord,
): CollisionNotice => {
  const path = storedPath(file);
  return {
    key: collisionKey(session.developerId, session.workContextId),
    developerId: session.developerId,
    name: personField(session.developerName, COLLISION_NOTICE_NAME_CHARS),
    files: path.length === 0 ? [] : [path],
    fileCount: 1,
    branch: visibleBranch(session.branch),
    lastActiveAt: session.lastHeartbeatAt,
    ...(coverage !== undefined && hasIncompleteRung(coverage) ? { partial: true } : {}),
    ...(hasLanded(session.landedAt) ? { landed: true } : {}),
    ...largeChangeField(session.largeChangeFiles),
  };
};

/** The size a LARGE change's row carried, kept for the line (release gate, gap 6); nothing for a focused one. */
const largeChangeField = (files: number | null | undefined): { readonly largeChangeFiles?: number } => {
  const size = largeChangeOf(files);
  return size === null ? {} : { largeChangeFiles: size };
};

/** A row's `landedAt` counts only when it is a readable instant; anything else is open work. */
const hasLanded = (landedAt: string | null | undefined): boolean =>
  typeof landedAt === "string" && !Number.isNaN(Date.parse(landedAt));

/**
 * How many FILES a ghost row's overlap holds. The hub sorts the shared values
 * by kind ascending (error_fingerprint < file < symbol) and sends a bounded
 * head of that list, so the values it held back come AFTER the sample: when
 * the sample ends in a file they may be files, and when it reaches past the
 * files they are not. Symbol targets have no capture producer in any
 * connector today, so the first case is all files in practice.
 */
const ghostFileCount = (entry: GhostCheckEntry, files: number): number => {
  const hidden = Math.max(0, entry.sharedTargetCount - entry.sharedTargets.length);
  return entry.sharedTargets.at(-1)?.kind === FILE_KIND ? files + hidden : files;
};

/**
 * A briefing's ghost rows (VISION.md §3) as person-facing groups — only the
 * rows with a FILE in their overlap. A shared failure or words of an intent
 * are the agent's to weigh; the person is told about files both are changing.
 * The branch is the row's own — a topic's, where the work lives (release
 * gate, 1b) — and none from a hub that sends none.
 */
export const ghostCollisions = (entries: readonly GhostCheckEntry[]): readonly CollisionNotice[] =>
  entries.flatMap((entry) => {
    const files = entry.sharedTargets
      .filter((target) => target.kind === FILE_KIND)
      .map((target) => storedPath(target.value))
      .filter((path) => path.length > 0);
    if (files.length === 0) {
      return [];
    }
    return [
      {
        key: collisionKey(entry.developerId, entry.workContextId),
        developerId: entry.developerId,
        name: personField(entry.developerName ?? "", COLLISION_NOTICE_NAME_CHARS),
        files,
        fileCount: ghostFileCount(entry, files.length),
        branch: visibleBranch(entry.branch ?? ""),
        lastActiveAt: entry.lastActiveAt,
        ...largeChangeField(entry.largeChangeFiles),
      },
    ];
  });

/** " (last active 2d ago)", or nothing for an instant that is unreadable or ahead of the clock. */
const ageClause = (iso: string | null, now: Date): string => {
  const ms = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) || ms > now.getTime() ? "" : ` (last active ${formatGhostAge(now.getTime() - ms)})`;
};

const basename = (path: string): string => path.split("/").filter((part) => part.length > 0).at(-1) ?? "";

/**
 * A group as a RENDERER takes it: a told group; one whose teammate a presence
 * answer OMITS at the moment it is shown LATER (round 2, H1), told UNNAMED —
 * no name, no branch, no age — rather than not at all; or one shown later
 * with NO presence answer to hold it to (round 3, F-L1), told by name in the
 * past tense with no branch and no age. Never stored: both flags exist only
 * between the relay and the line.
 */
export type RenderableCollision = CollisionNotice & {
  readonly anonymous?: true;
  readonly unconfirmed?: true;
};

/** The group with everything that says WHO and WHERE dropped; the file stays. */
export const anonymousCollision = (group: CollisionNotice): RenderableCollision => ({
  ...group,
  name: "",
  branch: null,
  lastActiveAt: null,
  anonymous: true,
});

/**
 * The group with everything that says WHERE dropped and the name kept (round
 * 3, F-L1): a relay with no presence answer has the tripwire's hit-time row
 * and nothing newer, so it says who worked on the file, not who is on it now,
 * and carries no location a teammate's opt-out since might have withheld.
 */
export const unconfirmedCollision = (group: CollisionNotice): RenderableCollision => ({
  ...group,
  branch: null,
  lastActiveAt: null,
  unconfirmed: true,
});

/**
 * ONE LINE for the person:
 * `crosscheck: Mike is working on PlayerMappingGrid.tsx on branch feat/x (last active 3m ago) — talk before you both change it`;
 * with no presence answer, `crosscheck: Mike recently worked on PlayerMappingGrid.tsx — talk before you change it`;
 * or, omitted by presence, `crosscheck: A teammate recently worked on PlayerMappingGrid.tsx — talk to your team before you change it`.
 * Every field is sanitized HERE, at render, whatever the group was built
 * from — a group read back from a state file is no more trusted than a row.
 */
export const renderCollisionNotice = (group: RenderableCollision, now: Date): string => {
  const [first] = group.files;
  const shown = first === undefined ? "" : personField(basename(first), COLLISION_NOTICE_FILE_CHARS);
  const file = shown.length === 0 ? UNNAMED_FILE : shown;
  const isGroup = group.fileCount > 1;
  const what = isGroup ? `${String(group.fileCount)} files you also touched, e.g. ${file}` : file;
  const pronoun = isGroup ? "them" : "it";
  const partial = group.partial === true ? PARTIAL_RECORD_CLAUSE : "";
  if (group.anonymous === true) {
    return `crosscheck: ${UNKNOWN_TEAMMATE} recently worked on ${what} — talk to your team before you change ${pronoun}${partial}`;
  }
  const name = displayName(group.name);
  const branch = group.branch === null ? null : visibleBranch(group.branch);
  // A LARGE change is qualified, never hidden (release gate, gap 6): the
  // person weighs a file shared with a 190-file sweep against a plan.
  const size = largeChangeOf(group.largeChangeFiles);
  const where = `${branch === null ? "" : ` on branch ${branch}`}${size === null ? "" : `, ${largeChangeClause(size)}`}`;
  // LANDED work is a change already made, not a plan in flight: the person
  // is told what merged, and the advice drops "both" — only they are about
  // to change it. No age: a heartbeat says nothing about when it merged.
  if (group.landed === true) {
    return `crosscheck: ${name} changed ${what}${where} (merged) — talk before you change ${pronoun}${partial}`;
  }
  // UNCONFIRMED is the past tense of the same fact, without a location.
  const sized = size === null ? "" : `, ${largeChangeClause(size)}`;
  return group.unconfirmed === true
    ? `crosscheck: ${name} recently worked on ${what}${sized} — talk before you change ${pronoun}${partial}`
    : `crosscheck: ${name} is working on ${what}${where}${ageClause(group.lastActiveAt, now)} — ` +
        `talk before you both change ${pronoun}${partial}`;
};

/**
 * The groups whose teammate the hub's PRESENCE answer still lists (review
 * M2). A group was recorded from a row the hub had already filtered, but the
 * record outlives the moment: presence drops a teammate who opted out since,
 * one the reader muted, and one whose session ended — so a surface that
 * shows a record LATER (the statusline, a relay) names only who is listed
 * now. Present-but-self rows never name a teammate.
 */
export const stillPresent = (
  groups: readonly CollisionNotice[],
  presence: readonly { readonly developerId: string; readonly isSelf: boolean }[],
): readonly CollisionNotice[] =>
  groups.filter((group) => presence.some((entry) => !entry.isSelf && entry.developerId === group.developerId));

/**
 * A group older than the presence TTL keeps its name and its files and loses
 * its location (review M2): a branch and a "last active" age are presence
 * facts, and past PRESENCE_TTL_MS they are no longer facts the hub would give
 * out about anybody. An unreadable instant counts as old, and so does one
 * AHEAD of the clock (round 2, L2): a hub clock an hour fast, or a forged
 * stamp, would otherwise keep a branch the 90 s rule exists to drop.
 */
export const withoutStaleLocation = (group: CollisionNotice, now: Date): CollisionNotice => {
  const ms = group.lastActiveAt === null ? Number.NaN : Date.parse(group.lastActiveAt);
  const ageMs = now.getTime() - ms;
  return !Number.isNaN(ms) && ageMs >= 0 && ageMs <= PRESENCE_TTL_MS
    ? group
    : { ...group, branch: null, lastActiveAt: null };
};

/** What a relay reads of a presence answer: who, whether it is the reader, where, and since when. */
export interface PresenceFact {
  readonly developerId: string;
  readonly isSelf: boolean;
  readonly branch: string;
  readonly lastHeartbeatAt: string;
}

/** Whether this presence row is the group's teammate (never the reader's own row). */
const isTeammateOf = (group: CollisionNotice, entry: PresenceFact): boolean =>
  !entry.isSelf && entry.developerId === group.developerId;

/** The FRESHEST presence row confirming this group's teammate — several windows are one teammate. */
const confirmingEntry = (group: CollisionNotice, presence: readonly PresenceFact[]): PresenceFact | undefined =>
  presence
    .filter((entry) => isTeammateOf(group, entry))
    .reduce<PresenceFact | undefined>(
      (freshest, entry) =>
        freshest === undefined || Date.parse(entry.lastHeartbeatAt) > Date.parse(freshest.lastHeartbeatAt)
          ? entry
          : freshest,
      undefined,
    );

/**
 * WHERE the teammate is NOW, from the presence row that confirmed them (round
 * 2, L3): the hit's own heartbeat is as old as the subagent's run, so a
 * subagent working past the presence TTL lost the branch while presence still
 * listed the teammate. Landed work keeps the branch that merged — the
 * teammate's live session may be on another one by now. And a presence row
 * whose branch cannot be named — a detached HEAD, a withheld one — leaves
 * the branch the hit recorded (release gate, 1b): a long detached session
 * works on topics, and the hit's row named the topic the file's work is on.
 */
const locatedBy = (group: CollisionNotice, entry: PresenceFact): CollisionNotice => ({
  ...group,
  branch: group.landed === true || !isNameableBranch(entry.branch) ? group.branch : entry.branch,
  lastActiveAt: entry.lastHeartbeatAt,
});

/**
 * A subagent's queued groups as the MAIN thread is told them (round 2, H1, as
 * refined). A queued hit is never turned into nothing, and it is told
 * UNNAMED only on contrary evidence: `presence` is the answer in hand — a
 * fresh cache, or the one bounded refresh the relay makes — and an answer
 * that omits the teammate (opted out, muted, or a session that simply ended:
 * presence cannot say which) tells the file without the name, branch or age.
 * A teammate the answer lists is named, with the branch and age of that
 * answer's row. `presence` is null when no answer could be had — a refresh
 * that failed or ran out of time — and then each group is named as the
 * tripwire's own answer named it at the edit, a row the hub had already put
 * through this developer's opt-out projection, but in the PAST tense and
 * with no branch and no age (round 3, F-L1): that row is as old as the
 * subagent's run, and its location is exactly what an opt-out since would
 * withhold. The outcome depends on the answer alone, never on how old a
 * cache was.
 */
export const relayedCollisions = (
  groups: readonly CollisionNotice[],
  presence: readonly PresenceFact[] | null,
  now: Date,
): readonly RenderableCollision[] =>
  groups.map((group) => {
    if (presence === null) {
      return unconfirmedCollision(group);
    }
    const entry = confirmingEntry(group, presence);
    return entry === undefined ? anonymousCollision(group) : withoutStaleLocation(locatedBy(group, entry), now);
  });

/** The renderer's own tail for the groups a bounded output does not name. */
const moreLine = (count: number): string =>
  `crosscheck: +${String(count)} more teammate overlap${count === 1 ? "" : "s"} not shown`;

/** The tail, when anything goes unnamed. */
const moreTail = (count: number): readonly string[] => (count > 0 ? [moreLine(count)] : []);

/**
 * The ONE line for a relay that names nobody (round 3, F-L2): only groups the
 * record had to let go of are left, and "+3 more … not shown" with nothing
 * shown above it told the person nothing. What is known is said: a subagent
 * ran into this many overlaps, and the details are gone.
 */
const countOnlyLine = (count: number): string =>
  `crosscheck: a subagent ran into ${countOf(count, "teammate overlap")} whose details were not kept — ` +
  "talk to your team before you merge";

/**
 * The person's lines that fit: at most COLLISION_NOTICE_MAX_LINES, and each
 * candidate keeps room for the tail line ITS OWN rest would need — the count
 * of lines left out plus `hidden` (groups the record could not keep) — so the
 * whole, tail included, stays inside COLLISION_NOTICE_MAX_CHARS.
 */
const fittedLines = (lines: readonly string[], hidden: number): readonly string[] =>
  lines.slice(0, COLLISION_NOTICE_MAX_LINES).reduce<readonly string[]>((fitted, line) => {
    const candidate = [...fitted, line];
    const rest = lines.length - candidate.length + hidden;
    const room = rest > 0 ? moreLine(rest).length + 1 : 0;
    return candidate.join("\n").length + room <= COLLISION_NOTICE_MAX_CHARS ? candidate : fitted;
  }, []);

/**
 * Several groups, one line each — the shape a hook's `systemMessage` carries —
 * at most COLLISION_NOTICE_MAX_LINES of them and COLLISION_NOTICE_MAX_CHARS in
 * all (review L4), whole lines only, the rest counted on a line of their own:
 * a cut line would lose the "talk before" half that is the point of it.
 * `hidden` counts groups that never reached this render at all (a relay
 * queue the record had to cut; state/session-state.ts) into the same tail.
 */
export const renderCollisionNotices = (groups: readonly RenderableCollision[], now: Date, hidden = 0): string => {
  if (groups.length === 0) {
    return hidden > 0 ? countOnlyLine(hidden) : "";
  }
  const lines = groups.map((group) => renderCollisionNotice(group, now));
  const kept = fittedLines(lines, hidden);
  return [...kept, ...moreTail(lines.length - kept.length + hidden)].join("\n");
};

/**
 * What the MAIN thread is handed for groups its subagents ran into: a header
 * saying where they came from, the person-facing line for EVERY group (the
 * facts, in the renderer's words), and the one relay sentence. Uncapped
 * (round 2, L10): the person's copy keeps its few lines and its `+N more`,
 * but the groups past that cap are drained and marked told all the same, so
 * the agent is the one place the rest are named — at most the
 * MAX_COLLISION_NOTICES groups a session remembers. Empty when there is
 * nothing to relay.
 */
export const renderSubagentCollisionRelay = (
  groups: readonly RenderableCollision[],
  now: Date,
  hidden = 0,
): string => {
  if (groups.length === 0) {
    return hidden > 0 ? [SUBAGENT_RELAY_HEADER, countOnlyLine(hidden), COUNT_ONLY_RELAY_SENTENCE].join("\n") : "";
  }
  return [
    SUBAGENT_RELAY_HEADER,
    ...groups.map((group) => renderCollisionNotice(group, now)),
    ...moreTail(hidden),
    COLLISION_RELAY_SENTENCE,
  ].join("\n");
};

interface OverlapPerson {
  readonly developerId: string;
  readonly name: string;
  readonly files: ReadonlySet<string>;
  readonly fileCount: number;
}

/** One person per developer: their groups folded, files counted once. */
const byPerson = (groups: readonly CollisionNotice[]): readonly OverlapPerson[] =>
  groups.reduce<readonly OverlapPerson[]>((people, group) => {
    const known = people.find((person) => person.developerId === group.developerId);
    if (known === undefined) {
      return [
        ...people,
        { developerId: group.developerId, name: group.name, files: new Set(group.files), fileCount: group.fileCount },
      ];
    }
    const files = new Set([...known.files, ...group.files]);
    return people.map((person) =>
      person === known
        ? { ...known, files, fileCount: Math.max(known.fileCount, group.fileCount, files.size) }
        : person,
    );
  }, []);

/** `3 files`, `1 teammate`: a count and its noun. */
const countOf = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

const personLabel = (person: OverlapPerson): string => {
  const count = Math.max(person.fileCount, person.files.size);
  const name = capped(displayName(person.name), STATUSLINE_NAME_CHARS);
  return `${name} · ${countOf(count, "file")}`;
};

/**
 * The people live presence does NOT confirm, counted and never named (round
 * 2, M1): `1 teammate · 3 files`, or `+1 teammate · 3 files` after the
 * names. Files counted once across them, plus the files a record holds only
 * as a count (a ghost row's sample is a bounded head).
 */
const unnamedLabel = (people: readonly OverlapPerson[], afterNames: boolean): string => {
  const files = new Set(people.flatMap((person) => [...person.files]));
  const countedOnly = people.reduce((total, person) => total + Math.max(0, person.fileCount - person.files.size), 0);
  return `${afterNames ? "+" : ""}${countOf(people.length, "teammate")} · ${countOf(files.size + countedOnly, "file")}`;
};

/**
 * The statusline's overlap indicator — `⚠ overlap: Mike · 3 files` — or "" when
 * this session told its person about nobody. People, not groups; at most
 * COLLISION_INDICATOR_MAX_NAMES by name, the rest counted, the whole bounded.
 * No branch, ever: the indicator outlives the moment the row was projected.
 *
 * NAMED ONLY WHILE PRESENCE LISTS THEM (review M2): `presence` is the answer
 * the same statusline line is drawn from — [] when the hub could not be read
 * or a booked 401 makes the cache untrustworthy — and a teammate it does not
 * list (opted out, muted, offline, ended) is COUNTED, never named (round 2,
 * M1): the pilot's collision was with a teammate who was offline, and an
 * indicator that showed nothing then showed nothing in the one case it exists
 * for.
 */
export const renderOverlapIndicator = (
  groups: readonly CollisionNotice[],
  presence: readonly { readonly developerId: string; readonly isSelf: boolean }[],
): string => {
  const people = byPerson(groups);
  if (people.length === 0) {
    return "";
  }
  const listed = new Set(stillPresent(groups, presence).map((group) => group.developerId));
  const named = people.filter((person) => listed.has(person.developerId));
  const unnamed = people.filter((person) => !listed.has(person.developerId));
  const shown = named.slice(0, COLLISION_INDICATOR_MAX_NAMES).map(personLabel).join(", ");
  const rest = named.length - Math.min(named.length, COLLISION_INDICATOR_MAX_NAMES);
  const names = shown.length === 0 ? "" : `${shown}${rest > 0 ? ` +${String(rest)}` : ""}`;
  const counted = unnamed.length === 0 ? "" : unnamedLabel(unnamed, names.length > 0);
  const segment = [names, counted].filter((part) => part.length > 0).join(", ");
  return capped(`⚠ overlap: ${segment}`, COLLISION_INDICATOR_MAX_CHARS);
};
