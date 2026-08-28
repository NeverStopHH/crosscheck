/**
 * What a conference asks the model, what it is allowed to show it, and how the
 * answer is read back (VISION.md §2).
 *
 * ONE PASS, NO DEBATE. The obvious design for "synthesize what these sessions
 * know" is a multi-agent debate, and the published measurements are against
 * it: agents align on the first confident assertion, escalate their own
 * certainty and lock in a false consensus, which is precisely the failure
 * VISION §2 says would make this feature worse than three honest separate
 * investigations. So there is one bounded call, it may answer at most
 * CONFERENCE_MAX_FINDINGS times, NONE is named as the usual answer, and
 * everything it says is printed above the claims it was drawn from.
 *
 * IT NEVER LEARNS WHO ANYBODY IS. Sessions are labelled SESSION A, SESSION B —
 * the ghost check's rule, for the same reason: a model that is never told a
 * name cannot invent a sentence about a named person, and the attribution the
 * reader needs is attached afterwards, deterministically, from the row the
 * label came from.
 *
 * WHAT IT IS SHOWN is what the hub already hands this caller through
 * `search_related_work` and `get_diagnosis`: each session's stated intent and
 * its DECLARED claims. No transcripts, no prompts, no file contents, no diffs,
 * no drafts — the hub does not even send the drafts
 * (packages/server/src/services/conference.ts), so this module cannot leak
 * them by forgetting a filter.
 *
 * The argv is the summarizer runner's, byte for byte: the same headless
 * `claude -p` on the Haiku-class model, the same lean flags, the same
 * CROSSCHECK_SUMMARIZER_CMD override that replaces the binary wholesale for
 * tests and operators.
 */
import {
  CONFERENCE_BODY_MAX_CHARS,
  CONFERENCE_CHARS_PER_TOKEN,
  CONFERENCE_MAX_FINDINGS,
  CONFERENCE_MAX_INPUT_CHARS,
  CONFERENCE_SENTENCE_MAX_CHARS,
  SUMMARIZER_MODEL,
} from "@crosscheck/connector-core/constants.ts";
import { MAX_INTENT_SUMMARY_CHARS } from "@crosscheck/schema";
import { cutWellFormed } from "@crosscheck/connector-core/briefing/cut.ts";
import type { ConferenceContext } from "@crosscheck/connector-core/http/hub.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { SUMMARIZER_LEAN_FLAGS } from "@crosscheck/connector-core/model/runner.ts";

/** The label alphabet — A, B, C … one per session the model is shown. */
const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * ONE finding per line, and every line must name TWO sessions. A synthesis
 * that cannot say which two pieces of work share the cause is unactionable —
 * "several investigations may be related" is the standup-bot noise this
 * feature exists not to be — and a pair is also what a reader can check in a
 * minute against the two trees printed under it.
 *
 * NONE is named as the usual answer, exactly as the ghost prompt names it:
 * separate investigations are usually separate, and a model asked to find a
 * shared cause will find one.
 *
 * VERIFY: bun -e 'const p=await import("./packages/connector-claude/src/conference/prompt.ts");const c=await import("./packages/connector-core/src/constants.ts");console.log(p.CONFERENCE_PROMPT.includes(`at most ${c.CONFERENCE_SENTENCE_MAX_CHARS} characters`), p.CONFERENCE_PROMPT.includes(`at most ${c.CONFERENCE_MAX_FINDINGS} lines`))'
 * PRINTS: true true
 */
export const CONFERENCE_PROMPT =
  "Below are coding sessions on one repository: what each says it is trying to do, " +
  "and the findings each has recorded. Name only CAUSES TWO SESSIONS SHARE. Answer " +
  `with at most ${String(CONFERENCE_MAX_FINDINGS)} lines, each of the exact form ` +
  `"A+B: <sentence>" where A and B are two different session letters and the ` +
  `sentence is at most ${String(CONFERENCE_SENTENCE_MAX_CHARS)} characters naming the one ` +
  "cause both are circling — or exactly NONE. NONE is the usual answer: separate " +
  "investigations are usually separate, and two sessions touching the same area is " +
  "not a shared cause. Never repeat the input, never quote it, never name a person, " +
  "no preamble, no markdown.";

