/**
 * Against a hub that sends no `sharedTerms` — 0.10.0 and older — the
 * connector counts the floor itself and fails closed (hold-out review, H4).
 * At least HINT_MIN_SHARED_TERMS of the prompt's content terms, by the shared
 * rule, must appear in the tree's title or in one DECLARED foreign claim body
 * on the wire; a tree whose wire carries no such body earns no hint at all.
 * An old hub ranked on its normalized document, drafts included, so its
 * candidates are exactly the ones a second look has to refuse.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { promptTerms } from "@crosscheck/schema";

import { repoKey } from "../src/config/paths.ts";
import { selectAndRenderHint } from "../src/flows/hint.ts";
import { selectHint } from "../src/hints/select.ts";
import type { HintClaimCandidate, HintContextCandidate } from "../src/http/hub.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import { SELF_DEVELOPER_ID, startHintHub } from "./fixtures/hint-hub.ts";
import type { HintHub } from "./fixtures/hint-hub.ts";
import { ROWS } from "./fixtures/holdout-round3/rows.ts";
import { TREES } from "./fixtures/holdout-round3/trees.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const ISO = "2026-08-10T08:00:00.000Z";
const SELF = "dev_self";
const PROMPT = "why does the zebrafrobnicator cache poison the quuxinator";

const claim = (overrides: Partial<HintClaimCandidate> = {}): HintClaimCandidate => ({
  id: "clm_1",
  workContextId: "wc_old",
  kind: "observation",
  status: "proposed",
  confidence: 0.6,
  provenance: "declared",
  captureMode: "agent",
  evidenceRefCount: 0,
  authorDeveloperId: "dev_nick",
  authorDeveloperName: "Nick",
  body: "The zebrafrobnicator cache poisons the quuxinator on every warm start",
  createdAt: ISO,
  ...overrides,
});

/** A candidate as an old hub ships it: fts tier, no sharedTerms, no evidenceBacked. */
const oldHubContext = (claims: readonly HintClaimCandidate[], title = "Nightly report formatting"): HintContextCandidate => ({
  workContext: {
    id: "wc_old",
    title,
    status: "analyzing",
    tier: "fts",
    developerId: "dev_nick",
    developerName: "Nick",
    baseCommit: "a1b2c3d4",
    createdAt: ISO,
    updatedAt: null,
  },
  claims,
  matchedTargets: [],
  matchedOn: "prompt",
});

const selectionFor = (context: HintContextCandidate) =>
  selectHint({
    candidates: [context],
    seenRefIds: [],
    deliveredCount: 0,
    selfDeveloperId: SELF,
    promptTerms: promptTerms(PROMPT).content,
    promptTopicalTerms: promptTerms(PROMPT).topical,
  });

