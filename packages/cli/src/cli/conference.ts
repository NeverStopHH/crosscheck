/**
 * `crosscheck conference` — the agent conference (VISION.md §2), and the only
 * model call in this product a human starts by hand.
 *
 * EXPLICIT, OPT-IN, NEVER A HOOK. Nothing schedules this, nothing fires it on
 * a prompt or a session start, and the hub route it reads exists for no other
 * caller. VISION §2 calls a conference the riskiest of the four capabilities
 * because a confidently wrong shared root cause is worse than three honest
 * separate investigations, and the first line of defence against that is that
 * a person decided to ask.
 *
 * COSTED BEFORE IT SPENDS. The corpus line and the token estimate are written
 * to the caller's terminal BEFORE the model is spawned, not gathered into the
 * result at the end — that is the whole point of an estimate, and the wall
 * clock behind it is a hard ceiling in the shape the LLM-cost literature calls
 * quote-as-ceiling: estimate, cap, absorb the overrun. A run that has already
 * spent CONFERENCE_MAX_WALL_MS on the hub does not start a model call it
 * cannot finish; it says so and writes the deterministic report anyway.
 *
 * THE REPORT IS ALWAYS WRITTEN when the hub answered — a run that found
 * nothing still leaves the page that says so, because "nothing to synthesize"
 * is a finding and a command that prints nothing is indistinguishable from one
 * that failed.
 *
 * WHAT IT PUBLISHES, and only behind --publish: one DERIVED, PROPOSED claim per
 * finding, at CONFERENCE_DERIVED_CONFIDENCE, on the freshest of the two
 * contexts the finding names (orderedPair, never the letter the model wrote
 * first) — a Tier-1 draft like every other model sentence
 * here, pointer-only until somebody promotes it with review_draft. It needs a
 * session of its own to author them (the hub only accepts claims from a
 * session the caller owns), which is registered and ENDED inside the run.
 */
import {
  CONFERENCE_DERIVED_CONFIDENCE,
  CONFERENCE_MAX_FINDINGS,
  CONFERENCE_MAX_INPUT_CHARS,
  CONFERENCE_MAX_WALL_MS,
  DEFAULT_AGENT_KIND,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
} from "@crosscheck/connector-core/constants.ts";
import { loadReportableConfig } from "@crosscheck/connector-core/config/config.ts";
import {
  conferenceReportPath,
  repoKey,
  writePrivateFile,
} from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { containsSecret } from "@crosscheck/connector-core/capture/secret-scan.ts";
import { isRestatementOf } from "@crosscheck/connector-core/hints/echo.ts";
import { renderConferenceReport } from "@crosscheck/connector-core/conference/report.ts";
import type {
  ConferenceFinding,
  ConferenceModelOutcome,
} from "@crosscheck/connector-core/conference/report.ts";
import { describeConnectionFailure } from "@crosscheck/connector-core/http/connection-error.ts";
import type { ConnectionCause } from "@crosscheck/connector-core/http/connection-error.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import {
  endSession,
  getConference,
  postRecords,
  registerSession,
} from "@crosscheck/connector-core/http/hub.ts";
import type {
  ConferenceContext,
  ConferenceCorpus,
  HubContext,
} from "@crosscheck/connector-core/http/hub.ts";
import { buildEnvelope } from "@crosscheck/connector-core/capture/records.ts";
import { mintClaimId } from "@crosscheck/connector-core/mcp/tools/shared.ts";
import { recordConferenceRun } from "@crosscheck/connector-core/state/conference-cost.ts";
import {
  formatSummarizerFailure,
  resolveSummarizerTimeoutMs,
  runSummarizer,
} from "@crosscheck/connector-claude";
import {
  ensureSummarizerCwd,
  estimateInputTokens,
  fitSessions,
  labelSessions,
  parseConferenceAnswer,
  renderConferenceInput,
  resolveConferenceArgv,
} from "@crosscheck/connector-claude";
import type { LabelledSession } from "@crosscheck/connector-claude";
import type { CliResult } from "./login.ts";

export const CONFERENCE_FLAG_PUBLISH = "--publish";

export const CONFERENCE_USAGE = [
  "usage: crosscheck conference [--publish]",
  "",
  "  reads this repo's recent work contexts, their declared claims, the open",
  "  questions and the contradiction candidates, runs ONE bounded local model",
  "  pass over them and writes a Markdown report (the path is printed)",
  "",
  "  --publish   also file each finding as a derived, proposed draft on the",
  "              hub, pointer-only until somebody promotes it (review_draft)",
  "",
].join("\n");

