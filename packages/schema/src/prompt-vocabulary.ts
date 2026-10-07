/**
 * THE CLOSED CLASSES a prompt without a task is made of (DESIGN.md §4,
 * hold-out review H1). English and German — the languages the stop lists
 * cover — written folded (lower case, accents off, ß as ss), the way
 * session-control.ts reads every word. Function words are not here: they
 * come from the database's own lists (stop-words.ts).
 *
 * A STEERING word never names a task anywhere and is never a shared term:
 * assent, thanks, politeness, sequencing. A CONTINUATION TRIGGER carries the
 * session's work on. META words are the session's own machinery and its
 * clock — a limit, its window, that it is back. CONVERSATION CONTROL
 * interrupts, shapes or re-asks for an answer, or picks among the agent's
 * own options. AGENT OPERATION is a command to the agent with no object of
 * its own. Meta, conversation and operation words stay terms in a prompt
 * that names a task — "run the checkout e2e tests" is about tests — and only
 * the verdict reads them as classes (prompt-terms.ts).
 */

export const CONTINUATION_TRIGGERS: readonly string[] = [
  "continue", "continues", "continuing", "resume", "resuming", "proceed", "carry", "keep", "going",
  "ahead", "try", "weiter", "weida", "weitermachen", "weiterarbeiten", "weitergehen", "fortfahren",
  "fortsetzen", "fahre", "fahr", "fort", "wiederaufnehmen", "versuch", "versuche", "versuchen",
  "probier", "probiere", "probieren", "mach", "mache", "machen",
  // round 3, H1: the inflections a report of carrying on is written in
  "continued", "keeps", "kept", "tried", "tries", "retrying", "resumed",
];

/**
 * CONTINUATION SIGNALS (hold-out review round 4, C1): what carries the
 * session's work on, anywhere in a prompt — and a prompt that says one gets
 * no hint at all, whatever else it says (continuation.ts). Narrower than the
 * triggers above, which only read a prompt's verdict: "mach" and "keep" name
 * tasks ("mach den token refresh fix", "keep the old signing key"), so they
 * signal only in the phrases below. The first list signals anywhere and
 * takes every slip a trigger takes. The second signals only in a CLAUSE that
 * says nothing else — "…, next", "passt so", "na dann mal los" — and only
 * with the swapped pair as a slip: "next quarter", "die Größe passt nicht",
 * "wenn viel los ist" and Spanish "los usuarios" are words of a task, and one
 * key from "passt" is "pass".
 */
export const CONTINUATION_SIGNAL_WORDS: readonly string[] = [
  "continue", "continues", "continuing", "continued", "proceed", "proceeding", "weiter", "weida",
  "wiiter", "weitermachen", "weitergehen", "weiterarbeiten", "fortfahren", "fortsetzen",
];
export const CONTINUATION_CLAUSE_WORDS: readonly string[] = ["next", "los", "passt"];
/**
 * Words in a row that carry the session on, folded. Round 4 (M1) added the
 * point the work stopped at — "pick up where you stopped", "mach da weiter
 * wo du aufgehört hast" — and the retry — "try again", "nochmal versuchen" —
 * since a task's meta words count now: "ok limit reset, pick up where you
 * stopped" and "rate limited again lol, try again" reached the rate-limit
 * trees on "limit" and "rate".
 */
export const CONTINUATION_PHRASES: readonly (readonly string[])[] = [
  ["carry", "on"], ["go", "ahead"], ["go", "on"], ["keep", "going"], ["keep", "at"], ["fahr", "fort"],
  ["leg", "los"], ["los", "gehts"], ["los", "geht"],
  ["pick", "up", "where"], ["where", "you", "stopped"], ["where", "you", "left", "off"], ["where", "we", "left", "off"],
  ["where", "we", "left", "it", "off"], ["where", "you", "were"], ["where", "we", "were"], ["wo", "du", "aufgehort"],
  ["wo", "wir", "aufgehort"], ["wo", "du", "warst"], ["wo", "wir", "waren"], ["wo", "wir", "stehengeblieben"],
  ["try", "again"], ["try", "it", "again"], ["nochmal", "versuchen"], ["versuch", "es", "nochmal"], ["versuchs", "nochmal"],
];

/**
 * FILLER AND DICTATION (hold-out review round 3, H1): what speech-to-text and
 * a hesitating hand leave in a prompt — "ähm", "hm", the dictated
 * punctuation ("Komma", "Punkt", "Fragezeichen", "neue Zeile", "period"),
 * an apology, a filler assent or no ("jaja", "joa", "nee") and the filler
 * nouns of "sure thing" and "weiter im Text". Like a steering word it never
 * names a task and is never a term; "ok" and "okay" stay steering words.
 */
export const FILLER_WORDS: readonly string[] = [
  "ahm", "ahh", "uhm", "umm", "uhh", "hmm", "komma", "punkt", "fragezeichen", "ausrufezeichen",
  "doppelpunkt", "neue", "zeile", "absatz", "comma", "period", "sorry", "sry", "jaja", "joa", "nee",
  "thing", "text",
];

