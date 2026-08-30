/**
 * The detached derived-intent worker (trial finding #16) — the summarizer
 * worker's shape (summarizer/worker.ts), spawned by the UserPromptSubmit hook
 * on the FIRST substantive prompt and never waited for. It reads the prompt
 * the hook parked in a 0600 file, hands it to the runner (runSummarizer, the
 * bounded, killable, child-marked spawn), and appends ONE work_context UPDATE
 * record carrying the intent to the spool; the next hook's flush ships it.
 *
 * PRIVACY IS THE SHAPE OF THIS FILE. The raw prompt never leaves the machine:
 * it goes from the file to the model's stdin and the file is unlinked in
 * `finally`, whatever happens. The ONLY thing that can leave is the model's
 * one sentence, and only after, in order: the NONE parse, the bound
 * (MAX_INTENT_SUMMARY_CHARS), the echo-loop exclusion (a teammate's hint
 * must not come back as this session's intent), the secret scan (a hit
 * DROPS, never redacts), and the shared wire contract (IntentSchema — the
 * derived cap, the fixed INTENT_DERIVED_CONFIDENCE). Every outcome is booked
 * in session state — NONE, set, or a failure with its reason — so the cost
 * surfaces can say what became of the fire (the finding-#14 lesson).
 *
 * Fail open everywhere: every early return is silent, exit code always 0.
 */
import { IntentSchema, MAX_INTENT_SUMMARY_CHARS, parseRecord } from "@crosscheck/schema";

import {
  DEFAULT_AGENT_KIND,
  EXIT_OK,
  INTENT_DERIVED_CONFIDENCE,
} from "../../constants.ts";
import { cutWellFormed } from "../../briefing/cut.ts";
import {
  crosscheckHome,
  readTextOrNull,
  removeFile,
  repoKey,
} from "../../config/paths.ts";
import type { Env } from "../../config/paths.ts";
import {
  UNKNOWN_DEVELOPER_ID,
  workContextRecord,
} from "../../capture/records.ts";
import { containsSecret } from "../../capture/secret-scan.ts";
import { readDeliveredHintHashes } from "../../hints/delivered-store.ts";
import { isEchoOfDeliveredHint } from "../../hints/echo.ts";
import { appendRecords } from "../../spool/append.ts";
import {
  readSessionState,
  updateSessionState,
  withRecordedIntent,
} from "../../state/session-state.ts";
import type { SessionState } from "../../state/session-state.ts";
import { withIntentFailure, withIntentNone, withIntentSet } from "./gate.ts";
import { resolveIntentArgv } from "./prompt.ts";
import { readModelSentence } from "../../model/parse.ts";
import {
  formatSummarizerFailure,
  resolveSummarizerTimeoutMs,
  runSummarizer,
} from "../../model/runner.ts";
import { ensureSummarizerCwd } from "../../model/worker-env.ts";

export interface IntentWorkerArgs {
  readonly claudeSessionId: string;
  readonly promptFile: string;
}

const flagValue = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

export const parseIntentWorkerArgs = (
  args: readonly string[],
): IntentWorkerArgs | null => {
  const claudeSessionId = flagValue(args, "--session");
  const promptFile = flagValue(args, "--prompt-file");
  if (claudeSessionId === undefined || promptFile === undefined) {
    return null;
  }
  return { claudeSessionId, promptFile };
};

/** Booked drops, named so status/doctor can say why a fire landed nothing. */
const DROPPED_NO_TITLE = "dropped: session state predates intent support (no title)";
const DROPPED_EMPTY_PROMPT = "dropped: empty prompt";
const DROPPED_EMPTY_ANSWER = "dropped: empty answer";
const DROPPED_NOT_SENTENCE = "dropped: the answer was not a sentence";
const DROPPED_ECHO = "dropped: the sentence echoes a delivered hint";
const DROPPED_SECRET = "dropped: secret-like text";
const DROPPED_CONTRACT = "dropped: the record failed the wire contract";

const bookFailure = (home: string, sessionId: string, detail: string): Promise<boolean> =>
  updateSessionState(home, sessionId, (fresh) => withIntentFailure(fresh, detail));