/** Where the pre-run lines go — stdout by default, a collector under test. */
export type ConferenceWriter = (line: string) => void;

const writeToStdout: ConferenceWriter = (line) => {
  process.stdout.write(`${line}\n`);
};

export interface ConferenceOptions {
  readonly publish: boolean;
}

export const parseConferenceArgs = (
  argv: readonly string[],
): ConferenceOptions | null => {
  const publish = argv.includes(CONFERENCE_FLAG_PUBLISH);
  const unknown = argv.filter((arg) => arg !== CONFERENCE_FLAG_PUBLISH);
  return unknown.length === 0 ? { publish } : null;
};

/** A context the model can say anything about: a plan, or a recorded finding. */
const hasSubstance = (context: ConferenceContext): boolean =>
  (context.intent !== null &&
    context.intent !== undefined &&
    context.intent.summary.length > 0) ||
  context.claims.length > 0;

/**
 * Everything the model is shown, and everything a sentence may be attributed
 * to. Two is the floor: a shared cause is a statement about two pieces of
 * work, so one session is nothing to compare and the run says so instead of
 * spending a call to be told the obvious.
 *
 * The two need NOT belong to different developers. Duplicated work is about
 * people (services/conference.ts pairs only across developers), but a shared
 * CAUSE is about code: my own two investigations converging on one bug is a
 * finding I want, and it is the cheapest one to check.
 */
const comparableSessions = (
  corpus: ConferenceCorpus,
): readonly LabelledSession[] => {
  const sessions = labelSessions(corpus.contexts);
  return sessions.filter((session) => hasSubstance(session.context));
};

interface ModelRun {
  readonly outcome: ConferenceModelOutcome;
  readonly findings: readonly ConferenceFinding[];
  readonly published: number;
  readonly none: boolean;
  readonly unreadable: boolean;
  readonly failure: string | undefined;
}

const SKIPPED = (reason: string): ModelRun => ({
  outcome: { kind: "skipped", reason },
  findings: [],
  published: 0,
  none: false,
  unreadable: false,
  failure: undefined,
});

/**
 * Every claim body the model was shown, in both shapes it can come back as —
 * the ghost worker's echo rule, applied to a call that reads MORE teammate
 * text than any other in this product. A "finding" that merely restates a
 * claim it was just handed would republish a teammate's declared finding as
 * this machine's derived synthesis: provenance laundering by paraphrase.
 */
const shownTexts = (sessions: readonly LabelledSession[]): readonly string[] =>
  sessions.flatMap((session) =>
    session.context.claims.flatMap((claim) => [
      claim.body,
      `${claim.kind} (${claim.status}): ${claim.body}`,
    ]),
  );

/**
 * The two sides of a finding in the HUB'S order — freshest first — rather than
 * in the order the model happened to write its two letters.
 *
 * "A+B" and "B+A" are the same finding, and which one a model emits is a coin
 * toss. Two things downstream must not be decided by that toss: which of the
 * two trees a --publish draft is FILED ON, and which side a reader meets first
 * on every page. Freshest is the same rule the rest of this product uses when
 * one row has to speak for a developer (services/presence.ts, mergeGroup), and
 * the tie is broken by id so the answer is total.
 */
const orderedPair = (
  left: ConferenceContext,
  right: ConferenceContext,
  rank: ReadonlyMap<string, number>,
): readonly [ConferenceContext, ConferenceContext] => {
  const leftRank = rank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = rank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) {
    return leftRank < rightRank ? [left, right] : [right, left];
  }
  return left.id.localeCompare(right.id) <= 0 ? [left, right] : [right, left];
};