export const OTHER_STEERING: readonly string[] = [
  "please", "pls", "plz", "okay", "okey", "oki", "okie", "okidoki", "yes", "yeah", "yep", "yup",
  "jup", "jep", "yea", "nope", "nah", "sure", "thanks", "thank", "thx", "cheers", "merci", "cool",
  "great", "good", "fine", "perfect", "nice", "awesome", "excellent", "sounds", "looks", "lgtm",
  "ship", "next", "step", "let", "lets", "alright", "hmm", "mhm", "aha", "gut", "bitte", "danke",
  "dankeschon", "dank", "vielen", "gerne", "gern", "super", "perfekt", "passt", "klar", "prima",
  "toll", "nochmal", "erneut", "einfach", "schon", "scho", "mal", "los", "nachsten", "nachste",
  "nachster", "naechsten", "naechste", "naechster", "schritt", "schritte", "einverstanden",
  "umsetzen", "klingt", "genau", "jawohl", "jawoll", "ok", "ja",
];

export const META_WORDS: readonly string[] = [
  "limit", "limits", "usage", "rate", "quota", "quotas", "kontingent", "session", "sessions",
  "sitzung", "token", "tokens", "context", "kontext", "retry", "retries", "restart", "restarts",
  "neustart", "nutzung", "reset", "resets", "zurucksetzen", "zuruecksetzen", "zuruckgesetzt",
  "zurueckgesetzt", "back", "frei", "available", "verfugbar", "cleared", "lifted", "renewed",
  "refilled", "restored", "refreshed", "erneuert", "voll", "expired", "expire", "expires",
  "abgelaufen", "gone", "vorbei", "weekly", "daily", "hourly", "minute", "minutes", "hour", "hours",
  "minuten", "stunde", "stunden", "ago", "vorhin", "gerade", "eben", "today", "heute", "window",
  "left", "aufgehort",
  // round 3, H1: the clock and the limit reports the round-3 set showed missing
  "earlier", "vorher", "gleich", "uhr", "sec", "secs", "hit", "erreicht",
];

/**
 * WEAK WORDS (hold-out review round 4, decision 3): generic development words
 * that never count as TOPICAL on their own. Unlike the closed classes they
 * make no prompt content-free — "add pagination" is a task — and they stay
 * terms, so one can be the second shared word beside a topical one; but a
 * statement that shares only weak words and words that are never terms
 * clears nothing. Built from the round-4 hold-out's failures — "add
 * pagination to the users admin table" was shown the SSO tree's decision on
 * add and users, "add an endpoint GET /v1/me that returns the current user"
 * the thumbnail tree's on get and user, "upgrade react to 19" was pointed at
 * the Gradle tree, a log paste reached the date-picker tree on "new" — and
 * the reviewer's list, plus judgement; measured over the corpus and both
 * hold-outs, it costs no task its right tree and removes 16 wrong trees from
 * the floor. Folded, inflections written out. Kept OUT on purpose: the words
 * M1 names as topics of a task (token, rate, limit, refresh, deploy, logs),
 * "test", "build", "fails", which the right trees share, and "time(s)" and
 * "start", which name topics in "times out" and "cold start". A four-digit
 * year 1900–2099 is weak as well (prompt-terms.ts), a status code is not.
 */
export const WEAK_WORDS: readonly string[] = [
  // the reviewer's verbs and their forms
  "add", "adds", "added", "adding", "update", "updates", "updated", "updating", "upgrade", "upgrades",
  "upgraded", "upgrading", "remove", "removes", "removed", "removing", "change", "changes", "changed",
  "changing", "create", "creates", "created", "creating", "get", "gets", "getting", "set", "sets", "use",
  "uses", "used", "using", "make", "makes", "making", "made", "handle", "handles", "handled", "handling",
  "support", "supports", "supported", "supporting",
  // the reviewer's nouns
  "new", "newer", "user", "users", "page", "pages", "maximum", "max", "minimum", "min", "size", "sizes",
  "file", "files", "data", "value", "values", "item", "items", "list", "lists", "version", "versions",
  // judgement: a task's generic verbs, the work and its parts
  "need", "needs", "needed", "want", "wants", "wanted", "work", "works", "worked", "working", "implement",
  "implements", "implemented", "implementing", "fix", "fixes", "fixed", "fixing", "write", "writes",
  "writing", "written", "run", "runs", "running", "ran", "show", "shows", "showing", "shown", "check",
  "checks", "checked", "checking", "review", "reviews", "reviewed", "pr", "prs", "call", "calls", "called",
  "return", "returns", "returned", "returning", "old", "number", "numbers", "field", "fields",
  "things", "stuff", "way", "ways", "current", "currently", "issue", "issues", "problem",
  "problems", "bug", "bugs", "error", "errors", "feature", "features", "code", "part", "parts", "case",
  "cases", "option", "options", "first", "second", "third", "last", "best", "more", "less", "done",
  "ready", "right", "correct", "detail", "details",
  // German
  "neu", "neuen", "neuer", "neues", "hinzufugen", "hinzugefugt", "andern", "geandert", "anderung",
  "anderungen", "erstellen", "erstellt", "nutzer", "benutzer", "seite", "seiten", "datei", "dateien",
  "daten", "wert", "werte", "liste", "listen", "fehler", "probleme", "aktuell", "aktuelle", "funktioniert",
];