/** One session as the model sees it, with the label its answer must use. */
export interface LabelledSession {
  readonly label: string;
  readonly context: ConferenceContext;
}

/**
 * Labels assigned in the hub's own order (freshest first), bounded by the
 * alphabet: a thirteenth context would have no letter to be named by, and a
 * label the answer cannot carry is a session the model can talk about without
 * anybody being able to attribute the sentence.
 */
export const labelSessions = (
  contexts: readonly ConferenceContext[],
): readonly LabelledSession[] =>
  contexts
    .slice(0, LABELS.length)
    .map((context, index) => ({ label: LABELS[index] as string, context }));

const claimLines = (context: ConferenceContext): readonly string[] =>
  context.claims
    .map((claim) => {
      const body = cutWellFormed(claim.body, CONFERENCE_BODY_MAX_CHARS);
      return body.length === 0
        ? ""
        : `- ${claim.kind} (${claim.status}): ${body}`;
    })
    .filter((line) => line.length > 0);

/** One session as the model reads it: the plan, then the recorded findings. */
const sessionBlock = (session: LabelledSession): string => {
  const intent = session.context.intent;
  const summary =
    intent === null || intent === undefined
      ? ""
      : cutWellFormed(intent.summary, MAX_INTENT_SUMMARY_CHARS);
  const claims = claimLines(session.context);
  return [
    `SESSION ${session.label} intends: ${summary.length === 0 ? "(not stated)" : summary}`,
    ...(claims.length === 0
      ? [`SESSION ${session.label} has recorded no findings.`]
      : [`SESSION ${session.label} has recorded:`, ...claims]),
  ].join("\n");
};

/**
 * WHICH sessions fit in one input, and therefore which ones the model is
 * allowed to have an opinion about.
 *
 * BOUNDED TWICE — per field, then over the whole document. The per-field cuts
 * are what keep an ordinary run small; CONFERENCE_MAX_INPUT_CHARS is what
 * holds when the hub is modified or hostile, and it is applied by dropping
 * WHOLE sessions from the end rather than by cutting the text, so no session
 * is shown to the model as half a sentence.
 *
 * IT IS THE CALLER'S ANSWER TO TWO QUESTIONS, not one, which is why it is its
 * own exported function rather than a local of the renderer. A session the
 * bound left out was never compared, so it must not be namable in the answer
 * and must not be counted in the cost line — and the hub's own caps reach this
 * bound with ordinary data (twelve contexts at CONFERENCE_MAX_CLAIMS_PER_CONTEXT
 * claims of CONFERENCE_CLAIM_BODY_MAX_CHARS is nearly twice it), so this is the
 * everyday path and not a hostile one.
 */
export const fitSessions = (
  sessions: readonly LabelledSession[],
): readonly LabelledSession[] => {
  const kept: LabelledSession[] = [];
  let total = 0;
  for (const session of sessions) {
    // +1 for the newline this block would cost when joined.
    const cost = sessionBlock(session).length + 1;
    // SKIPPED, NOT STOPPED AT. Stopping would let ONE oversized session at the
    // head empty the whole input — and the sessions arrive freshest first, so
    // the head is exactly where a hub that is modified or hostile would put
    // it. The per-field cuts bound every BODY, which leaves the NUMBER of
    // claims in one context as the only way to blow this bound; a hub sending
    // two hundred of them must cost the team that one session, not all of them.
    if (total + cost > CONFERENCE_MAX_INPUT_CHARS) {
      continue;
    }
    kept.push(session);
    total += cost;
  }
  return kept;
};