const runModel = async (
  sessions: readonly LabelledSession[],
  env: Env,
  home: string,
  deadlineAt: number,
  write: ConferenceWriter,
): Promise<ModelRun> => {
  // WHAT IS ACTUALLY SENT, which is not always every session the hub named:
  // the input bound drops whole sessions from the end, and the hub's own caps
  // reach that bound with ordinary data. Everything downstream — the cost
  // line, the labels an answer may use, the attribution — is derived from
  // THIS list, so a session nobody showed the model can never be named by it.
  const sent = fitSessions(sessions);
  // THE FLOOR IS COUNTED ON `sent`, NOT ON WHAT THE HUB NAMED, and the order
  // is the whole point: two is the floor because a shared cause is a statement
  // about TWO pieces of work, and a model shown one session cannot produce an
  // "A+B" line at all. Checking the floor first spent a real call on one
  // session — or, when neither context fit, on an empty document after
  // quoting "about 0 input tokens" — and then booked the answer `unreadable`,
  // which is a doctor WARN with no decay and nothing wrong with the model.
  if (sent.length < 2) {
    return SKIPPED(
      sessions.length < 2
        ? sessions.length === 0
          ? "no session on this repo has a plan or a finding to compare"
          : "only one session on this repo has anything to compare"
        : `only ${String(sent.length)} of ${String(sessions.length)} sessions fit ` +
          `the ${String(CONFERENCE_MAX_INPUT_CHARS)}-character input bound`,
    );
  }
  const input = renderConferenceInput(sent);
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return SKIPPED("the wall-clock cap was reached before the model could run");
  }
  // The QUOTE, printed before the spend and never after it.
  const timeoutMs = Math.min(resolveSummarizerTimeoutMs(env), remainingMs);
  write(
    `conference: sending about ${String(estimateInputTokens(input))} input tokens ` +
      `(${String(input.length)} characters) from ${String(sent.length)} sessions ` +
      `to the local model, capped at ${String(Math.round(timeoutMs / 1000))} s`,
  );
  const result = await runSummarizer(resolveConferenceArgv(env), input, timeoutMs, env, {
    // From the neutral directory, never the repo root (trial finding #14).
    cwd: await ensureSummarizerCwd(home),
  });
  if (!result.ok) {
    const failure = formatSummarizerFailure(result);
    return {
      outcome: { kind: "failed", reason: failure },
      findings: [],
      published: 0,
      none: false,
      unreadable: false,
      failure,
    };
  }
  const answer = parseConferenceAnswer(
    result.stdout,
    new Set(sent.map((session) => session.label)),
  );
  if (answer.kind === "none") {
    return {
      outcome: { kind: "none" },
      findings: [],
      published: 0,
      none: true,
      unreadable: false,
      failure: undefined,
    };
  }
  if (answer.kind === "unreadable") {
    return {
      outcome: {
        kind: "failed",
        reason: "the model answered in a shape this version cannot read",
      },
      findings: [],
      published: 0,
      none: false,
      unreadable: true,
      failure: undefined,
    };
  }
  const byLabel = new Map(
    sent.map((session) => [session.label, session.context]),
  );
  // The hub's own ordering of the slice, freshest first — see orderedPair.
  const rank = new Map(sent.map((session, index) => [session.context.id, index]));
  const shown = shownTexts(sent);
  const findings = answer.findings
    .flatMap((finding): readonly ConferenceFinding[] => {
      const left = byLabel.get(finding.labelA);
      const right = byLabel.get(finding.labelB);
      if (left === undefined || right === undefined) {
        return [];
      }
      // The two gates a stored-or-printed model sentence owes: it must not be
      // a teammate's own claim handed back, and it must not carry a secret.
      // Neither ever quotes what it matched.
      if (isRestatementOf(finding.sentence, shown) || containsSecret(finding.sentence)) {
        return [];
      }
      return [{ sentence: finding.sentence, contexts: orderedPair(left, right, rank) }];
    })
    .slice(0, CONFERENCE_MAX_FINDINGS);
  return {
    outcome: findings.length === 0 ? { kind: "none" } : { kind: "answered" },
    findings,
    published: 0,
    // A run whose every sentence was dropped by a gate said nothing usable,
    // which is a NONE for the counters: nothing failed and nothing landed.
    none: findings.length === 0,
    unreadable: false,
    failure: undefined,
  };
};

/**
 * Files each finding as a Tier-1 draft. Needs a session of its own — the hub
 * refuses a claim whose author session belongs to somebody else — which is
 * registered here and ENDED in the `finally`, so a conference never leaves a
 * live session sitting in anybody's presence list.
 *
 * Direct POST rather than the spool, deliberately: this is a command a human
 * is watching, and "published 2 findings" has to mean the hub took them. A
 * failure says so and the report on disk is untouched.
 */
