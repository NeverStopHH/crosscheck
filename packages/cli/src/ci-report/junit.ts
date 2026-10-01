/**
 * THE RUNNER'S OWN REPORT, READ STRUCTURALLY (spec 05 §3.4).
 *
 * `bun test --reporter=junit` writes one `<testsuite>` per file directly under
 * `<testsuites>`, and one nested `<testsuite>` per `describe` below it —
 * outermost first, singly escaped. The same chain also rides on every
 * `<testcase>` as `classname`, but INNERMOST first and double-escaped
 * (`inner &amp;gt; outer`), so recovering it from there needs a reversal and a
 * second un-escape, and the reversal silently corrupts any describe name that
 * legitimately contains `>`. Measured on bun 1.3.13 over a probe file; the
 * fixture in test/ci-report-junit.test.ts is that output verbatim. This
 * reader takes the ancestry and never looks at `classname`.
 *
 * WHAT IS READ, AND WHAT IS NOT. A case is its file, its chain, its name, its
 * status and its duration. `<failure>` and `<error>` are read for PRESENCE
 * only — never their message or body, because a failure message quotes source
 * text and content-derived text on the hub is what #6 forbids. `hostname`
 * rides on every suite element and is never read. `line` moves on any edit
 * above the test and is never read either.
 *
 * NO DEPENDENCY. The input is one machine-written file of a fixed shape, and
 * a full XML parser on a CI runner for it would be a dependency the hub does
 * not need and the reporter cannot vet. The tokenizer below handles the
 * constructs such a file can contain — declarations, comments, CDATA (bun
 * emits none today, but `<system-out>` is the conventional home for console
 * text) and quoted attributes — and REFUSES anything unbalanced: a runner
 * that died mid-write leaves a truncated file, and a truncated file read to
 * its last complete case would report a run that never finished as one that
 * did (§3.3's rule, at the source).
 */

export type JunitCaseStatus = "passed" | "failed" | "errored" | "skipped";

export interface JunitCase {
  readonly file: string;
  /** The describe chain, OUTERMOST first, from the `<testsuite>` ancestry. */
  readonly chain: readonly string[];
  readonly name: string;
  readonly status: JunitCaseStatus;
  readonly durationMs: number;
}

export interface JunitRun {
  /** Totals as the runner counted them, off the `<testsuites>` root. */
  readonly tests: number;
  /** `failures` plus `errors`: the wire has no third counter. */
  readonly failures: number;
  readonly skipped: number;
  readonly durationMs: number;
  readonly cases: readonly JunitCase[];
}

export type JunitParseResult =
  | { readonly ok: true; readonly run: JunitRun }
  | { readonly ok: false; readonly reason: string };

const MS_PER_SECOND = 1000;

/**
 * The file suite's depth in the `<testsuite>` stack. bun writes the file's
 * own suite directly under the root and every `describe` below it, so the
 * chain is everything deeper than this.
 */
const FILE_SUITE_DEPTH = 1;

const ROOT_ELEMENT = "testsuites";
const SUITE_ELEMENT = "testsuite";
const CASE_ELEMENT = "testcase";

/** Marker child → status; `failure` outranks `error` outranks `skipped`. */
const MARKER_STATUS: Readonly<Record<string, JunitCaseStatus>> = {
  failure: "failed",
  error: "errored",
  skipped: "skipped",
};
const STATUS_RANK: Readonly<Record<JunitCaseStatus, number>> = {
  passed: 0,
  skipped: 1,
  errored: 2,
  failed: 3,
};

const ATTRIBUTE_PATTERN = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY_PATTERN = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Exactly ONE un-escape, which is what a singly-escaped attribute needs. */
const decodeEntities = (raw: string): string =>
  raw.replace(ENTITY_PATTERN, (whole, entity: string) => {
    const named = NAMED_ENTITIES[entity];
    if (named !== undefined) {
      return named;
    }
    const codePoint = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
  });

interface OpenTag {
  readonly kind: "open";
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly selfClosing: boolean;
}

