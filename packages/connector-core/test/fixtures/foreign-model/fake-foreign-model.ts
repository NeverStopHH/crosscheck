/**
 * A FOREIGN MODEL BINARY — definitively not `claude`, and it says so.
 *
 * This is the executable an operator puts behind CROSSCHECK_SUMMARIZER_CMD
 * when the model they want is not Claude. It exists so the contract can be
 * proven rather than asserted: crosscheck spawns it exactly the way it would
 * spawn a real wrapper, and everything the spawn carried — the argv, the
 * stdin, the cwd, the environment — is written down where a test can read it.
 *
 * ITS ARGV IS ITS OWN, AND IT REFUSES CLAUDE'S. Nothing here understands
 * `-p`, `--model` or any lean flag; being handed one is a hard exit 2. That
 * makes this file a TRIPWIRE and not just a stub: if `resolveSummarizerArgv`
 * ever splices an argument onto an override — turning "the override replaces
 * the binary wholesale" into "the override replaces the binary and then gets
 * Claude's flags anyway" — every test that runs it goes red on the spot,
 * instead of the change landing behind a stub that shrugs at extra argv.
 *
 * The flags it DOES have (`--shape`, `--dump`, `--help`) are the other half
 * of the same proof: they are a real, working, foreign argv contract that
 * crosscheck never uses, because crosscheck passes this binary no arguments
 * at all.
 *
 * It answers from the shared corpus (corpus.ts), so what a test expects and
 * what the process actually prints cannot drift apart.
 *
 * Run it by hand:
 *   bun packages/connector-core/test/fixtures/foreign-model/fake-foreign-model.ts --help
 */
import { FOREIGN_SHAPES, foreignShape } from "./corpus.ts";

const NAME = "ox-fake";

/** Flags that would mean crosscheck had stopped replacing the binary WHOLESALE. */
const CLAUDE_FLAGS = new Set([
  "-p",
  "--print",
  "--model",
  "--setting-sources",
  "--strict-mcp-config",
  "--mcp-config",
  "--no-session-persistence",
  "--tools",
  "--max-turns",
]);

const USAGE = [
  `${NAME} — a fake foreign model for crosscheck's Tier-1 contract test.`,
  "",
  "  --shape <name>   which recorded answer shape to print",
  "  --dump <path>    write {argv, stdin, cwd, env} there as JSON",
  "  --help           this text",
  "",
  "The slice arrives on stdin. One answer goes to stdout. Exit 0 means",
  "the answer is on stdout; anything else is a failed run.",
  "",
  `shapes: ${FOREIGN_SHAPES.map((shape) => shape.name).join(", ")}`,
].join("\n");

const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const positiveInt = (raw: string | undefined): number | null => {
  if (raw === undefined) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const claudeFlag = argv.find((argument) => CLAUDE_FLAGS.has(argument));
  if (claudeFlag !== undefined) {
    process.stderr.write(
      `${NAME}: refusing ${claudeFlag} — this is not claude, and an override binary owns its whole argv\n`,
    );
    process.exitCode = 2;
    return;
  }

  // Read stdin FIRST: the contract is that the slice arrives here, and a
  // binary that exits without draining it would make the parent's write the
  // thing under test instead of the answer.
  const stdin = await Bun.stdin.text();

  const dump = flagValue(argv, "--dump") ?? process.env["CX_FAKE_FOREIGN_DUMP"];
  if (dump !== undefined && dump.length > 0) {
    // Written BEFORE any sleep, so the timeout case still leaves evidence
    // that the spawn happened and what it carried.
    await Bun.write(
      dump,
      JSON.stringify({ argv, stdin, cwd: process.cwd(), env: process.env }),
    );
  }

  const sleepMs = positiveInt(process.env["CX_FAKE_FOREIGN_SLEEP_MS"]);
  if (sleepMs !== null) {
    await Bun.sleep(sleepMs);
  }

  const shapeName =
    flagValue(argv, "--shape") ?? process.env["CX_FAKE_FOREIGN_SHAPE"] ?? "bare-none";
  process.stdout.write(foreignShape(shapeName).stdout);

  // A model that keeps talking past its answer: the runner's byte bound is
  // what has to stop this, not the model's manners.
  const floodBytes = positiveInt(process.env["CX_FAKE_FOREIGN_FLOOD_BYTES"]);
  if (floodBytes !== null) {
    process.stdout.write("z".repeat(floodBytes));
  }

  const exitCode = positiveInt(process.env["CX_FAKE_FOREIGN_EXIT"]);
  if (exitCode !== null) {
    process.exitCode = exitCode;
  }
};

await main();
