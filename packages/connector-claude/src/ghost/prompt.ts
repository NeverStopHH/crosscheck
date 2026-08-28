/**
 * What the ghost check asks the model, how it spawns it, and — the part worth
 * reading — exactly what it is allowed to show it (VISION.md §3).
 *
 * THE INPUT IS THREE THINGS AND NOTHING ELSE: my own intent sentence, the
 * overlapping teammate's intent sentence, and that teammate's DECLARED claims
 * from the one overlapping tree. No transcript, no prompt, no file contents,
 * no diff — the privacy rule the summarizer states for its slice, applied to
 * a call that reads TEAM data rather than local data, where it matters more.
 * Everything here already travelled through the hub under the ordinary
 * team-visibility rules; `get_diagnosis` on that context returns the same
 * claims to the same caller, which is what makes this input a re-reading of
 * what the reader may already pull rather than a new disclosure.
 *
 * DERIVED CLAIMS ARE EXCLUDED, and that is not tidiness. A teammate's draft
 * is a machine guess nobody vouched for (DESIGN.md §3 Tier 1), and feeding
 * one to a model that produces another derived claim would launder a guess
 * into a second guess with a fresh timestamp. Only what a person or their
 * agent DECLARED is shown.
 *
 * The argv is the summarizer runner's, byte for byte: the same headless
 * `claude -p` on the Haiku-class model, the same lean flags, the same
 * CROSSCHECK_SUMMARIZER_CMD override that replaces the binary wholesale for
 * tests and operators.
 */
import {
  GHOST_CLAIM_BODY_MAX_CHARS,
  GHOST_MAX_TEAMMATE_CLAIMS,
  GHOST_SENTENCE_MAX_CHARS,
  SUMMARIZER_MODEL,
} from "@crosscheck/connector-core/constants.ts";
import { cutWellFormed } from "@crosscheck/connector-core/briefing/cut.ts";
import type { DiagnosisClaim } from "@crosscheck/connector-core/http/hub.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { SUMMARIZER_LEAN_FLAGS } from "@crosscheck/connector-core/model/runner.ts";

/** Only what a person or their agent stated — never a machine draft. */
const DECLARED_PROVENANCE = "declared";

/**
 * ONE sentence or NONE, and the sentence must name WHERE. A collision nobody
 * can locate is the prediction theatre this feature exists not to be: "these
 * plans may conflict" is unactionable, "both change what verifyToken returns
 * on an unknown kid" is a thing two people can settle in a minute.
 *
 * NONE is the expected answer and the prompt says so. Two people in one file
 * are usually not in each other's way, and a model asked to find a conflict
 * will find one; being told that agreement is the normal outcome is the only
 * lever this design has on that.
 *
 * VERIFY: bun -e 'const p=await import("./packages/connector-claude/src/ghost/prompt.ts");const c=await import("./packages/connector-core/src/constants.ts");console.log(p.GHOST_PROMPT.includes(`at most ${c.GHOST_SENTENCE_MAX_CHARS} characters`))'
 * PRINTS: true
 */
export const GHOST_PROMPT =
  "Below are two coding sessions working on the same repository: what each says it " +
  "is trying to do, and the recorded findings of the second one. Answer with ONE " +
  `sentence of at most ${String(GHOST_SENTENCE_MAX_CHARS)} characters naming the one place their plans would ` +
  "conflict — a contract, a shape, a behaviour they would each change differently " +
  "— or exactly NONE. NONE is the usual answer: working in the same files is not a " +
  "conflict, and only a change the other side would have to undo is. Never repeat " +
  "the input, never quote it, no preamble, no markdown.";

export interface GhostInput {
  /** What MY session says it is doing. */
  readonly ownIntent: string;
  /** What the overlapping teammate says they are doing; "" when unstated. */
  readonly theirIntent: string;
  /** Their DECLARED claims, already filtered and bounded by `ghostInput`. */
  readonly theirClaims: readonly string[];
}

/**
 * One teammate claim the model is shown, kept as BOTH shapes it can come
 * back as. The line is what goes on stdin; the body is what a model that
 * parrots actually returns, because "never repeat the input" is a rule about
 * the finding and no model re-emits the `kind (status):` label with it. A
 * guard keyed on the line alone would therefore only catch the shape nobody
 * sends — which is why the worker checks both, and checks them by CONTAINMENT
 * rather than by equality: a body may be longer than the answer's own sentence
 * bound or carry a line break, and the answer reaches the guard reduced to its
 * first line and cut, so only "is this the beginning of what we showed it" is
 * answerable (hints/echo.ts isRestatementOf).
 */
export interface DeclaredClaim {
  /** The claim body as the model sees it, bounded. */
  readonly body: string;
  /** That body under its kind and status — the stdin line. */
  readonly line: string;
}

/**
 * The teammate's declared claims as the bounded lines the model sees. Sorted
 * by nothing: the hub returns a diagnosis tree in its own order and reordering
 * it here would be a second ranking nobody could explain — the bound is what
 * makes this small, not a choice about which finding matters.
 */
export const declaredClaims = (
  claims: readonly DiagnosisClaim[],
): readonly DeclaredClaim[] =>
  claims
    .filter((claim) => claim.provenance === DECLARED_PROVENANCE)
    .slice(0, GHOST_MAX_TEAMMATE_CLAIMS)
    .map((claim) => {
      const body = cutWellFormed(claim.body, GHOST_CLAIM_BODY_MAX_CHARS);
      return { body, line: `${claim.kind} (${claim.status}): ${body}` };
    })
    .filter((claim) => claim.body.length > 0);

/** The stdin block. Labelled plainly; the model is never told to obey it. */
export const renderGhostInput = (input: GhostInput): string =>
  [
    `SESSION A (mine) intends: ${input.ownIntent}`,
    `SESSION B (theirs) intends: ${input.theirIntent.length === 0 ? "(not stated)" : input.theirIntent}`,
    ...(input.theirClaims.length === 0
      ? ["SESSION B has recorded no findings."]
      : ["SESSION B has recorded:", ...input.theirClaims.map((line) => `- ${line}`)]),
  ].join("\n");

/** The override wins wholesale; else headless claude with the lean flags. */
export const resolveGhostArgv = (env: Env): readonly string[] => {
  const override = env["CROSSCHECK_SUMMARIZER_CMD"];
  if (override !== undefined && override.length > 0) {
    return [override];
  }
  return ["claude", "-p", GHOST_PROMPT, "--model", SUMMARIZER_MODEL, ...SUMMARIZER_LEAN_FLAGS];
};
