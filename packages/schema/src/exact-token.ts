/**
 * A PROMPT WORD AS THE EXACT TIER MATCHES IT against a teammate's targets
 * (DESIGN.md §6; hold-out review round 5, M1 and M4).
 *
 * M1 — A PATH AS A STACK TRACE OR A LINK WRITES IT is still the path: "at
 * PermissionsGuard.canActivate (packages/api/src/auth/permissions.ts:27:13)"
 * named the file the permissions tree touched, and its "(…:27:13)" matched no
 * target. The wrapping punctuation, a ":line" or ":line:col", a "#L12" or
 * "#L12-L20" and a "file://" come off before the match — on the hub, whose
 * exact tier matches the whole word, and on the connector, which sends a long
 * prompt's paths whole: one function, so the two cannot drift.
 *
 * M4 — A CONVENTIONAL FILE NAME is in every repo: "Dockerfile" matched the
 * Docker tree's "docker/postgres/Dockerfile" for "bump node to 22 in .nvmrc
 * and the Dockerfile", which shares no word with it. Such a match is a fact
 * about the name, not the work, and the hub keeps it only beside a shared
 * topical word (server services/hints.ts).
 */

/** What a sentence or a trace puts before a path: brackets, quotes, backticks. */
const WRAP_START = /^[("'`[{<„“”‘’«]+/u;

/** What a sentence or a trace puts after one: closing brackets and quotes, sentence marks. */
const WRAP_END = /[()"'`\]}>„“”‘’»,;:.!?]+$/u;

/** A file URL's scheme: "file:///repo/src/a.ts". */
const FILE_URL = /^file:\/\//iu;

/** A line anchor: "#L12", "#L12-L20", "#L12-20" — in any case, since the hub lower-cases first. */
const LINE_ANCHOR = /#L\d+(?:-L?\d+)?$/iu;

/** A trace's position: ":27", ":27:13". */
const LINE_COLUMN = /:\d+(?::\d+)?$/u;

/** One whitespace word as the exact tier matches it: the path it writes, its position and wrapping off. */
export const exactTargetToken = (word: string): string =>
  word
    .replace(WRAP_START, "")
    .replace(WRAP_END, "")
    .replace(FILE_URL, "")
    .replace(LINE_ANCHOR, "")
    .replace(LINE_COLUMN, "")
    .replace(WRAP_END, "");

/** File names nearly every repository has, lower-cased as the exact tier compares them (M4). */
export const CONVENTIONAL_FILE_NAMES: readonly string[] = [
  "dockerfile", "makefile", "package.json", "readme.md", "index.ts", "docker-compose.yml", "tsconfig.json", ".gitignore", ".nvmrc",
];

const CONVENTIONAL: ReadonlySet<string> = new Set(CONVENTIONAL_FILE_NAMES);

/** A conventional file name, as a prompt names it: "Dockerfile", "package.json". */
export const isConventionalFileName = (token: string): boolean => CONVENTIONAL.has(token.toLowerCase());
