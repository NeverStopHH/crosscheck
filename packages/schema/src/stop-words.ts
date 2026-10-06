/**
 * PostgreSQL's own stop lists, mirrored (DESIGN.md §4): `english.stop` and
 * `german.stop` from the snowball dictionaries the hub's full-text search
 * runs, copied verbatim out of PGlite 0.4.6's `tsearch_data`. Not a list
 * anyone maintains: server/test/hint-content-terms.test.ts asserts that the
 * database drops every word here and that each list is whole, so an upgrade
 * that changes either list fails a test instead of drifting.
 *
 * WHY A MIRROR: the connector decides "this prompt carried nothing" before
 * any call, and the shown sentence of a claim is chosen identically on both
 * sides — neither can ask the database, and both must answer as it would.
 */

export const ENGLISH_STOP_WORDS: ReadonlySet<string> = new Set([
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you", "your", "yours", "yourself",
  "yourselves", "he", "him", "his", "himself", "she", "her", "hers", "herself", "it", "its",
  "itself", "they", "them", "their", "theirs", "themselves", "what", "which", "who", "whom",
  "this", "that", "these", "those", "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing", "a", "an", "the", "and", "but",
  "if", "or", "because", "as", "until", "while", "of", "at", "by", "for", "with", "about",
  "against", "between", "into", "through", "during", "before", "after", "above", "below", "to",
  "from", "up", "down", "in", "out", "on", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "any", "both", "each", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "s", "t", "can", "will", "just", "don", "should", "now",
]);

export const GERMAN_STOP_WORDS: ReadonlySet<string> = new Set([
  "aber", "alle", "allem", "allen", "aller", "alles", "als", "also", "am", "an", "ander",
  "andere", "anderem", "anderen", "anderer", "anderes", "anderm", "andern", "anderr", "anders",
  "auch", "auf", "aus", "bei", "bin", "bis", "bist", "da", "damit", "dann", "der", "den", "des",
  "dem", "die", "das", "daß", "derselbe", "derselben", "denselben", "desselben", "demselben",
  "dieselbe", "dieselben", "dasselbe", "dazu", "dein", "deine", "deinem", "deinen", "deiner",
  "deines", "denn", "derer", "dessen", "dich", "dir", "du", "dies", "diese", "diesem", "diesen",
  "dieser", "dieses", "doch", "dort", "durch", "ein", "eine", "einem", "einen", "einer", "eines",
  "einig", "einige", "einigem", "einigen", "einiger", "einiges", "einmal", "er", "ihn", "ihm",
  "es", "etwas", "euer", "eure", "eurem", "euren", "eurer", "eures", "für", "gegen", "gewesen",
  "hab", "habe", "haben", "hat", "hatte", "hatten", "hier", "hin", "hinter", "ich", "mich", "mir",
  "ihr", "ihre", "ihrem", "ihren", "ihrer", "ihres", "euch", "im", "in", "indem", "ins", "ist",
  "jede", "jedem", "jeden", "jeder", "jedes", "jene", "jenem", "jenen", "jener", "jenes", "jetzt",
  "kann", "kein", "keine", "keinem", "keinen", "keiner", "keines", "können", "könnte", "machen",
  "man", "manche", "manchem", "manchen", "mancher", "manches", "mein", "meine", "meinem",
  "meinen", "meiner", "meines", "mit", "muss", "musste", "nach", "nicht", "nichts", "noch", "nun",
  "nur", "ob", "oder", "ohne", "sehr", "sein", "seine", "seinem", "seinen", "seiner", "seines",
  "selbst", "sich", "sie", "ihnen", "sind", "so", "solche", "solchem", "solchen", "solcher",
  "solches", "soll", "sollte", "sondern", "sonst", "über", "um", "und", "uns", "unse", "unsem",
  "unsen", "unser", "unses", "unter", "viel", "vom", "von", "vor", "während", "war", "waren",
  "warst", "was", "weg", "weil", "weiter", "welche", "welchem", "welchen", "welcher", "welches",
  "wenn", "werde", "werden", "wie", "wieder", "will", "wir", "wird", "wirst", "wo", "wollen",
  "wollte", "würde", "würden", "zu", "zum", "zur", "zwar", "zwischen",
]);

/**
 * GERMAN FUNCTION WORDS german.stop LACKS (hold-out review, M4). The snowball
 * list predates the 1996 spelling reform — it holds "daß", never "dass" — and
 * lists the auxiliaries and modals in only some of their forms ("hat" and
 * "kann", not "hast" or "kannst"; "würde", not "wurde"). It has no question
 * words ("warum", "wieso") and none of the filler verbs a chat prompt is
 * made of ("gibt", "geht", "glaube", "passt"). So "ja, das wurde so gemacht,
 * passt" kept four words and cleared the floor on any German tree that says
 * them. A small closed supplement for German text only; the database's own
 * list above stays the pinned mirror.
 */
export const GERMAN_STOP_SUPPLEMENT: ReadonlySet<string> = new Set([
  "dass", "wurde", "wurden", "wurdest", "hast", "hat", "gibt", "geht", "gehts", "warum", "wieso",
  "weshalb", "wer", "wohin", "woher", "gemacht", "gesehen", "glaube", "passt", "kannst", "musst",
  "sollst", "willst", "darfst", "seid", "wäre", "wär", "hätte", "hättest", "könntest", "würdest",
  "halt", "eigentlich", "ganz", "bisschen", "nen", "gell",
]);

/** What a German text drops: german.stop and its supplement. */
export const GERMAN_FUNCTION_WORDS: ReadonlySet<string> = new Set([...GERMAN_STOP_WORDS, ...GERMAN_STOP_SUPPLEMENT]);