interface CloseTag {
  readonly kind: "close";
  readonly name: string;
}

type Tag = OpenTag | CloseTag;

/** Tags in document order, or the reason the document could not be read. */
type Tokenized =
  | { readonly ok: true; readonly tags: readonly Tag[] }
  | { readonly ok: false; readonly reason: string };

/** Constructs that carry no structure: skipped from their opener to `terminator`. */
const SKIPPED_CONSTRUCTS: readonly { opener: string; terminator: string }[] = [
  { opener: "<!--", terminator: "-->" },
  { opener: "<![CDATA[", terminator: "]]>" },
  { opener: "<?", terminator: "?>" },
  { opener: "<!", terminator: ">" },
];

const parseOpenTag = (body: string): OpenTag => {
  const selfClosing = body.endsWith("/");
  const inner = selfClosing ? body.slice(0, -1) : body;
  const name = /^[^\s/>]+/.exec(inner)?.[0] ?? "";
  const attributes = new Map<string, string>();
  for (const match of inner.slice(name.length).matchAll(ATTRIBUTE_PATTERN)) {
    const [, key, doubleQuoted, singleQuoted] = match;
    if (key !== undefined) {
      attributes.set(key, decodeEntities(doubleQuoted ?? singleQuoted ?? ""));
    }
  }
  return { kind: "open", name, attributes, selfClosing };
};

/** The index just past the `>` closing a tag opened at `start`, honouring quotes. */
const tagEnd = (xml: string, start: number): number => {
  let quote: string | null = null;
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return -1;
};

const tokenize = (xml: string): Tokenized => {
  const tags: Tag[] = [];
  let index = xml.indexOf("<");
  while (index >= 0) {
    const skipped = SKIPPED_CONSTRUCTS.find(({ opener }) =>
      xml.startsWith(opener, index),
    );
    if (skipped !== undefined) {
      const end = xml.indexOf(skipped.terminator, index + skipped.opener.length);
      if (end < 0) {
        return { ok: false, reason: `unterminated ${skipped.opener}` };
      }
      index = xml.indexOf("<", end + skipped.terminator.length);
      continue;
    }
    const end = tagEnd(xml, index);
    if (end < 0) {
      return { ok: false, reason: "unterminated tag at end of file" };
    }
    const body = xml.slice(index + 1, end - 1).trim();
    tags.push(
      body.startsWith("/")
        ? { kind: "close", name: body.slice(1).trim() }
        : parseOpenTag(body),
    );
    index = xml.indexOf("<", end);
  }
  return { ok: true, tags };
};

const secondsToMs = (raw: string | undefined): number | null => {
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds * MS_PER_SECOND)
    : null;
};