const deriveIntent = async (args: IntentWorkerArgs, env: Env): Promise<void> => {
  const home = crosscheckHome(env);
  // The prompt file is read ONCE and removed whatever follows — a session
  // that ended, a runner that failed, a dropped sentence: nothing may leave
  // the first prompt on disk past this run.
  const prompt = (await readTextOrNull(args.promptFile)) ?? "";
  await removeFile(args.promptFile);

  const state = await readSessionState(home, args.claudeSessionId);
  if (state === null) {
    return;
  }
  if (prompt.trim().length === 0) {
    await bookFailure(home, args.claudeSessionId, DROPPED_EMPTY_PROMPT);
    return;
  }
  if (state.workContextTitle === null || state.workContextStatus === null) {
    // A pre-upgrade state file: the update record needs title + status and
    // fabricating either would upload a title this session never chose.
    await bookFailure(home, args.claudeSessionId, DROPPED_NO_TITLE);
    return;
  }

  const result = await runSummarizer(
    resolveIntentArgv(env),
    prompt,
    resolveSummarizerTimeoutMs(env),
    env,
    // From the neutral directory, never the repo root (trial finding #14).
    { cwd: await ensureSummarizerCwd(home) },
  );
  if (!result.ok) {
    await bookFailure(home, args.claudeSessionId, formatSummarizerFailure(result));
    return;
  }
  // ONE read of stdout, and the shape is part of the contract: this task
  // asked for a sentence, so claim JSON — what a wrapper carrying the
  // SUMMARIZER's instruction answers, the argv being identical — is refused
  // and booked, never published as this developer's intent.
  const answer = readModelSentence(result.stdout);
  if (answer.kind === "none") {
    await updateSessionState(home, args.claudeSessionId, withIntentNone);
    return;
  }
  if (answer.kind === "unreadable") {
    await bookFailure(
      home,
      args.claudeSessionId,
      answer.why === "empty" ? DROPPED_EMPTY_ANSWER : DROPPED_NOT_SENTENCE,
    );
    return;
  }
  const sentence = cutWellFormed(answer.text, MAX_INTENT_SUMMARY_CHARS);
  if (sentence.length === 0) {
    await bookFailure(home, args.claudeSessionId, DROPPED_EMPTY_ANSWER);
    return;
  }

  // FRESH state for the exclusions: hints may have been delivered while the
  // model ran, and a session that ended meanwhile has nothing to attribute
  // to — its state file is gone and the intent dies with it (honest).
  const fresh = await readSessionState(home, args.claudeSessionId);
  if (fresh === null) {
    return;
  }
  const persistedHashes = await readDeliveredHintHashes(
    home,
    repoKey(fresh.hubUrl, fresh.repoId),
  );
  if (isEchoOfDeliveredHint(sentence, [...fresh.deliveredHintHashes, ...persistedHashes])) {
    await bookFailure(home, args.claudeSessionId, DROPPED_ECHO);
    return;
  }
  if (containsSecret(sentence)) {
    await bookFailure(home, args.claudeSessionId, DROPPED_SECRET);
    return;
  }
  await appendIntent(home, args.claudeSessionId, fresh, sentence, env);
};

const appendIntent = async (
  home: string,
  claudeSessionId: string,
  fresh: SessionState,
  sentence: string,
  env: Env,
): Promise<void> => {
  const now = new Date();
  const intent = IntentSchema.safeParse({
    summary: sentence,
    // Derived semantics, non-negotiable: the model chose the sentence;
    // provenance and confidence are forced here, under the derived cap.
    provenance: "derived",
    confidence: INTENT_DERIVED_CONFIDENCE,
    capturedAt: now.toISOString(),
  });
  if (!intent.success || fresh.workContextTitle === null || fresh.workContextStatus === null) {
    await bookFailure(home, claudeSessionId, DROPPED_CONTRACT);
    return;
  }
  const envelope = workContextRecord(
    {
      workContextId: fresh.workContextId,
      sessionId: fresh.crosscheckSessionId,
      title: fresh.workContextTitle,
      status: fresh.workContextStatus,
      intent: intent.data,
    },
    {
      developerId: fresh.developerId ?? UNKNOWN_DEVELOPER_ID,
      agentKind: env["CROSSCHECK_AGENT_KIND"] ?? DEFAULT_AGENT_KIND,
      sessionId: fresh.crosscheckSessionId,
    },
    now,
  );
  // The shared wire contract, reused not duplicated: what the hub would
  // refuse never enters the spool.
  if (!parseRecord(envelope).ok) {
    await bookFailure(home, claudeSessionId, DROPPED_CONTRACT);
    return;
  }
  await appendRecords(
    home,
    repoKey(fresh.hubUrl, fresh.repoId),
    claudeSessionId,
    [envelope],
    now,
  );
  // Booked AFTER the spool append: "intent set" means the record exists on
  // disk, not that the model merely offered a sentence (telemetry honesty).
  // The same write records the sentence and opens the ghost debt (VISION §3):
  // a derived intent is a plan like a declared one, and the next prompt hook
  // compares it against the team's — this worker deliberately does NOT run
  // that check itself, so one detached process stays one model call.
  await updateSessionState(home, claudeSessionId, (state) =>
    withIntentSet(withRecordedIntent(state, sentence)),
  );
};

/** Entry point behind intent/worker-entry.ts — always exits 0. */
export const runIntentWorker = async (
  args: readonly string[],
  env: Env,
): Promise<number> => {
  try {
    const parsed = parseIntentWorkerArgs(args);
    if (parsed !== null) {
      await deriveIntent(parsed, env);
    }
  } catch {
    // Fail open: a lost intent is the cheap outcome.
  }
  return EXIT_OK;
};