const publishFindings = async (
  hub: HubContext,
  repoId: string,
  branch: string,
  findings: readonly ConferenceFinding[],
  env: Env,
  now: Date,
): Promise<{ readonly published: number; readonly problem: string | null }> => {
  if (findings.length === 0) {
    return { published: 0, problem: null };
  }
  const sessionId = `cc_${crypto.randomUUID()}`;
  const registered = await registerSession(hub, {
    id: sessionId,
    agentKind: env["CROSSCHECK_AGENT_KIND"] ?? DEFAULT_AGENT_KIND,
    repo: repoId,
    branch,
    baseCommit: "conference",
    status: "analyzing",
  });
  if (!registered.ok) {
    return { published: 0, problem: "the hub would not open a session to file them under" };
  }
  try {
    const envelopes = findings.map((finding) => {
      const target = finding.contexts[0] as ConferenceContext;
      const other = finding.contexts[1];
      const attribution =
        other === undefined ? "" : ` — also see get_diagnosis ${other.id}`;
      return buildEnvelope(
        "claim",
        {
          id: mintClaimId(),
          workContextId: target.id,
          authorSessionId: sessionId,
          // A cause the model INFERRED across two trees is a hypothesis:
          // nobody has seen it, and the kind is what a reader weighs it by.
          kind: "hypothesis",
          body: `Conference finding: ${finding.sentence}${attribution}`,
          status: "proposed",
          confidence: CONFERENCE_DERIVED_CONFIDENCE,
          captureMode: "auto",
          provenance: "derived",
          evidenceRefs: [],
          createdAt: now.toISOString(),
        },
        {
          developerId: registered.data.session.developerId,
          agentKind: env["CROSSCHECK_AGENT_KIND"] ?? DEFAULT_AGENT_KIND,
          sessionId,
        },
        now,
      );
    });
    const posted = await postRecords(hub, envelopes);
    if (!posted.ok) {
      return { published: 0, problem: "the hub refused the records" };
    }
    // The SUMMARY, not the per-record list: `results` is optional on this
    // wire (an older hub omits it), and a publish that silently counted zero
    // because a field was absent would print a number that is not true.
    const accepted = posted.data.accepted + posted.data.duplicates;
    return {
      published: accepted,
      problem:
        accepted === envelopes.length
          ? null
          : `the hub kept ${String(accepted)} of ${String(envelopes.length)}`,
    };
  } finally {
    // ALWAYS: a conference must not leave a session in a teammate's presence
    // list because publishing threw.
    await endSession(hub, sessionId);
  }
};

/** A hub that predates a route answers 404 — cli/doctor.ts owns the same rule. */
const HTTP_NOT_FOUND = 404;

/** The first status that is a refusal rather than an answer. */
const HTTP_CLIENT_ERROR = 400;

/**
 * The conference's OWN request timeout, and the one place in this product
 * where `config.timeoutMs` is deliberately not the bound.
 *
 * config.timeoutMs is HTTP_TIMEOUT_MS (400 ms) or whatever `login` measured,
 * and it is sized for a hook running inside a developer's keystroke — the
 * UserPromptSubmit path spends it inside an 800 ms budget. A conference is the
 * one caller that is explicitly not a hook: it prints a wall clock, waits for
 * a local model call, and a human is watching it. Leaving it on the hook's
 * timeout made CONFERENCE_MAX_WALL_MS unreachable — the request aborted ~89x
 * earlier than the ceiling the module header promises — and booked the result
 * as `noHubAnswer`, a counter doctor reads as a deployment state.
 *
 * Never SHORTER than the configured timeout: a hub far enough away that login
 * measured a second must not be given less than that because the wall clock
 * has nearly run out.
 */
const withinWallClock = (hub: HubContext, deadlineAt: number): HubContext => ({
  ...hub,
  timeoutMs: Math.max(
    hub.timeoutMs,
    Math.min(CONFERENCE_MAX_WALL_MS, deadlineAt - Date.now()),
  ),
});

/**
 * WHY the corpus did not arrive, in a sentence that names the cause, the
 * address and who moves it — cli/doctor.ts planOverlapCheck already splits
 * these three states for the ghost endpoint and this is the same split.
 *
 * A bare "(http 404)" reads identically to a bare "(http 500)", and the two
 * need different people: 404 is a hub older than this CLI and nobody has to
 * be paged; anything else is an endpoint that exists and is failing.
 */
const corpusFailureLine = (
  failure: { readonly kind: string; readonly status: number; readonly message: string; readonly cause?: ConnectionCause },
  hubUrl: string,
  timeoutMs: number,
): string => {
  const spent = "Nothing was read and nothing was spent.";
  if (failure.kind === "http" && failure.status === HTTP_NOT_FOUND) {
    return (
      `this hub has no conference endpoint yet — it is older than this ` +
      `crosscheck. Ask whoever runs ${hubUrl} to update it. ${spent}`
    );
  }
  if (failure.kind === "http") {
    return (
      `the hub answered ${String(failure.status)} for /api/conference — the ` +
      `endpoint exists and is failing, so a conference is silent against ` +
      `${hubUrl} until somebody looks at it. ${spent}`
    );
  }
  if (failure.kind === "network") {
    return `${describeConnectionFailure(failure.cause ?? "unknown", { hubUrl, timeoutMs }, failure.message)}. ${spent}`;
  }
  // Malformed splits too: an unreadable body BEHIND an error status is
  // something other than a crosscheck hub answering on that port, while an
  // unreadable body behind a 200 is two versions that disagree on the shape.
  if (failure.status >= HTTP_CLIENT_ERROR) {
    return (
      `${hubUrl} answered ${String(failure.status)} and this crosscheck could ` +
      `not read the body — is a crosscheck hub really serving that address? ` +
      `${spent}`
    );
  }
  return (
    `this hub answered in a shape this crosscheck cannot read — the two are ` +
    `on different versions. ${spent}`
  );
};