describe("an old hub's candidate is recounted, and refused unless it clears the floor here", () => {
  test("the control: a declared foreign body sharing the prompt's words is pointed at", () => {
    expect(selectionFor(oldHubContext([claim()])).kind).toBe("pointer");
  });

  test("a draft-only tree gets no pointer — a draft's words are not on the wire as anybody's", () => {
    // Arrange — the old hub ranked it on the draft and shipped the draft's body
    const context = oldHubContext([claim({ provenance: "derived", captureMode: "auto", confidence: 0.4 })]);

    // Act + Assert
    expect(selectionFor(context).kind).toBe("silence");
  });

  test("a tree whose wire carries no body earns no hint, even on a title that shares the words", () => {
    // Arrange
    const context = oldHubContext([claim({ body: "" })], "Zebrafrobnicator cache poisons the quuxinator");

    // Act + Assert
    expect(selectionFor(context).kind).toBe("silence");
  });

  test("one shared word is not the floor", () => {
    // Arrange
    const context = oldHubContext([claim({ body: "The zebrafrobnicator was renamed last week" })]);

    // Act + Assert
    expect(selectionFor(context).kind).toBe("silence");
  });

  test("a refuted claim's words never qualify a tree — only a pushable claim's do (round 3, M5)", () => {
    // Arrange — the h4 probe's d2: an old hub ships a rejected hypothesis that
    // says the prompt's words, beside an unrelated declared observation that
    // would carry the pointer
    const refuted = claim({ id: "clm_refuted", kind: "hypothesis", status: "rejected", body: "The zebrafrobnicator cache poisons the quuxinator on warm start." });
    const unrelated = claim({ id: "clm_other", body: "The nightly report sorts its columns by date" });

    // Act + Assert
    expect(selectionFor(oldHubContext([refuted, unrelated])).kind).toBe("silence");
  });

  test("the reader's own body in the tree counts for nothing", () => {
    // Arrange
    const context = oldHubContext([claim({ authorDeveloperId: SELF })]);

    // Act + Assert
    expect(selectionFor(context).kind).toBe("silence");
  });

  /** A teammate's declared claim that shares nothing with the prompt. */
  const UNRELATED = claim({ id: "clm_unrelated", body: "The nightly report sorts its columns by date" });

  test("a draft's words never qualify a tree beside an unrelated declared claim", () => {
    // Arrange
    const context = oldHubContext([claim({ id: "clm_draft", provenance: "derived", captureMode: "auto", confidence: 0.4 }), UNRELATED]);

    // Act + Assert
    expect(selectionFor(context).kind).toBe("silence");
  });

  test("the reader's own words never qualify a tree beside an unrelated teammate claim", () => {
    // Arrange
    const context = oldHubContext([claim({ id: "clm_mine", authorDeveloperId: SELF }), UNRELATED]);

    // Act + Assert
    expect(selectionFor(context).kind).toBe("silence");
  });

  test.each([
    ["The session limit resets at midnight for every usage window", "pointer"],
    ["The zebrafrobnicator session limit is counted twice", "pointer"],
    ["The usage window closes at midnight", "silence"],
  ] as const)("round 4, M1: a task's meta words are its topic on the recount too, and one shared word is still none: %p", (body, kind) => {
    // Arrange — session, limit, resets, usage: round 3 (C1) counted them for nothing
    const context = oldHubContext([claim({ body })]);
    const terms = promptTerms("the session limit resets during the zebrafrobnicator usage report");

    // Act
    const selection = selectHint({
      candidates: [context],
      seenRefIds: [],
      deliveredCount: 0,
      selfDeveloperId: SELF,
      promptTerms: terms.content,
      promptTopicalTerms: terms.topical,
    });

    // Assert
    expect(selection.kind).toBe(kind);
  });

  test("an old hub's trees are ranked by the recount's own topical count, never the hub's order alone (round 3, follow-up)", () => {
    // Arrange — the old hub ranks the weaker tree first; both clear the floor
    const tree = (id: string, title: string, body: string): HintContextCandidate => ({
      ...oldHubContext([claim({ id: `clm_${id}`, workContextId: id, body })], title),
      workContext: { ...oldHubContext([], title).workContext, id },
    });
    const weaker = tree("wc_weaker", "Zebrafrobnicator cache sizing", "The zebrafrobnicator cache is sized per tenant");
    const stronger = tree("wc_stronger", "Nightly report formatting", "The zebrafrobnicator cache poisons the quuxinator on every warm start");

    // Act
    const selection = selectHint({
      candidates: [weaker, stronger],
      seenRefIds: [],
      deliveredCount: 0,
      selfDeveloperId: SELF,
      promptTerms: promptTerms(PROMPT).ranked,
      promptTopicalTerms: promptTerms(PROMPT).topical,
    });

    // Assert — the tree whose statement shares the most topical words is named, as the tip hub would
    expect(selection.kind === "pointer" ? selection.context.workContext.id : selection.kind).toBe("wc_stronger");
  });

  test("the recount's topical words decide before its shared ones, weak words among them (round 5, M2)", () => {
    // Arrange — the old hub ranks first a tree that shares more words, all but one of them weak
    const tree = (id: string, body: string): HintContextCandidate => ({
      ...oldHubContext([claim({ id: `clm_${id}`, workContextId: id, body })], "Nightly report formatting"),
      workContext: { ...oldHubContext([], "Nightly report formatting").workContext, id },
    });
    const weak = tree("wc_weak", "Fix the zebrafrobnicator issue on the user page");
    const topical = tree("wc_topical", "The zebrafrobnicator cache poisons the quuxinator");
    const terms = promptTerms("fix the zebrafrobnicator cache poison issue on the quuxinator user page");

    // Act
    const selection = selectHint({
      candidates: [weak, topical],
      seenRefIds: [],
      deliveredCount: 0,
      selfDeveloperId: SELF,
      promptTerms: terms.ranked,
      promptTopicalTerms: terms.topical,
    });

    // Assert — four topical words beat one topical and four weak ones
    expect(selection.kind === "pointer" ? selection.context.workContext.id : selection.kind).toBe("wc_topical");
  });

  test("a steering word never counts toward the recount", () => {
    // Arrange — the body shares "continue" and "please" and one task word
    const context = oldHubContext([claim({ body: "Please continue the zebrafrobnicator import" })]);

    // Act
    const selection = selectHint({
      candidates: [context],
      seenRefIds: [],
      deliveredCount: 0,
      selfDeveloperId: SELF,
      promptTerms: promptTerms("please continue the zebrafrobnicator work").content,
      promptTopicalTerms: promptTerms("please continue the zebrafrobnicator work").topical,
    });

    // Assert
    expect(selection.kind).toBe("silence");
  });
});