/**
 * The stdin block. Labelled plainly; the model is never told to obey it.
 * Renders exactly the sessions `fitSessions` keeps, so what was sent and what
 * may be named can never be two different lists.
 */
export const renderConferenceInput = (
  sessions: readonly LabelledSession[],
): string => fitSessions(sessions).map(sessionBlock).join("\n");

/**
 * The pre-run estimate, and it is an ESTIMATE. No tokenizer runs on this
 * machine, so the figure is characters over CONFERENCE_CHARS_PER_TOKEN and
 * every surface that prints it says "about" — a number presented as measured
 * when it was divided is the false precision this project keeps out of its
 * telemetry.
 */
export const estimateInputTokens = (input: string): number =>
  Math.ceil(input.length / CONFERENCE_CHARS_PER_TOKEN);

/** One finding as the model stated it: two labels and a sentence. */
export interface ParsedFinding {
  readonly labelA: string;
  readonly labelB: string;
  readonly sentence: string;
}

/**
 * What came back, in the three shapes that mean different things.
 *
 * `unreadable` is its own outcome and not a kind of NONE. A NONE is the
 * model agreeing that separate investigations are separate — the expected
 * answer. An answer this parser cannot read is a prompt that drifted, a
 * binary that changed, or a model that ignored the format, and it is
 * invisible from every other surface: `doctor` WARNs on it
 * (DOCTOR_CONFERENCE_UNREADABLE_WARN) precisely because folding it into NONE
 * would make a broken contract look like a quiet team.
 */
export type ConferenceAnswer =
  | { readonly kind: "none" }
  | { readonly kind: "findings"; readonly findings: readonly ParsedFinding[] }
  | { readonly kind: "unreadable" };

const NONE_PATTERN = /^\s*none\.?\s*$/i;

/** `A+B: sentence` — spaces around the plus tolerated, nothing else is. */
const FINDING_PATTERN = /^\s*-?\s*([A-Z])\s*\+\s*([A-Z])\s*:\s*(.+)$/;

/**
 * Reads the answer back against the labels this run actually handed out.
 *
 * A label the run never used is DROPPED rather than guessed at: the whole
 * point of labelling is that the attribution is deterministic, and a sentence
 * about "SESSION Q" on a run with twelve sessions is a sentence about nobody.
 * A line naming one session twice goes the same way — "A+A" is not a shared
 * cause, it is one session.
 */
export const parseConferenceAnswer = (
  stdout: string,
  labels: ReadonlySet<string>,
): ConferenceAnswer => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { kind: "unreadable" };
  }
  if (lines.every((line) => NONE_PATTERN.test(line))) {
    return { kind: "none" };
  }
  const findings = lines.flatMap((line): readonly ParsedFinding[] => {
    const match = FINDING_PATTERN.exec(line);
    if (match === null) {
      return [];
    }
    const [, labelA, labelB, sentence] = match;
    if (
      labelA === undefined ||
      labelB === undefined ||
      sentence === undefined ||
      labelA === labelB ||
      !labels.has(labelA) ||
      !labels.has(labelB)
    ) {
      return [];
    }
    const cut = cutWellFormed(sentence.replace(/\s+/g, " ").trim(), CONFERENCE_SENTENCE_MAX_CHARS);
    return cut.length === 0 ? [] : [{ labelA, labelB, sentence: cut }];
  });
  return findings.length === 0
    ? { kind: "unreadable" }
    : { kind: "findings", findings: findings.slice(0, CONFERENCE_MAX_FINDINGS) };
};

/** The override wins wholesale; else headless claude with the lean flags. */
export const resolveConferenceArgv = (env: Env): readonly string[] => {
  const override = env["CROSSCHECK_SUMMARIZER_CMD"];
  if (override !== undefined && override.length > 0) {
    return [override];
  }
  return [
    "claude",
    "-p",
    CONFERENCE_PROMPT,
    "--model",
    SUMMARIZER_MODEL,
    ...SUMMARIZER_LEAN_FLAGS,
  ];
};