/**
 * RESTART VERBS (hold-out review round 3, C1): what sets the session's own
 * work going again. They keep their classes — "retry" and "restart" are meta
 * words, "rerun" an operation, "resume" a trigger — and the verdict reads one
 * beside nothing but meta words as a command: "rate limit is gone, retry",
 * "restart the session". Beside a topic it is about that topic: "retry limit
 * for failed imports is too low".
 */
export const RESTART_VERBS: readonly string[] = [
  "retry", "retries", "rerun", "restart", "restarts", "resume", "resuming", "neustart",
];

export const CONVERSATION_CONTROL: readonly string[] = [
  "wait", "waiting", "stop", "stopp", "hold", "hang", "pause", "halt", "cancel", "abort", "warte",
  "warten", "moment", "kurz", "nein", "abbrechen", "never", "mind", "forget", "egal", "shorter",
  "short", "longer", "kurzer", "langer", "more", "mehr", "less", "weniger", "detail", "details",
  "detailed", "ausfuhrlicher", "genauer", "simpler", "clearer", "explain", "explanation", "erklar",
  "erklare", "erklaren", "summarize", "summary", "zusammenfassung", "rephrase", "think", "denk",
  "denke", "nachdenken", "harder", "deeper", "better", "besser", "again", "repeat", "wiederhole",
  "deutsch", "german", "english", "englisch", "translate", "option", "options", "variante",
  "varianten", "alternative", "first", "second", "third", "last", "one", "ones", "erste", "ersten",
  "zweite", "zweiten", "dritte", "dritten", "letzte", "beides", "beide", "everything", "whatever",
  "anything", "take", "nimm", "choose", "pick", "decide", "entscheide", "entscheiden", "call",
  "best", "update", "updates", "news", "done", "fertig", "ready", "start", "vorne", "right",
  "richtig", "korrekt", "correct", "stimmt", "exactly", "agreed", "agree", "fair", "enough",
  "sense", "makes", "got", "understood", "verstanden", "reasonable", "vernunftig", "wunderbar",
  "top", "absolutely", "definitely", "indeed", "noted", "actually", "really", "maybe", "perhaps",
  "still", "simply",
  // round 3, H1: German forms of words above the round-3 set showed missing
  "einfacher", "entscheidest",
];

export const AGENT_OPERATION: readonly string[] = [
  "commit", "commits", "committen", "push", "pushen", "pull", "merge", "mergen", "rebase", "revert",
  "reverten", "undo", "redo", "delete", "remove", "losch", "losche", "loschen", "save", "speicher",
  "speichere", "speichern", "write", "schreib", "schreibe", "schreiben", "run", "rerun", "laufen",
  "lass", "test", "tests", "testen", "lint", "linter", "format", "diff", "status", "review",
  "deploy", "deployen", "build", "bauen", "check", "checks", "prufe", "prufen", "log", "logs",
  "show", "zeig", "zeige", "zeigen", "schau", "open", "offne", "close", "git", "main", "master",
  "fix", "fixen", "compile", "typecheck", "pr", "prs",
  // round 3, H1: forms of the operations above, and the harness's own compact
  "committe", "pushe", "lassen", "getestet", "tested", "compact",
];

/**
 * WORDS OF THEIR OWN within a slip of a class word (typing-slip.ts): real
 * words the system dictionary and a German sample show one slip away from a
 * trigger, a steering word or a meta word — "rest" from "reset", "contest"
 * from "context", "writer" from "weiter", "bitter" from "bitte". A word here
 * is never read as a slip. Derived, not curated: session-control.test.ts
 * fails on a dictionary word that maps and is missing here, and on an entry
 * that no longer maps.
 */
export const NEAR_MISS_WORDS: readonly string[] = [
  // the system dictionary
  "carr", "carty", "cary", "cleaded", "confine", "confining", "conine", "contect", "contest",
  "continuer", "cotinus", "dail", "expiree", "expirer", "fare", "genre", "genua", "ging",
  "gong", "grade", "greta", "hurly", "lifter", "mace", "minuet", "minuter", "prefect", "probeer",
  "prober", "proceeds", "quot", "redstart", "reeming", "reest", "reet", "refill", "refresh",
  "refresher", "renewer", "resing", "rest", "restate", "restes", "restore", "restorer", "resue",
  "resuing", "resumer", "retired", "retorted", "rewet", "stude", "toady", "toda", "tody", "toke",
  "tooken", "usager", "widow", "windrow", "winrow", "writer",
  // round 3's trigger inflections and four-letter swaps
  "confined", "frot", "kees", "rering", "restring", "retrain", "retting", "retying", "tied", "tired", "trier",
  // the German sample
  "weitere", "weitet", "masche", "macher", "probiert", "probierte", "resumee", "verfugbare",
  "abgelaufene", "fahrer", "gerader", "kontinent", "kontingenz",
];