describe("the flow recounts on the prompt's own content terms", () => {
  const REPO_ID = "github.com/acme/api";
  const HOST_KEY = "old-hub-flow-uuid";
  const NOW = new Date("2026-08-19T12:00:00.000Z");
  const paths: string[] = [];
  const hubs: HintHub[] = [];

  afterEach(async () => {
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
    paths.length = 0;
    hubs.forEach((hub) => hub.stop());
    hubs.length = 0;
  });

  /** An old hub's wire shape: fts tier, no sharedTerms, a declared teammate body. */
  const oldHubWire = (body: string): Record<string, unknown> => ({
    workContext: { id: "wc_old", title: "Nightly report formatting", status: "analyzing", tier: "fts", developerId: "dev_nick", developerName: "Nick", baseCommit: "a1b2c3d4", createdAt: ISO, updatedAt: null },
    claims: [{ ...claim({ body }), authorDeveloperId: "dev_nick" }],
    matchedTargets: [],
    matchedOn: "prompt",
  });

  const hintFor = async (label: string, prompt: string, body: string, wire: (body: string) => Record<string, unknown> = oldHubWire): Promise<string> => {
    const home = await makeHome(label);
    const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
    paths.push(home, repo);
    const hub = startHintHub();
    hubs.push(hub);
    hub.setCandidates([wire(body)]);
    const key = repoKey(hub.url, REPO_ID);
    await writeSessionState(home, {
      hostSessionKey: HOST_KEY, crosscheckSessionId: `cc_${HOST_KEY}`, workContextId: `wc_cc_${HOST_KEY}`, repoId: REPO_ID, repoRoot: repo,
      hubUrl: hub.url, developerId: SELF_DEVELOPER_ID, startedAt: NOW.toISOString(), lastHeartbeatAt: null, seenTargets: [], deliveredHintRefs: [],
      deliveredHintHashes: [], tripwireAskedFiles: [], landedAskedFiles: [], landedCleanKeys: [],
    });
    return selectAndRenderHint({
      home, repoKey: key, hub: { hubUrl: hub.url, keyOrigin: hub.url, apiKey: "test-key", timeoutMs: 20_000, home, repoKey: key, now: () => NOW },
      hostSessionKey: HOST_KEY, repoId: REPO_ID, repoRoot: repo, agentKind: "acp:fake-agent", prompt, now: NOW,
    });
  };

  test("a body sharing two of the prompt's task words is pointed at", async () => {
    expect(await hintFor("ohf-shared", PROMPT, "The zebrafrobnicator cache poisons the quuxinator on every warm start")).toContain("crosscheck pointer");
  });

  test("an evidence-backed verdict the old hub never sent reads as absent: a settled cause stays a pointer (L2)", async () => {
    // Arrange — the wire default for evidenceBacked is NOT a vouch
    const settledCause = (body: string): Record<string, unknown> => {
      const wire = oldHubWire(body);
      const [only] = wire["claims"] as readonly Record<string, unknown>[];
      return { ...wire, claims: [{ ...only, kind: "root_cause", status: "likely_root_cause", evidenceRefCount: 1, matchedTerms: 3 }] };
    };

    // Act
    const hint = await hintFor("ohf-no-verdict", PROMPT, "The zebrafrobnicator cache poisons the quuxinator on every warm start.", settledCause);

    // Assert
    expect(hint).toContain("crosscheck pointer");
    expect(hint).not.toContain("crosscheck hint:");
  });

  describe("with every count strict substance (C2) asks for, but no verdict on the evidence", () => {
    /** The settled cause on its own tree, counted as C2 needs it, the hub's verdict on its evidence as given. */
    const settledCauseOnItsTree = (verdict: Record<string, unknown>) => (body: string): Record<string, unknown> => {
      const wire = oldHubWire(body);
      const [only] = wire["claims"] as readonly Record<string, unknown>[];
      return {
        ...wire,
        workContext: { ...(wire["workContext"] as Record<string, unknown>), title: "Zebrafrobnicator cache on warm start", matchedTerms: 2 },
        claims: [{ ...only, kind: "root_cause", status: "likely_root_cause", evidenceRefCount: 1, matchedTerms: 3, distinctTerms: 1, ...verdict }],
      };
    };

    test("a hub that sent no verdict: a pointer still (L2)", async () => {
      const hint = await hintFor("ohf-no-verdict-own", PROMPT, "The zebrafrobnicator cache poisons the quuxinator on every warm start.", settledCauseOnItsTree({}));
      expect(hint).toContain("crosscheck pointer");
      expect(hint).not.toContain("crosscheck hint:");
    });

    test("the control: a hub that vouches for the evidence gets the cause inline", async () => {
      const hint = await hintFor("ohf-verdict-own", PROMPT, "The zebrafrobnicator cache poisons the quuxinator on every warm start.", settledCauseOnItsTree({ evidenceBacked: true }));
      expect(hint).toContain("crosscheck hint:");
    });
  });

  test("round 4, M1: a body sharing a task's meta words is pointed at, as the tip hub points", async () => {
    expect(
      await hintFor(
        "ohf-meta",
        "the session limit resets during the zebrafrobnicator usage report",
        "The session limit resets at midnight for every usage window",
      ),
    ).toContain("crosscheck pointer");
  });

  test("a body sharing the prompt's steering words and one task word is not", async () => {
    expect(await hintFor("ohf-steering", "please continue the zebrafrobnicator work", "Please continue the zebrafrobnicator import")).toBe("");
  });

  describe("the recount is the hub's own rule (round 3, follow-up)", () => {
    /** One tree as an old hub ships it: its title, and one declared teammate body. */
    const treeWire = (title: string) => (body: string): Record<string, unknown> => ({
      ...oldHubWire(body),
      workContext: { ...(oldHubWire(body)["workContext"] as Record<string, unknown>), title },
    });

    /** The round-3 usage-dashboard tree, with its declared claims, as a 0.10.0 hub ships it. */
    const dashboardWire = (): Record<string, unknown> => {
      const tree = TREES.find((candidate) => candidate.id === "wc_usage_dashboard");
      return {
        ...oldHubWire(""),
        workContext: { ...(oldHubWire("")["workContext"] as Record<string, unknown>), id: "wc_usage_dashboard", title: tree?.title ?? "" },
        claims: (tree?.claims ?? []).map((member) => ({ ...claim({ id: member.id, workContextId: "wc_usage_dashboard", body: member.body }), kind: member.kind, status: member.status })),
      };
    };

    test("the round-3 status report gets no pointer at the usage dashboard (cf172)", async () => {
      // Arrange — 120 words about the session; "usage", "shows" and "wrong" are on the dashboard's title
      const report = ROWS.find((row) => row.id === "cf172")?.prompt ?? "";

      // Act
      const hint = await hintFor("ohf-cf172", report, "", dashboardWire);

      // Assert
      expect(report.length).toBeGreaterThan(0);
      expect(hint).toBe("");
    });

    test("a closed word's inflection is no topic: \"shows\" beside \"stopped\" clears nothing (L1, M1)", async () => {
      const wire = treeWire("Usage dashboard shows totals, then stopped");
      expect(await hintFor("ohf-shows", "the weekly export shows it, then stopped", "Tracked minutes are summed per tenant.", wire)).toBe("");
    });

    test("an intent on the wire is part of the tree's own statement, as on the hub", async () => {
      // Arrange — the title and the body say nothing of the prompt; the intent does
      const withIntent = (body: string): Record<string, unknown> => ({
        ...oldHubWire(body),
        workContext: {
          ...(oldHubWire(body)["workContext"] as Record<string, unknown>),
          intent: { summary: "Stop the zebrafrobnicator cache from poisoning warm starts", provenance: "declared", confidence: 0.9, capturedAt: ISO },
        },
      });

      // Act
      const hint = await hintFor("ohf-intent", PROMPT, "The nightly report renders in UTC.", withIntent);

      // Assert
      expect(hint).toContain("crosscheck pointer");
    });

    test("an inflection matches its word, as on the hub: \"uploads\" is \"upload\"", async () => {
      const wire = treeWire("Practice video upload fails above gateway body limit");
      expect(await hintFor("ohf-stems", "the uploads keep failing at the gateway", "The multipart URLs expire after an hour.", wire)).toContain(
        "crosscheck pointer",
      );
    });

    /** Seventeen words nobody wrote, ahead of the task: a long prompt to anyone who cannot see the team's text. */
    const LONG_LEAD = Array.from({ length: 17 }, (_, index) => `officeword${String.fromCharCode(97 + index)}`).join(" ");

    test("a long prompt needs three topical words on one statement, even when the wire shows few (M7)", async () => {
      expect(await hintFor("ohf-long-two", `${LONG_LEAD}. The zebrafrobnicator and the quuxinator`, "The zebrafrobnicator cache poisons the quuxinator on every warm start")).toBe("");
    });

    test("round 4, H1: the recount counts what was sent, and a long prompt's middle is sent now", async () => {
      // Arrange — the task sits in the middle of a paste the route's cap once cut to its head and tail
      const filler = "office ".repeat(200);
      const prompt = `${filler}The zebrafrobnicator cache poisons the quuxinator. ${filler}`;

      // Act
      const hint = await hintFor("ohf-window", prompt, "The zebrafrobnicator cache poisons the quuxinator on every warm start");

      // Assert — the ranked terms of all of it went on the wire, and the recount counts them
      expect(hint).toContain("crosscheck pointer");
    });

    test("the recount counts what was sent: task words the cap cut from a long prompt's terms count for nothing", async () => {
      // Arrange — two hundred distinct words nobody wrote, ranked before the
      // task: the terms the connector sends stop at MAX_SEARCH_QUERY_CHARS,
      // before the task's words, so the old hub never searched on them
      const lead = Array.from({ length: 200 }, (_, index) => `quokkafiller${String(index).padStart(3, "0")}`).join(" ");

      // Act
      const hint = await hintFor("ohf-cut", `${lead}. The zebrafrobnicator cache poisons the quuxinator`, "The zebrafrobnicator cache poisons the quuxinator on every warm start");

      // Assert
      expect(hint).toBe("");
    });

    test("words no statement on the wire says take no counted slot: the task after forty of them still counts (M7)", async () => {
      // Arrange — forty distinct words nobody wrote, then the task: more than HINT_MAX_COUNTED_TERMS ranked terms
      const lead = Array.from({ length: 40 }, (_, index) => `chatter${String(index).padStart(2, "0")}x`).join(" ");

      // Act
      const hint = await hintFor("ohf-known", `${lead}. The zebrafrobnicator cache and the quuxinator`, "The zebrafrobnicator cache poisons the quuxinator on every warm start");

      // Assert
      expect(hint).toContain("crosscheck pointer");
    });

    test("the recount counts the ranked terms, as the hub: a command clause's words count for nothing", async () => {
      expect(await hintFor("ohf-ranked", "commit and push. then the zebrafrobnicator", "Commit the zebrafrobnicator fix and push it")).toBe("");
    });

    test("the control: three topical words clear a long prompt", async () => {
      expect(
        await hintFor("ohf-long-three", `${LONG_LEAD}. The zebrafrobnicator cache and the quuxinator`, "The zebrafrobnicator cache poisons the quuxinator on every warm start"),
      ).toContain("crosscheck pointer");
    });
  });
});