const count = (raw: string | undefined, fallback?: number): number | null => {
  if (raw === undefined) {
    return fallback ?? null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

interface RootTotals {
  readonly tests: number;
  readonly failures: number;
  readonly skipped: number;
  readonly durationMs: number;
}

const readRootTotals = (
  attributes: ReadonlyMap<string, string>,
): RootTotals | string => {
  const tests = count(attributes.get("tests"));
  const failures = count(attributes.get("failures"));
  const errors = count(attributes.get("errors"), 0);
  const skipped = count(attributes.get("skipped"));
  const durationMs = secondsToMs(attributes.get("time"));
  if (tests === null || failures === null || errors === null) {
    return "<testsuites> tests/failures/errors are not non-negative integers";
  }
  if (skipped === null) {
    return "<testsuites> skipped is not a non-negative integer";
  }
  if (durationMs === null) {
    return "<testsuites> time is not a non-negative number of seconds";
  }
  return { tests, failures: failures + errors, skipped, durationMs };
};

interface Suite {
  readonly name: string;
  readonly file: string;
}

interface PendingCase {
  readonly file: string;
  readonly chain: readonly string[];
  readonly name: string;
  readonly durationMs: number;
  readonly status: JunitCaseStatus;
}

/** The walk's state between tags — replaced, never mutated in place. */
interface Walk {
  readonly open: readonly string[];
  readonly suites: readonly Suite[];
  readonly pending: PendingCase | null;
  readonly totals: RootTotals | null;
  readonly cases: readonly JunitCase[];
}

const EMPTY_WALK: Walk = {
  open: [],
  suites: [],
  pending: null,
  totals: null,
  cases: [],
};

const openCase = (walk: Walk, tag: OpenTag): PendingCase | string => {
  const fileSuite = walk.suites[FILE_SUITE_DEPTH - 1];
  const file = tag.attributes.get("file") ?? fileSuite?.file ?? "";
  const name = tag.attributes.get("name");
  const durationMs = secondsToMs(tag.attributes.get("time") ?? "0");
  if (name === undefined) {
    return "<testcase> without a name";
  }
  if (durationMs === null) {
    return `<testcase> ${name}: time is not a number of seconds`;
  }
  return {
    file,
    chain: walk.suites.slice(FILE_SUITE_DEPTH).map((suite) => suite.name),
    name,
    durationMs,
    status: "passed",
  };
};

const finished = (pending: PendingCase): JunitCase => ({
  file: pending.file,
  chain: pending.chain,
  name: pending.name,
  status: pending.status,
  durationMs: pending.durationMs,
});

const applyOpen = (walk: Walk, tag: OpenTag): Walk | string => {
  const open = tag.selfClosing ? walk.open : [...walk.open, tag.name];
  if (tag.name === ROOT_ELEMENT) {
    const totals = readRootTotals(tag.attributes);
    return typeof totals === "string" ? totals : { ...walk, open, totals };
  }
  if (tag.name === SUITE_ELEMENT) {
    const name = tag.attributes.get("name") ?? "";
    const suite = { name, file: tag.attributes.get("file") ?? name };
    return tag.selfClosing
      ? walk
      : { ...walk, open, suites: [...walk.suites, suite] };
  }
  if (tag.name === CASE_ELEMENT) {
    const pending = openCase(walk, tag);
    if (typeof pending === "string") {
      return pending;
    }
    return tag.selfClosing
      ? { ...walk, open, cases: [...walk.cases, finished(pending)] }
      : { ...walk, open, pending };
  }
  const marker = MARKER_STATUS[tag.name];
  if (marker !== undefined && walk.pending !== null) {
    const status =
      STATUS_RANK[marker] > STATUS_RANK[walk.pending.status]
        ? marker
        : walk.pending.status;
    return { ...walk, open, pending: { ...walk.pending, status } };
  }
  return { ...walk, open };
};

const applyClose = (walk: Walk, tag: CloseTag): Walk | string => {
  const expected = walk.open[walk.open.length - 1];
  if (expected !== tag.name) {
    return `unbalanced: </${tag.name}> closes <${expected ?? "nothing"}>`;
  }
  const open = walk.open.slice(0, -1);
  if (tag.name === SUITE_ELEMENT) {
    return { ...walk, open, suites: walk.suites.slice(0, -1) };
  }
  if (tag.name === CASE_ELEMENT && walk.pending !== null) {
    return {
      ...walk,
      open,
      pending: null,
      cases: [...walk.cases, finished(walk.pending)],
    };
  }
  return { ...walk, open };
};

export const parseJunit = (xml: string): JunitParseResult => {
  const tokenized = tokenize(xml);
  if (!tokenized.ok) {
    return tokenized;
  }
  let walk: Walk = EMPTY_WALK;
  for (const tag of tokenized.tags) {
    const next =
      tag.kind === "open" ? applyOpen(walk, tag) : applyClose(walk, tag);
    if (typeof next === "string") {
      return { ok: false, reason: next };
    }
    walk = next;
  }
  if (walk.open.length > 0) {
    return {
      ok: false,
      reason: `unbalanced: <${walk.open.join("> <")}> never closed`,
    };
  }
  if (walk.totals === null) {
    return { ok: false, reason: "no <testsuites> root" };
  }
  return { ok: true, run: { ...walk.totals, cases: walk.cases } };
};
