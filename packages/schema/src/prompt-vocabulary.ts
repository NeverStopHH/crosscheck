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
];

export const AGENT_OPERATION: readonly string[] = [
  "commit", "commits", "committen", "push", "pushen", "pull", "merge", "mergen", "rebase", "revert",
  "reverten", "undo", "redo", "delete", "remove", "losch", "losche", "loschen", "save", "speicher",
  "speichere", "speichern", "write", "schreib", "schreibe", "schreiben", "run", "rerun", "laufen",
  "lass", "test", "tests", "testen", "lint", "linter", "format", "diff", "status", "review",
  "deploy", "deployen", "build", "bauen", "check", "checks", "prufe", "prufen", "log", "logs",
  "show", "zeig", "zeige", "zeigen", "schau", "open", "offne", "close", "git", "main", "master",
  "fix", "fixen", "compile", "typecheck", "pr", "prs",
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
  "continued", "continuer", "cotinus", "dail", "expiree", "expirer", "fare", "genre", "genua", "ging",
  "gong", "grade", "greta", "hurly", "lifter", "mace", "minuet", "minuter", "prefect", "probeer",
  "prober", "proceeds", "quot", "redstart", "reeming", "reest", "reet", "refill", "refresh",
  "refresher", "renewer", "resing", "rest", "restate", "restes", "restore", "restorer", "resue",
  "resuing", "resumer", "retired", "retorted", "rewet", "stude", "toady", "toda", "tody", "toke",
  "tooken", "usager", "widow", "windrow", "winrow", "writer",
  // the German sample
  "weitere", "weitet", "masche", "macher", "probiert", "probierte", "resumee", "verfugbare",
  "abgelaufene", "fahrer", "gerader", "kontinent", "kontingenz",
];
