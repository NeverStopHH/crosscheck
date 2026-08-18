/**
 * Runs the repo's comments and checks that they say what their commands print.
 *
 * WHY THIS EXISTS. This branch produced eleven instances of one defect: a
 * comment stating behaviour its named command does not produce. Three rounds of
 * reading prose by hand each fixed instances and created others, and the pattern
 * in what survived was consistent — the MEASUREMENTS were fine, every command
 * printed what its comment said. What rotted were the quantifiers and the
 * pointers: "exactly one", "the ONLY", "2 of 8", "5 mutations", "lines
 * 312-321", and figures credited to a script that printed something narrower.
 * A human re-reading 72 claims will keep missing those. A script will not.
 *
 * THE CONVENTION. A comment block may carry a verification directive: a line
 * beginning `VERIFY:` that names a single-line shell command, followed by one
 * or more lines beginning `PRINTS:` that give, exactly, the stdout that command
 * produces — one such line per line of output.
 *
 * There is no mocked-up example here on purpose. An illustration written in the
 * directive's own syntax IS a directive as far as the scanner is concerned, and
 * the first draft of this header duly registered `<a single-line shell command>`
 * as claim number two and tried to run it. The working example is the real
 * directive at the foot of this header, which is also this file's own claim.
 *
 * It reads as documentation, which is the point — a reader who never runs this
 * script still learns how to check the claim. Any comment style works: the
 * scanner strips a leading `*`, `//` or `#` before matching, so the directive
 * looks the same in a TypeScript block comment and in a YAML file.
 *
 * CONTAINS instead of PRINTS relaxes the comparison to substring containment,
 * for a command whose output is inherently noisy — one that prints a platform
 * banner, an elapsed time, or a path that differs between machines. It is the
 * weaker check, so every use of it has to say at the call site WHY the command
 * cannot be pinned exactly.
 *
 * WHAT IS COMPARED, PRECISELY. Standard output only, with each line trimmed of
 * surrounding whitespace and leading and trailing blank lines dropped, against
 * the PRINTS lines given the same treatment. Two consequences worth knowing:
 *
 *   - A claim about leading whitespace cannot be written directly; pipe the
 *     command through something that makes the spaces visible.
 *   - The command's EXIT STATUS is ignored, deliberately. `grep -c` exits 1
 *     precisely when it prints `0`, and `0` is the expected output of one of
 *     the claims below. Requiring exit 0 would fail a correct claim.
 *
 * WHAT IS NOT IN HERE, AND WHY. Whole-suite mutation claims — "delete this
 * branch and the suite reports 308 pass / 11 fail" — stay prose with a named
 * command. Three reasons, in order of weight:
 *
 *   1. They EDIT THE TREE THEY ARE CHECKING. Every one restores in a `finally`,
 *      but a run killed between write and restore leaves a mutated source file,
 *      and every claim checked after that point would be measured against the
 *      wrong tree. A claim-checker that can corrupt its own subject is worse
 *      than no claim-checker.
 *   2. Each costs a full suite run. The dozen such claims in this branch would
 *      add several minutes to every pull request to re-prove what the
 *      `mutation` job already proves.
 *   3. Detection of exactly those defects IS already proved, on every pull
 *      request, by scripts/mutation-check.ts — which re-introduces each one and
 *      fails if the guarding test stays green.
 *
 * So the rule this script enforces is narrower than "every claim": every claim
 * whose command is fast, single-line and read-only. That covers the quantifiers
 * and the counts, which is where the defect actually lives.
 *
 * ITS OWN HEADER IS SUBJECT TO THE RULE, which is why the claim below is a
 * directive and not a sentence. `--list` prints the directives without running
 * them, so this terminates rather than recursing.
 *
 * VERIFY: bun run packages/connector-claude/scripts/verify-claims.ts --list | wc -l | tr -d ' '
 * PRINTS: 53
 *
 *   bun run packages/connector-claude/scripts/verify-claims.ts
 *   bun run packages/connector-claude/scripts/verify-claims.ts --list
 *
 * Exit 0 when every claim matched, 1 when any did not — naming file, line, the
 * expected output and the actual one. Run in CI's `claims` job.
 *
 * THE RED PATH IS PROVEN, not assumed — this script exists because unproven
 * checks are decoration, so it would be absurd for its own failure path to be
 * one. Plant a wrong expected value, run it, put the value back:
 *
 *   perl -0pi -e 's/^ \* PRINTS: 3738$/ * PRINTS: 3839/m' \
 *     packages/connector-core/src/briefing/sanitize.ts
 *   bun run packages/connector-claude/scripts/verify-claims.ts   # exits 1
 *   perl -0pi -e 's/^ \* PRINTS: 3739$/ * PRINTS: 3838/m' \
 *     packages/connector-core/src/briefing/sanitize.ts
 *
 * Run here this round, that printed `FAIL packages/.../sanitize.ts:88`, the
 * command, `expected | 3739`, `actual | 3738`, a `::error file=…,line=88::`
 * annotation for the pull request, the summary `1 of 32 claims do not match
 * what their command prints`, and exit 1 — then 32 of 32 again once restored.
 * It is a mutation, so it is prose with a named command rather than a directive,
 * for the reason given above: nothing that edits the tree runs from in here.
 */
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** Where source, tests, scripts and workflows live. */
const ROOTS: readonly string[] = ["packages", ".github"];
const EXTENSIONS: readonly string[] = [".ts", ".yml", ".yaml"];
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist"]);

