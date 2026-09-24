/**
 * `crosscheck pin` — the human half of the regression guard (Stage 1).
 *
 *   crosscheck pin "<surface>" --files a.ts b.ts [--check "…"]
 *   crosscheck pin list
 *   crosscheck pin --broke <id>
 *   crosscheck pin --ok <id>
 *   crosscheck pin --sweep
 *
 * THE HUMAN GATE, and why it is a TTY. The hub refuses any pin and any
 * retraction that does not state terminal evidence (PinSchema's `presence`),
 * and this command is the only honest sender of it — so the question here
 * becomes "is a person here?".
 * The evidence available to a CLI is an interactive terminal: an agent's Bash
 * tool call has no controlling tty, so it cannot mint a pin, and the refusal
 * says what to do instead. That is evidence, not proof — a pty would pass —
 * and it is the honest bound of what this process can know. The alternative,
 * trusting a flag, is exactly the hole the trust critique found in shipped
 * 0.7.5: `review_draft` is an MCP tool an agent can call on its own drafts,
 * under a header reading "the agent now vouches", so "Nick verified this
 * working" was a sentence a model could write about Nick.
 *
 * NOTHING HERE INTERRUPTS ANYBODY. Every path is a command a person typed.
 */
import { EXIT_FAIL, EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { sweepPinPaths } from "@crosscheck/connector-core/git/pin-sweep.ts";
import { resolvePinPaths } from "@crosscheck/connector-core/git/pin-paths.ts";
import type {
  PinPathRefusal,
  PinPathRefusalReason,
} from "@crosscheck/connector-core/git/pin-paths.ts";
import {
  breakPin,
  createPin,
  getPins,
  sweepPins,
} from "@crosscheck/connector-core/http/hub.ts";
import type { HubContext, PinSweepUpdate } from "@crosscheck/connector-core/http/hub.ts";
import {
  COMMIT_SHA_PATTERN,
  MAX_PIN_FILES,
  MAX_SPEAKING_PIN_FILES,
  NO_COMMIT_SHA,
  PIN_PRESENCE_TERMINAL,
  PinSchema,
} from "@crosscheck/schema";
import { postPilotMark } from "@crosscheck/connector-core/http/pilot.ts";
import { renderPinList } from "./pin-render.ts";
import { markFailureLine, markRecordedLine } from "./pilot-mark.ts";
import type { CliResult } from "./login.ts";

export const PIN_FLAG_FILES = "--files";
export const PIN_FLAG_CHECK = "--check";
export const PIN_FLAG_BROKE = "--broke";
export const PIN_FLAG_SWEEP = "--sweep";
export const PIN_FLAG_OK = "--ok";

export const PIN_USAGE = [
  'usage: crosscheck pin "<surface>" --files <path…> [--check "<30-second recipe>"]',
  "   or: crosscheck pin list           this repo's registry and its coverage",
  "   or: crosscheck pin --broke <id>   you ran the check and it failed",
  "   or: crosscheck pin --ok <id>      you ran the check and it passed",
  "   or: crosscheck pin --sweep        re-resolve pinned paths against git",
  "",
  "  A pin says a named surface WORKS right now: the files behind it, the",
  "  commit you verified at, and a check anybody can run in 30 seconds.",
  `  At most ${String(MAX_SPEAKING_PIN_FILES)} files may ever speak; up to ${String(MAX_PIN_FILES)} are briefing-only.`,
  "  Pinning needs a person at a terminal — an agent cannot vouch for you.",
  "",
].join("\n");

const NOT_CONFIGURED = "not configured — run `crosscheck login <hubUrl>`\n";
const NOT_A_REPO = "not a git repository — pins are repo-scoped\n";

/**
 * Is a person here? `stdin.isTTY` is the one signal a CLI process actually
 * has. Injected so tests can drive both answers without a pty, and NOT
 * readable from the environment on purpose: an env var would be a bypass any
 * agent could set, which is the whole thing this gate exists to prevent.
 */
export type InteractiveProbe = () => boolean;

export const defaultInteractiveProbe: InteractiveProbe = () =>
  process.stdin.isTTY === true;

const AGENT_REFUSAL = [
  "pinning needs a person at a terminal, and this process has none.",
  "",
  "A pin is a HUMAN's statement that a surface works — it carries your name",
  "to everybody else on this repo, and `crosscheck suspect` can name sessions",
  "once somebody records its check failing. So an agent may not create one on",
  "your behalf, even at your request.",
  "",
  "Run the same command yourself in a terminal.",
  "",
].join("\n");

interface Resolved {
  readonly ctx: HubContext;
  readonly repoId: string;
  readonly repoRoot: string;
  readonly baseCommit: string;
}

const resolve = async (
  env: Env,
  cwd: string,
): Promise<Resolved | { readonly failure: CliResult }> => {
  const identity = await resolveRepoIdentity(cwd);
  const config = await loadConfig({ env, repoRoot: identity?.root });
  if (config === null) {
    return { failure: { stdout: NOT_CONFIGURED, exitCode: EXIT_OK } };
  }
  if (identity === null) {
    return { failure: { stdout: NOT_A_REPO, exitCode: EXIT_USAGE } };
  }
  return {
    ctx: {
      hubUrl: config.hubUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      home: config.home,
      repoKey: repoKey(config.hubUrl, identity.repoId),
      now: () => new Date(),
    },
    repoId: identity.repoId,
    repoRoot: identity.root,
    baseCommit: identity.baseCommit,
  };
};

const failureResult = (result: {
  readonly kind: "network" | "http" | "malformed";
  readonly message: string;
}): CliResult =>
  result.kind === "network"
    ? { stdout: `hub unreachable: ${result.message}\n`, exitCode: EXIT_UNREACHABLE }
    : { stdout: `${result.message}\n`, exitCode: EXIT_FAIL };

interface PinArgs {
  readonly surface: string | null;
  readonly files: readonly string[];
  readonly check: string | undefined;
  readonly broke: string | null;
  readonly ok: string | null;
  readonly sweep: boolean;
  readonly list: boolean;
}

/**
 * One pass, positional-first: the surface is the only bare argument, `--files`
 * consumes every value until the next flag, and everything else takes one.
 */
export const parsePinArgs = (argv: readonly string[]): PinArgs => {
  const files: string[] = [];
  let surface: string | null = null;
  let check: string | undefined;
  let broke: string | null = null;
  let ok: string | null = null;
  let sweep = false;
  let list = false;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    if (token === PIN_FLAG_FILES) {
      index += 1;
      while (index < argv.length && !(argv[index] as string).startsWith("--")) {
        files.push(argv[index] as string);
        index += 1;
      }
      continue;
    }
    if (token === PIN_FLAG_CHECK) {
      check = argv[index + 1];
      index += 2;
      continue;
    }
    if (token === PIN_FLAG_BROKE) {
      broke = argv[index + 1] ?? null;
      index += 2;
      continue;
    }
    if (token === PIN_FLAG_OK) {
      ok = argv[index + 1] ?? null;
      index += 2;
      continue;
    }
    if (token === PIN_FLAG_SWEEP) {
      sweep = true;
      index += 1;
      continue;
    }
    if (token === "list") {
      list = true;
      index += 1;
      continue;
    }
    if (surface === null) {
      surface = token;
    }
    index += 1;
  }
  return { surface, files, check, broke, ok, sweep, list };
};