/** UTC minute, filename-safe — stable, sortable, and no clock arithmetic. */
const reportStamp = (now: Date): string =>
  now.toISOString().slice(0, 16).replace(/[:T]/g, "-");

export const runConference = async (
  argv: readonly string[],
  env: Env,
  cwd: string,
  write: ConferenceWriter = writeToStdout,
): Promise<CliResult> => {
  const options = parseConferenceArgs(argv);
  if (options === null) {
    return { stdout: CONFERENCE_USAGE, exitCode: EXIT_USAGE };
  }
  const identity = await resolveRepoIdentity(cwd);
  if (identity === null) {
    return {
      stdout: "not a git repository — a conference is about one repo's work\n",
      exitCode: EXIT_USAGE,
    };
  }
  const config = await loadReportableConfig({ env, repoRoot: identity.root });
  if (config === null) {
    return {
      stdout:
        "this repo reports to no hub — run `crosscheck init` here first\n",
      exitCode: EXIT_USAGE,
    };
  }
  const now = new Date();
  const deadlineAt = now.getTime() + CONFERENCE_MAX_WALL_MS;
  const key = repoKey(config.hubUrl, identity.repoId);
  const hub: HubContext = {
    hubUrl: config.hubUrl,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    home: config.home,
    repoKey: key,
    now: () => new Date(),
  };
  const reading = withinWallClock(hub, deadlineAt);
  const corpus = await getConference(reading, identity.repoId);
  if (!corpus.ok) {
    // Deployment state, not a local fault — the ghost check's own distinction.
    await recordConferenceRun(config.home, key, { noHubAnswer: true }, now);
    return {
      stdout: `${corpusFailureLine(corpus, config.hubUrl, reading.timeoutMs)}\n`,
      exitCode: EXIT_UNREACHABLE,
    };
  }
  const sessions = comparableSessions(corpus.data);
  write(
    `conference: read ${String(corpus.data.contexts.length)} work contexts, ` +
      `${String(corpus.data.contexts.reduce((total, context) => total + context.claims.length, 0))} declared claims, ` +
      `${String(corpus.data.questions.length)} open questions and ` +
      `${String(corpus.data.contradictions.length)} contradiction candidates from ${config.hubUrl}`,
  );
  const model = await runModel(sessions, env, config.home, deadlineAt, write);
  const publishOutcome = options.publish
    ? await publishFindings(
        // The wall clock again, recomputed: a POST that aborts at the hook's
        // 400 ms after the hub already committed is how "published nothing"
        // becomes a lie about drafts that exist on teammates' trees.
        withinWallClock(hub, deadlineAt),
        identity.repoId,
        identity.branch,
        model.findings,
        env,
        now,
      )
    : { published: 0, problem: null };
  const report = renderConferenceReport({
    repoId: identity.repoId,
    corpus: corpus.data,
    findings: model.findings,
    modelOutcome: model.outcome,
    now,
  });
  const path = conferenceReportPath(config.home, key, reportStamp(now));
  await writePrivateFile(path, report);
  await recordConferenceRun(
    config.home,
    key,
    {
      findings: model.findings.length,
      published: publishOutcome.published,
      none: model.none,
      skipped: model.outcome.kind === "skipped",
      unreadable: model.unreadable,
      ...(model.failure === undefined ? {} : { failure: model.failure }),
    },
    now,
  );
  const findingsLine =
    model.findings.length === 0
      ? "no shared-cause finding"
      : `${String(model.findings.length)} shared-cause finding${model.findings.length === 1 ? "" : "s"}`;
  const publishLine = options.publish
    ? [
        publishOutcome.problem === null
          ? `published ${String(publishOutcome.published)} as derived drafts (review_draft promotes one)`
          : `published nothing: ${publishOutcome.problem}`,
      ]
    : [];
  return {
    stdout: [
      `conference: ${findingsLine}, ${String(corpus.data.overlaps.length)} duplicated-work pairs, ` +
        `${String(corpus.data.contradictions.length)} contradictions, ${String(corpus.data.questions.length)} open questions`,
      ...publishLine,
      `report: ${path}`,
      "",
    ].join("\n"),
    exitCode: EXIT_OK,
  };
};