/**
 * Strips comment decoration so the same directive works in every file type:
 * ` * VERIFY: …`, `// VERIFY: …`, `# VERIFY: …`.
 */
const DECORATION = /^\s*(?:\/\/+|\*|#)*\s*/;

type Mode = "prints" | "contains";

interface Directive {
  readonly file: string;
  /** 1-indexed line of the VERIFY line itself. */
  readonly line: number;
  readonly command: string;
  readonly expected: readonly string[];
  readonly mode: Mode;
}

const undecorate = (raw: string): string => raw.replace(DECORATION, "").trim();

const walk = async (dir: string): Promise<readonly string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      found.push(...(await walk(full)));
      continue;
    }
    if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      found.push(full);
    }
  }
  return found;
};

/**
 * A directive is a VERIFY line followed by one or more PRINTS or CONTAINS
 * lines. It ends at the first line that is neither, so an ordinary sentence
 * beneath it closes it rather than being swallowed.
 */
const directivesIn = (file: string, text: string): readonly Directive[] => {
  const lines = text.split("\n");
  const found: Directive[] = [];
  lines.forEach((raw, index) => {
    const stripped = undecorate(raw);
    if (!stripped.startsWith("VERIFY:")) {
      return;
    }
    const where = `${relative(REPO_ROOT, file)}:${String(index + 1)}`;
    const command = stripped.slice("VERIFY:".length).trim();
    const expected: string[] = [];
    let mode: Mode | null = null;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = undecorate(lines[cursor] ?? "");
      const isPrints = next.startsWith("PRINTS:");
      const isContains = next.startsWith("CONTAINS:");
      if (!isPrints && !isContains) {
        break;
      }
      const wanted: Mode = isPrints ? "prints" : "contains";
      if (mode !== null && mode !== wanted) {
        throw new Error(
          `${where}: a directive mixes PRINTS and CONTAINS. Pick one — they are different comparisons.`,
        );
      }
      mode = wanted;
      expected.push(next.slice(isPrints ? "PRINTS:".length : "CONTAINS:".length).trim());
    }
    if (command === "") {
      throw new Error(`${where}: VERIFY with an empty command.`);
    }
    if (mode === null) {
      throw new Error(
        `${where}: VERIFY with no PRINTS or CONTAINS line beneath it. A command with no expected output establishes nothing.`,
      );
    }
    found.push({ file: relative(REPO_ROOT, file), line: index + 1, command, expected, mode });
  });
  return found;
};