const listPins = async (
  resolved: Resolved,
  now: Date,
): Promise<CliResult> => {
  const registry = await getPins(resolved.ctx, resolved.repoId);
  if (!registry.ok) {
    return failureResult(registry);
  }
  return {
    stdout: renderPinList(resolved.repoId, registry.data, now),
    exitCode: EXIT_OK,
  };
};

/**
 * The sweep: ask git where every pinned path is now, and tell the hub. Run by
 * hand (and by `doctor`, which prints what it found) rather than from a hook
 * — it spawns git processes per missing path, which no hook budget should pay
 * for, and a rename that goes unrecorded for an hour costs nothing.
 */
const runSweep = async (resolved: Resolved): Promise<CliResult> => {
  const registry = await getPins(resolved.ctx, resolved.repoId);
  if (!registry.ok) {
    return failureResult(registry);
  }
  const live = registry.data.pins.filter((pin) => pin.brokeAt === null);
  const paths = [...new Set(live.flatMap((pin) => pin.files.map((file) => file.path)))];
  const swept = await sweepPinPaths(resolved.repoRoot, paths);
  const byPath = new Map(swept.map((entry) => [entry.path, entry]));
  const updates: PinSweepUpdate[] = [];
  let unknown = 0;
  for (const pin of live) {
    for (const file of pin.files) {
      const outcome = byPath.get(file.path);
      if (outcome === undefined || outcome.status === "unknown") {
        // NOT reported. "git could not answer" is not a verdict about the
        // file, and sending it as one would retire pins on a slow disk.
        unknown += 1;
        continue;
      }
      updates.push({
        pinId: pin.id,
        path: file.path,
        newPath: outcome.resolved,
      });
    }
  }
  if (updates.length === 0) {
    return {
      stdout: `pin sweep: nothing to record (${String(unknown)} path(s) git could not answer for)\n`,
      exitCode: EXIT_OK,
    };
  }
  const reported = await sweepPins(resolved.ctx, resolved.repoId, updates);
  if (!reported.ok) {
    return failureResult(reported);
  }
  const renamed = swept.filter((entry) => entry.status === "renamed").length;
  const missing = swept.filter((entry) => entry.status === "missing").length;
  return {
    stdout: [
      `pin sweep: ${String(reported.data.applied)} path(s) recorded — ${String(renamed)} renamed, ${String(missing)} missing, ${String(unknown)} not answered, ${String(reported.data.ignored)} not recorded`,
      // THE HUB'S REFUSALS ARE THE READER'S, TOO. git said one thing and the
      // hub declined to write it — a sweep that printed only what git found
      // would report the register as current while it is not, which is the
      // fail-silent shape this whole command exists to remove.
      ...(reported.data.ignored === 0
        ? []
        : [
            "not recorded means the hub declined the update: the pin belongs to another repo, the path is not one the pin watches, or this team's pin policy covers the new path. Run crosscheck pin list to see what the register actually holds.",
          ]),
      ...(unknown === 0
        ? []
        : [
            "not answered means nobody looked: git could not reply, or this sweep's call budget ran out before reaching the path. Neither is a verdict about the file.",
          ]),
      ...(missing === 0
        ? []
        : ["a pin with missing paths watches less than it says — `crosscheck pin list` shows which"]),
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};

/** Why the door refused a path, in the person's terms (01a §3.3d, CSK-28). */
const PIN_PATH_REFUSAL_SENTENCE: Readonly<Record<PinPathRefusalReason, string>> = {
  not_tracked:
    "git tracks no file at this path — pin paths are repo-relative and case-sensitive, and the file must be in git",
  directory: "this is a directory, and a pin watches files — name the files",
  git_unanswered: "git did not answer, so nothing was stored",
  empty: "this is not a file path",
  absolute: "an absolute path is never a repo file — give it relative to the repo root",
  parent_segment: "a path with `..` can leave the repository — give it relative to the repo root",
  control_character: "a path with a newline or NUL in it cannot be a pinned file",
  backslash: "use forward slashes — a backslash is ambiguous between systems",
};

const refusedPaths = (refused: readonly PinPathRefusal[]): CliResult => ({
  stdout: [
    "nothing was pinned — every file must be one git tracks, spelled as git spells it:",
    ...refused.map(
      (row) =>
        `  ${JSON.stringify(row.path)}: ${PIN_PATH_REFUSAL_SENTENCE[row.reason]}${
          row.suggestion === null
            ? ""
            : ` — git tracks ${JSON.stringify(row.suggestion)}; pin that`
        }`,
    ),
    "",
  ].join("\n"),
  exitCode: EXIT_USAGE,
});

const create = async (
  resolved: Resolved,
  args: PinArgs,
  surface: string,
  cwd: string,
): Promise<CliResult> => {
  // THE DOOR ASKS GIT FIRST (01a §3.3d, CSK-28). A path git does not track in
  // exactly that spelling would be stored as an identity that matches no
  // touch, and the pin would protect nothing while reading as registered.
  const door = await resolvePinPaths(resolved.repoRoot, cwd, args.files);
  if (!door.ok) {
    return refusedPaths(door.refused);
  }
  // The SAME schema the hub applies, run locally first: a refusal a person
  // reads in their own terminal beats a 400 they have to decode.
  const parsed = PinSchema.safeParse({
    id: `pin_${crypto.randomUUID()}`,
    repo: resolved.repoId,
    surface,
    files: door.paths,
    ...(args.check === undefined ? {} : { check: args.check }),
    presence: PIN_PRESENCE_TERMINAL,
    verifiedAtCommit: resolved.baseCommit,
  });
  if (!parsed.success) {
    return {
      stdout: `${parsed.error.issues.map((issue) => issue.message).join("\n")}\n${PIN_USAGE}`,
      exitCode: EXIT_USAGE,
    };
  }
  const created = await createPin(resolved.ctx, {
    id: parsed.data.id,
    repo: parsed.data.repo,
    surface: parsed.data.surface,
    files: parsed.data.files,
    ...(parsed.data.check === undefined ? {} : { check: parsed.data.check }),
    presence: PIN_PRESENCE_TERMINAL,
    verifiedAtCommit: parsed.data.verifiedAtCommit,
  });
  if (!created.ok) {
    return failureResult(created);
  }
  const speaking = parsed.data.files.length <= MAX_SPEAKING_PIN_FILES;
  return {
    stdout: [
      `pinned ${created.data.id}: ${String(parsed.data.files.length)} file(s) at ${parsed.data.verifiedAtCommit}`,
      speaking
        ? "everyone on this repo can see it, with your name on it."
        : `briefing-only: over ${String(MAX_SPEAKING_PIN_FILES)} files, so it will never speak.`,
      `retract it with: crosscheck pin --broke ${created.data.id}`,
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};

/**
 * `--ok <id>` — the symmetric half of `--broke` (07 §3.2, D5): whoever ran the
 * recipe and watched it PASS gets the same one-line gesture as whoever watched
 * it fail. It is a pilot mark rather than a pin write — it changes nothing the
 * register says, it records that a notice was right — and it takes the same
 * human gate, because "the check passed" is a human's word or nothing.
 */
const confirmPin = async (
  resolved: Resolved,
  pinId: string,
  isInteractive: InteractiveProbe,
): Promise<CliResult> => {
  if (!isInteractive()) {
    return { stdout: AGENT_REFUSAL, exitCode: EXIT_USAGE };
  }
  const result = await postPilotMark(resolved.ctx, {
    repo: resolved.repoId,
    refKind: "pin",
    refId: pinId,
  });
  if (!result.ok) {
    return {
      stdout: markFailureLine(result.kind, result.message),
      exitCode: result.kind === "network" ? EXIT_UNREACHABLE : EXIT_FAIL,
    };
  }
  return {
    stdout: markRecordedLine("pin", pinId, result.data.repeated),
    exitCode: EXIT_OK,
  };
};

export const runPin = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
  isInteractive: InteractiveProbe = defaultInteractiveProbe,
): Promise<CliResult> => {
  const args = parsePinArgs(argv);
  const resolved = await resolve(env, cwd);
  if ("failure" in resolved) {
    return resolved.failure;
  }
  if (args.list) {
    return listPins(resolved, new Date());
  }
  if (args.sweep) {
    return runSweep(resolved);
  }
  if (args.broke !== null) {
    // The retraction takes the human gate too: it is the falsifier
    // `crosscheck suspect` reads before it names any session, so an agent
    // recording "the check failed" would unlock attribution on its own word.
    if (!isInteractive()) {
      return { stdout: AGENT_REFUSAL, exitCode: EXIT_USAGE };
    }
    // THE COMMIT IS SENT when git named one: proof 3's fix range starts at
    // the break, not at the last commit the surface worked on (07 §3.4).
    const broken = await breakPin(
      resolved.ctx,
      resolved.repoId,
      args.broke,
      COMMIT_SHA_PATTERN.test(resolved.baseCommit) &&
        resolved.baseCommit !== NO_COMMIT_SHA
        ? resolved.baseCommit
        : undefined,
    );
    if (!broken.ok) {
      return failureResult(broken);
    }
    return {
      stdout: [
        `retracted ${broken.data.id}: recorded as checked and failing, with your name and the time.`,
        `crosscheck suspect ${broken.data.id} can now name the sessions that touched it.`,
        "",
      ].join("\n"),
      exitCode: EXIT_OK,
    };
  }
  if (args.ok !== null) {
    return confirmPin(resolved, args.ok, isInteractive);
  }
  if (args.surface === null || args.files.length === 0) {
    return { stdout: PIN_USAGE, exitCode: EXIT_USAGE };
  }
  if (!isInteractive()) {
    return { stdout: AGENT_REFUSAL, exitCode: EXIT_USAGE };
  }
  return create(resolved, args, args.surface, cwd);
};
