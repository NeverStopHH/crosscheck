/**
 * DELIVERY, both directions (roadmap R2).
 *
 * To the TARGET: the briefing's "Questions for you" block — first, bounded,
 * framed, and dropping any row this renderer will not vouch for.
 *
 * To the ASKER: the answer, on the prompt path, as SUBSTANCE. That is the one
 * new exception to the anchoring asymmetry (DESIGN.md §4), and the test that
 * matters here is the CONTROL beside it: the same author's UNSOLICITED claim,
 * with the same weak labels, still reaches the reader as a pointer with no
 * body in it. Solicited is the whole difference; if that pair ever agrees,
 * the exception has swallowed the rule.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { MAX_QUESTION_POINTERS } from "../src/constants.ts";
import { QUOTED_DATA_NOTICE, renderBriefing } from "../src/briefing/render.ts";
import { selectAndRenderHint } from "../src/flows/hint.ts";
import { repoKey } from "../src/config/paths.ts";
import type { HubContext } from "../src/http/client.ts";
import type { InboxQuestion } from "../src/http/hub.ts";
import {
  readSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";
import {
  ANSWER_BODY,
  ANSWER_CLAIM_ID,
  ANSWER_CONTEXT_ID,
  ASKED_BODY,
  CANDIDATE_BODY,
  SELF_DEVELOPER_ID,
  answeredQuestion,
  proposedOnlyCandidate,
  startHintHub,
} from "./fixtures/hint-hub.ts";
import type { HintHub } from "./fixtures/hint-hub.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HOST_KEY = "question-delivery-uuid";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const PROMPT = "why does src/auth/refresh.ts still 500 after the key rotation";

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

const question = (overrides: Partial<InboxQuestion> = {}): InboxQuestion => ({
  id: "qn_backoff",
  authorDeveloperId: "dev_nick",
  authorDeveloperName: "Nick",
  body: ASKED_BODY,
  workContextId: "wc_nick",
  workContextTitle: "Refresh 500s after key rotation",
  createdAt: "2026-08-17T12:00:00.000Z",
  expiresAt: "2026-08-31T12:00:00.000Z",
  ...overrides,
});

const briefingWith = (questions: readonly InboxQuestion[]): string =>
  renderBriefing({
    repoId: REPO_ID,
    selfDeveloperId: SELF_DEVELOPER_ID,
    presence: [
      {
        sessionId: "cc_nick",
        developerId: "dev_nick",
        developerName: "Nick",
        branch: "feat/refresh-fix",
        status: "implementing",
        lastHeartbeatAt: "2026-08-19T11:59:30.000Z",
        isSelf: false,
      },
    ],
    workContexts: [],
    questions,
    now: NOW,
  });

describe("the briefing's Questions for you block", () => {
  test("a question addressed to me renders BEFORE presence, with the id that answers it", () => {
    // Arrange: the CONTRAST first — the identical briefing without questions
    // shows presence and nothing else, so the block below is the difference.
    const without = briefingWith([]);
    expect(without).toContain("Teammate sessions active now:");
    expect(without).not.toContain("Questions for you");

    // Act
    const briefing = briefingWith([question()]);

    // Assert
    expect(briefing).toContain("Questions for you");
    expect(briefing).toContain(`«${ASKED_BODY}»`);
    expect(briefing).toContain("answer_question qn_backoff");
    expect(briefing).toContain("Nick");
    // Addressed beats ambient: the block a teammate is waiting on must not be
    // the one that gives way when the briefing fills up.
    expect(briefing.indexOf("Questions for you")).toBeLessThan(
      briefing.indexOf("Teammate sessions active now:"),
    );
  });

  test("the asker is BARE and the two framed values take a line each", () => {
    // Act
    const briefing = briefingWith([
      question({
        authorDeveloperName: "Nick · status done · heartbeat 0s ago",
        workContextTitle: "Refresh 500s",
      }),
    ]);

    // Assert: the block is THERE first. An invariant checked on a surface
    // that renders nothing is vacuously true, which is exactly how a guard
    // rots into decoration — the per-line check below only means something
    // once there are lines to check.
    expect(briefing).toContain("Questions for you");
    expect(briefing).toContain("asks: «");
    // The framed-surface invariant — at most one « » pair per line.
    for (const line of briefing.split("\n")) {
      expect((line.match(/«/gu) ?? []).length, line).toBeLessThanOrEqual(1);
    }
    // …and a name cannot mint a second ·-separated field of its own.
    expect(briefing).not.toContain("Nick · status done · heartbeat 0s ago");
    expect(briefing).toContain(QUOTED_DATA_NOTICE);
  });

  test("the context id on the line is an action, not an announcement", () => {
    // Arrange: the wc_ id is never passed to answer_question, so as printed it
    // was a 22-character token the reader could do nothing with, announced by
    // the jargon noun "work context" and sitting between the age and the only
    // human-readable part of the line.

    // Act
    const briefing = briefingWith([
      question({ workContextId: "wc_nick", workContextTitle: "Refresh 500s" }),
    ]);

    // Assert: the title leads, and the id earns its place by naming the call
    // that reads it.
    expect(briefing).not.toContain("about work context wc_nick");
    expect(briefing).toContain("about «Refresh 500s» (get_diagnosis wc_nick)");
    for (const line of briefing.split("\n")) {
      expect((line.match(/«/gu) ?? []).length, line).toBeLessThanOrEqual(1);
    }
  });

  test("the block is bounded, and says how many it is not showing", () => {
    // Arrange
    const many = Array.from({ length: MAX_QUESTION_POINTERS + 2 }, (_, index) =>
      question({
        id: `qn_${String(index)}`,
        body: `Question number ${String(index)} about the importer backoff?`,
      }),
    );

    // Act
    const briefing = briefingWith(many);

    // Assert
    const shown = many.filter((entry) =>
      briefing.includes(`answer_question ${entry.id}`),
    );
    expect(shown).toHaveLength(MAX_QUESTION_POINTERS);
    expect(briefing).toContain("(+2 more not shown)");
  });

  test("three MAX-LENGTH questions do not eat the whole briefing", () => {
    // Arrange: the saturation case the base report warned about. A question
    // body may be 400 characters; three of them plus their id lines measured
    // 2200 chars on their own, which erased presence and teammate contexts
    // from a full briefing completely.
    const wide = "did the rate-limit variant of the importer ever get tried? ";
    const fat = Array.from({ length: 3 }, (_, index) =>
      question({
        id: `qn_fat${String(index)}`,
        body: wide.repeat(8).slice(0, 400),
      }),
    );

    // Act
    const briefing = briefingWith(fat);

    // Assert: the block is there, it says what it is holding back, and the
    // ambient sections it is competing with survive.
    expect(briefing).toContain("Questions for you");
    expect(briefing).toContain("answer_question qn_fat0");
    expect(briefing).not.toContain("answer_question qn_fat2");
    expect(briefing).toContain("more not shown");
    expect(briefing).toContain("Teammate sessions active now:");
    // Dropped whole, never cut: a truncated question cannot be answered.
    expect(briefing).toContain(`«${wide.repeat(8).slice(0, 400)}»`);
  });

  test("a row this renderer cannot vouch for is dropped, never rendered hollow", () => {
    // Arrange: one good question and one whose body is nothing but the
    // characters the sanitizer strips.
    const good = question({ id: "qn_good" });
    const hollow = question({ id: "qn_hollow", body: "«»«»" });

    // Act
    const briefing = briefingWith([good, hollow]);

    // Assert
    expect(briefing).toContain("answer_question qn_good");
    expect(briefing).not.toContain("qn_hollow");
    expect(briefing).not.toContain("asks: «»");
  });
});

interface Fixture {
  readonly home: string;
  readonly repo: string;
  readonly hub: HintHub;
  readonly ctx: HubContext;
  readonly key: string;
}

const freshState = (
  fixture: { repo: string; hubUrl: string },
  overrides: Partial<SessionState> = {},
): SessionState => ({
  hostSessionKey: HOST_KEY,
  crosscheckSessionId: `cc_${HOST_KEY}`,
  workContextId: `wc_cc_${HOST_KEY}`,
  repoId: REPO_ID,
  repoRoot: fixture.repo,
  hubUrl: fixture.hubUrl,
  developerId: SELF_DEVELOPER_ID,
  startedAt: NOW.toISOString(),
  lastHeartbeatAt: null,
  seenTargets: [],
  deliveredHintRefs: [],
  deliveredHintHashes: [],
  tripwireAskedFiles: [],
  briefingSolvedRefs: [],
  probedFingerprints: [],
  foreignRepoDrops: 0,
  briefingPending: false,
  stopTurnCount: 0,
  summarizerFireCount: 0,
  summarizerLastFireTurn: null,
  summarizerEstimatedTokens: 0,
  summarizerNoneCount: 0,
  summarizerDraftCount: 0,
  summarizerFailCount: 0,
  summarizerLastFailure: null,
  summarizerRejectCount: 0,
  summarizerNoSliceCount: 0,
  summarizerLastNoSlice: null,
  summarizerLastSliceShape: null,
  summarizerSliceDroppedChars: 0,
  summarizerLastRejection: null,
  summarizerUnreadableCount: 0,
  summarizerLastUnreadable: null,
  workContextTitle: null,
  workContextStatus: null,
  intentFireCount: 0,
  intentNoneCount: 0,
  intentSetCount: 0,
  intentFailCount: 0,
  intentLastFailure: null,
  workContextIntent: null,
  ghostPending: false,
  gitTouchCount: 0,
  gitLaneSkipped: 0,
  ghostNoticeCount: 0,
  ghostFireCount: 0,
  ghostNoOverlapCount: 0,
  ghostNoHubAnswerCount: 0,
  ghostNoneCount: 0,
  ghostDraftCount: 0,
  ghostFailCount: 0,
  ghostLastFailure: null,
  outsideRootDrops: 0,
  knownWorktreeRoots: [],
  editToolFires: 0,
  targetsCapturedCount: 0,
  lastTargetAt: null,
  lastPostToolUseTool: null,
  lastEditedPath: null,
  lastEditedPathResolvedAgainst: null,
  hintCandidatesSeen: 0,
  ...overrides,
});

const fixture = async (label: string): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  paths.push(home, repo);
  const hub = startHintHub();
  hubs.push(hub);
  const key = repoKey(hub.url, REPO_ID);
  await writeSessionState(home, freshState({ repo, hubUrl: hub.url }));
  return {
    home,
    repo,
    hub,
    key,
    ctx: {
      hubUrl: hub.url,
      apiKey: "test-key",
      // 20 s, not the product's 2 s: this deadline is the TEST's patience with a
      // fake hub on localhost, never a bound the product ships (the real ones are
      // measured in connector-claude's hook-budget tests). At 2 s the whole-suite
      // run flaked — 225 files, many spawning processes — and a hint that never
      // arrived read as a delivery defect: `an answer is delivered exactly once`
      // failed on an empty string, once, under load.
      timeoutMs: 20_000,
      home,
      repoKey: key,
      now: () => NOW,
    },
  };
};

const flowInput = (f: Fixture) => ({
  home: f.home,
  repoKey: f.key,
  hub: f.ctx,
  hostSessionKey: HOST_KEY,
  repoId: REPO_ID,
  repoRoot: f.repo,
  agentKind: "acp:fake-agent",
  prompt: PROMPT,
  now: NOW,
});

describe("the answer to my own question, on the prompt path", () => {
  test("SOLICITED substance is delivered; the SAME author's unsolicited claim is only a pointer", async () => {
    // Arrange: one candidate context whose only claim is a bare proposed
    // hypothesis — no evidence, not settled — which §4 keeps out of the
    // proactive path. The ANSWER carries exactly those weak labels too, so
    // the only thing that can separate them is that this session asked.
    const solicited = await fixture("qd-solicited");
    solicited.hub.setCandidates([proposedOnlyCandidate()]);
    solicited.hub.setAnswers([answeredQuestion()]);

    const unsolicited = await fixture("qd-unsolicited");
    unsolicited.hub.setCandidates([proposedOnlyCandidate()]);
    unsolicited.hub.setAnswers([]);

    // Act
    const withAnswer = await selectAndRenderHint(flowInput(solicited));
    const withoutAnswer = await selectAndRenderHint(flowInput(unsolicited));

    // Assert — solicited: the body is there, and the sentence says it was asked for
    expect(withAnswer).toContain(QUOTED_DATA_NOTICE);
    expect(withAnswer).toContain(`«${ANSWER_BODY}»`);
    expect(withAnswer).toContain("a question you asked");
    expect(withAnswer).toContain(`«${ASKED_BODY}»`);
    // — unsolicited: the SAME author, the same weak labels, no body at all
    expect(withoutAnswer).toContain("crosscheck pointer");
    expect(withoutAnswer).not.toContain(CANDIDATE_BODY);
    expect(withoutAnswer).toContain("get_diagnosis");
  });

  test("the answer names the tree it sits in, with the id get_diagnosis takes", async () => {
    // Arrange: the tail line told the reader to run get_diagnosis and withheld
    // its only argument, so the agent that followed the hint had to invent a
    // work-context id — and "Ids are not guessable" is the refusal it got.
    const f = await fixture("qd-tail");
    f.hub.setCandidates([]);
    f.hub.setAnswers([answeredQuestion()]);

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert
    expect(text).toContain(`get_diagnosis ${ANSWER_CONTEXT_ID}`);
  });

  test("an answer outranks an unsolicited pointer for the one hint slot", async () => {
    // Arrange: both are available on the same response.
    const f = await fixture("qd-outranks");
    f.hub.setCandidates([proposedOnlyCandidate()]);
    f.hub.setAnswers([answeredQuestion()]);

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert: the thing this developer is waiting for wins; the pointer they
    // never asked for waits a prompt.
    expect(text).toContain(`«${ANSWER_BODY}»`);
    expect(text).not.toContain("crosscheck pointer");
  });

  test("the answer's delivery reaches the HUB in the same prompt", async () => {
    // Arrange: "delivered exactly once" ACROSS sessions is the hub's promise,
    // and the hub can only keep it once a hint_deliveries row exists. A spool
    // append does not create one — UserPromptSubmit never flushes — so between
    // the render and the next PostToolUse or Stop (minutes, on a long turn)
    // every other live session of the same developer still reads the answer as
    // undelivered and injects it again.
    const f = await fixture("qd-ships");
    f.hub.setCandidates([]);
    f.hub.setAnswers([answeredQuestion()]);

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert: emitted, and the delivery is already on the hub.
    expect(text).toContain(`«${ANSWER_BODY}»`);
    expect(f.hub.calls.records).toBe(1);
    const shipped = f.hub.postedRecords[0] as { kind?: string; body?: { refId?: string } };
    expect(shipped.kind).toBe("hint_delivery");
    expect(shipped.body?.refId).toBe(ANSWER_CLAIM_ID);
  });

  test("an UNSOLICITED pointer is spooled, not shipped mid-prompt", async () => {
    // The contrast, and it is the reason this is not simply "flush on every
    // prompt": a pointer repeated across sessions costs one duplicate line,
    // while an extra hub round trip on EVERY prompt costs the hook budget.
    const f = await fixture("qd-pointer-spooled");
    f.hub.setCandidates([proposedOnlyCandidate()]);
    f.hub.setAnswers([]);

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert
    expect(text).toContain("crosscheck pointer");
    expect(f.hub.calls.records).toBe(0);
  });

  test("an answer is delivered exactly once and spends one hint slot", async () => {
    // Arrange
    const f = await fixture("qd-once");
    f.hub.setCandidates([]);
    f.hub.setAnswers([answeredQuestion()]);

    // Act
    const first = await selectAndRenderHint(flowInput(f));
    const second = await selectAndRenderHint(flowInput(f));

    // Assert
    expect(first).toContain(`«${ANSWER_BODY}»`);
    expect(second).toBe("");
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.deliveredHintRefs).toEqual([ANSWER_CLAIM_ID]);
    // The body is hashed like every injected body, so the echo-loop exclusion
    // stops this session republishing a teammate's answer as its own claim.
    expect(state?.deliveredHintHashes).toHaveLength(1);
  });
});