const scan = async (): Promise<readonly Directive[]> => {
  const found: Directive[] = [];
  for (const root of ROOTS) {
    for (const file of await walk(resolve(REPO_ROOT, root))) {
      found.push(...directivesIn(file, await Bun.file(file).text()));
    }
  }
  return [...found].sort((left, right) =>
    left.file === right.file
      ? left.line - right.line
      : left.file.localeCompare(right.file),
  );
};

/** Trimmed lines, with leading and trailing blank ones dropped. */
const normalize = (text: string): readonly string[] => {
  const lines = text.split("\n").map((line) => line.trim());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") {
    start += 1;
  }
  while (end > start && lines[end - 1] === "") {
    end -= 1;
  }
  return lines.slice(start, end);
};

interface Outcome {
  readonly directive: Directive;
  readonly matched: boolean;
  readonly actual: readonly string[];
  readonly stderr: string;
}

const check = async (directive: Directive): Promise<Outcome> => {
  const proc = Bun.spawn({
    cmd: ["sh", "-c", directive.command],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // Exit status deliberately unread — see the header: `grep -c` exits 1 exactly
  // when it prints the `0` one of these claims expects.
  await proc.exited;
  const actual = normalize(stdout);
  const matched =
    directive.mode === "prints"
      ? actual.length === directive.expected.length &&
        actual.every((line, index) => line === directive.expected[index])
      : directive.expected.every((wanted) => stdout.includes(wanted));
  return { directive, matched, actual, stderr };
};

const report = (outcome: Outcome): void => {
  const { directive } = outcome;
  const out = process.stdout;
  out.write(
    `${outcome.matched ? "  ok  " : "FAIL  "}${directive.file}:${String(directive.line)}\n`,
  );
  if (outcome.matched) {
    return;
  }
  out.write(`        $ ${directive.command}\n`);
  out.write(
    `        ${directive.mode === "prints" ? "expected" : "expected to contain"}:\n`,
  );
  for (const line of directive.expected) {
    out.write(`          | ${line}\n`);
  }
  out.write("        actual:\n");
  for (const line of outcome.actual.length > 0 ? outcome.actual : ["(nothing on stdout)"]) {
    out.write(`          | ${line}\n`);
  }
  const firstStderr = outcome.stderr.trim().split("\n")[0];
  if (firstStderr !== undefined && firstStderr !== "") {
    out.write(`        stderr: ${firstStderr}\n`);
  }
  out.write(
    `::error file=${directive.file},line=${String(directive.line)}::the comment says this command prints ${JSON.stringify(directive.expected.join(" / "))}, it printed ${JSON.stringify(outcome.actual.join(" / "))}\n`,
  );
};

const main = async (argv: readonly string[]): Promise<number> => {
  const directives = await scan();
  if (argv.includes("--list")) {
    for (const directive of directives) {
      process.stdout.write(
        `${directive.file}:${String(directive.line)}\t${directive.command}\n`,
      );
    }
    return 0;
  }

  const out = process.stdout;
  out.write(`platform ${process.platform}/${process.arch}\n`);
  out.write(`${String(directives.length)} verification directives\n\n`);

  const outcomes: Outcome[] = [];
  for (const directive of directives) {
    const outcome = await check(directive);
    outcomes.push(outcome);
    report(outcome);
  }

  const failed = outcomes.filter((outcome) => !outcome.matched);
  if (failed.length > 0) {
    out.write(
      `\n${String(failed.length)} of ${String(outcomes.length)} claims do not match what their command prints.\n`,
    );
    return 1;
  }
  out.write(`\nall ${String(outcomes.length)} claims match what their commands print\n`);
  return 0;
};

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
