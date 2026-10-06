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
      home, repoKey: key, hub: { hubUrl: hub.url, apiKey: "test-key", timeoutMs: 20_000, home, repoKey: key, now: () => NOW },
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

  test("a body sharing the prompt's steering words and one task word is not", async () => {
    expect(await hintFor("ohf-steering", "please continue the zebrafrobnicator work", "Please continue the zebrafrobnicator import")).toBe("");
  });
});
