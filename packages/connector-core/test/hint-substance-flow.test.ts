/**
 * The substance hint end to end through `selectAndRenderHint` (DESIGN.md §4,
 * revised after the 2026-10 pilot): a strong, evidence-backed match arrives
 * WITH its finding — one sentence of it, quoted, plus the pointer to the
 * rest — in the same one hub call; a weak match on the same claim arrives as
 * the pointer it always was.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { SUBSTANCE_DELIVERY_CHANNEL } from "@crosscheck/schema";

import { selectAndRenderHint } from "../src/flows/hint.ts";
import { QUOTED_DATA_NOTICE } from "../src/briefing/render.ts";
import { repoKey, sessionSlug } from "../src/config/paths.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import type { HubContext } from "../src/http/client.ts";
import { hintBodyHash } from "../src/hints/echo.ts";
import { readSessionState, writeSessionState } from "../src/state/session-state.ts";
import {
  SELF_DEVELOPER_ID,
  rejectedApproachCandidate,
  startHintHub,
} from "./fixtures/hint-hub.ts";
import type { HintHub } from "./fixtures/hint-hub.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HOST_KEY = "substance-flow-uuid";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const PROMPT = "why does the practice upload hit the gateway body limit";
const FIRST = "Keep the chunked upload for practice videos.";
const BODY = `${FIRST} The single PUT hits the gateway body limit above 2 GB.`;

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

interface Fixture {
  readonly home: string;
  readonly repo: string;
  readonly hub: HintHub;
  readonly ctx: HubContext;
  readonly key: string;
}

const fixture = async (label: string): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  paths.push(home, repo);
  const hub = startHintHub();
  hubs.push(hub);
  const key = repoKey(hub.url, REPO_ID);
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY,
    crosscheckSessionId: `cc_${HOST_KEY}`,
    workContextId: `wc_cc_${HOST_KEY}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: hub.url,
    developerId: SELF_DEVELOPER_ID,
    startedAt: NOW.toISOString(),
    lastHeartbeatAt: null,
    seenTargets: [],
    deliveredHintRefs: [],
    deliveredHintHashes: [],
    tripwireAskedFiles: [],
    landedAskedFiles: [],
    landedCleanKeys: [],
  });
  return {
    home,
    repo,
    hub,
    key,
    ctx: { hubUrl: hub.url, apiKey: "test-key", timeoutMs: 20_000, home, repoKey: key, now: () => NOW },
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

/**
 * Ken's practice-upload tree as a hub answers it: an evidence-backed
 * DECISION sharing `matchedTerms` words with the prompt, beside two
 * claims of his that are not substance.
 */
const decisionTree = (matchedTerms: number): Record<string, unknown> => {
  const base = rejectedApproachCandidate();
  const [claim] = base["claims"] as readonly Record<string, unknown>[];
  return {
    ...base,
    claims: [
      { ...claim, id: "clm_decision", kind: "decision", status: "proposed", body: BODY, matchedTerms },
      { ...claim, id: "clm_obs", kind: "observation", status: "proposed", evidenceRefCount: 0, matchedTerms: 0 },
      { ...claim, id: "clm_hyp", kind: "hypothesis", status: "proposed", evidenceRefCount: 0, matchedTerms: 1 },
    ],
  };
};

describe("a strong, evidence-backed match carries its substance", () => {
  test("the decision arrives as one quoted sentence, plus the pointer to the rest", async () => {
    // Arrange
    const f = await fixture("sf-strong");
    f.hub.setCandidates([decisionTree(4)]);

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert — quoted data under the notice, the kind beside the labels,
    // one sentence, and the rest one named call away; ONE hub call
    expect(text).toContain(QUOTED_DATA_NOTICE);
    expect(text).toContain("· decision ·");
    expect(text).toContain(`«${FIRST}»`);
    expect(text).not.toContain("single PUT");
    expect(text).toContain("2 more claims");
    expect(text).toContain("get_diagnosis wc_nick");
    expect(f.hub.calls.candidates).toBe(1);
  });

  test("the echo mark covers the sentence that was shown", async () => {
    // Arrange
    const f = await fixture("sf-echo");
    f.hub.setCandidates([decisionTree(4)]);

    // Act
    await selectAndRenderHint(flowInput(f));

    // Assert
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.deliveredHintHashes).toEqual([hintBodyHash(FIRST)]);
  });
});

/** The channel of the one hint_delivery record the flow spooled. */
const spooledChannel = async (f: Fixture): Promise<unknown> => {
  const spool = await readSessionSpool(f.home, f.key, sessionSlug(HOST_KEY));
  const record = JSON.parse(spool.lines[0] ?? "{}") as {
    kind?: string;
    body?: { channel?: unknown };
  };
  expect(record.kind).toBe("hint_delivery");
  return record.body?.channel;
};

describe("an inline finding is still counted, on a channel of its own", () => {

  test("substance is booked as prompt_substance, so the pilot never counts it as opened", async () => {
    // Arrange
    const f = await fixture("sf-channel");
    f.hub.setCandidates([decisionTree(4)]);

    // Act
    await selectAndRenderHint(flowInput(f));

    // Assert
    expect(await spooledChannel(f)).toBe(SUBSTANCE_DELIVERY_CHANNEL);
  });

  test("a decision with no sentence worth showing is a pointer, booked as one", async () => {
    // Arrange — the trust and the match are there; the substance is not
    const f = await fixture("sf-channel-empty");
    const tree = decisionTree(4);
    const [first, ...rest] = tree["claims"] as readonly Record<string, unknown>[];
    f.hub.setCandidates([{ ...tree, claims: [{ ...first, body: "Bestätigt." }, ...rest] }]);

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert — prompt_substance only ever books a finding that was shown
    expect(text).toContain("crosscheck pointer:");
    expect(await spooledChannel(f)).toBe("prompt_hint");
  });

  test("a pointer stays on prompt_hint", async () => {
    // Arrange
    const f = await fixture("sf-channel-pointer");
    f.hub.setCandidates([decisionTree(1)]);

    // Act
    await selectAndRenderHint(flowInput(f));

    // Assert
    expect(await spooledChannel(f)).toBe("prompt_hint");
  });
});

describe("a weak match keeps today's pointer-only form", () => {
  test("the same decision sharing one word arrives as a pointer, no body", async () => {
    // Arrange
    const f = await fixture("sf-weak");
    f.hub.setCandidates([decisionTree(1)]);

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert
    expect(text).toContain("crosscheck pointer:");
    expect(text).toContain("It carries 3 claims crosscheck does not inject unasked");
    // The tail says WHY, and "evidence-backed" alone would be false here:
    // this decision has evidence; what it lacks is a strong match.
    expect(text).toContain("substance is pushed only for a strongly matched, evidence-backed finding");
    expect(text).not.toContain("Keep the chunked upload");
  });
});

describe("a finding that cannot fit beside its trailers is pointed at, never cut", () => {
  /** The longest id a hub sends, so the pointer line is at its widest. */
  const LONG_ID = `wc_${"a".repeat(61)}`;
  const AUTHOR = "Konstantin Alexander Weißenberger-Lindqvist von Hohenzollern-Sigmaringen der Jüngere";
  const LONG_FIRST =
    "Keep the chunked upload for practice videos, because the gateway rejects a single PUT above " +
    "two gigabytes and the retry loop then re-sends the whole file from the very first byte again.";
  const GAP_ISO = "2026-08-10T08:13:00.000Z";
  /** Both rungs reaped: the coverage note at its two-line length. */
  const REAPED = {
    repo: REPO_ID,
    computedAt: NOW.toISOString(),
    scope: { sinceIso: GAP_ISO },
    order: { state: "undeclared", reason: "hub_did_not_report" },
    sources: [
      { source: "agent_event", state: "incomplete", reason: "session_reaped", gapSince: GAP_ISO, observedAt: GAP_ISO },
      { source: "git", state: "incomplete", reason: "commits_reported", gapSince: GAP_ISO, observedAt: GAP_ISO },
      { source: "ci", state: "unavailable", reason: "no_emitter", gapSince: null, observedAt: null },
      { source: "runtime", state: "unavailable", reason: "out_of_scope_1_0", gapSince: null, observedAt: null },
      { source: "human_edit", state: "unavailable", reason: "no_platform_rung", gapSince: null, observedAt: null },
    ],
  };

  /** The decision tree with every label at its longest: author, id, solved, a sentence at the cap. */
  const longLabelledTree = (): Record<string, unknown> => {
    const tree = decisionTree(4);
    const [decision, ...rest] = tree["claims"] as readonly Record<string, unknown>[];
    return {
      ...tree,
      workContext: {
        ...(tree["workContext"] as Record<string, unknown>),
        id: LONG_ID,
        developerName: AUTHOR,
        resultKind: "solved",
        solvedAt: "2026-08-15T08:00:00.000Z",
      },
      claims: [
        { ...decision, workContextId: LONG_ID, authorDeveloperName: AUTHOR, body: `${LONG_FIRST} Second.` },
        ...rest.map((claim) => ({ ...claim, workContextId: LONG_ID })),
      ],
    };
  };

  test("on a repo with a gap it arrives as the pointer, booked as one, and the note is kept", async () => {
    // Arrange
    const f = await fixture("sf-trailers");
    f.hub.setCandidates([longLabelledTree()]);
    f.hub.setCoverage(REAPED);

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert — no half finding: the sentence the hub scored is shown whole or not at all
    expect(text).toContain("crosscheck pointer:");
    expect(text).toContain(`work context ${LONG_ID}`);
    expect(text).not.toContain("Keep the chunked upload");
    expect(text).toContain("Coverage");
    expect(await spooledChannel(f)).toBe("prompt_hint");
  });

  test("the same tree on a repo without a gap carries its finding", async () => {
    // Arrange
    const f = await fixture("sf-trailers-control");
    f.hub.setCandidates([longLabelledTree()]);

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert
    expect(text).toContain("crosscheck hint:");
    expect(text).toContain("Keep the chunked upload");
    expect(await spooledChannel(f)).toBe(SUBSTANCE_DELIVERY_CHANNEL);
  });

  test("a tree the briefing already pointed at stays silent rather than pointed at twice", async () => {
    // Arrange
    const f = await fixture("sf-trailers-seen");
    f.hub.setCandidates([longLabelledTree()]);
    f.hub.setCoverage(REAPED);
    const state = await readSessionState(f.home, HOST_KEY);
    if (state === null) {
      throw new Error("no session state");
    }
    await writeSessionState(f.home, { ...state, briefingSolvedRefs: [LONG_ID] });

    // Act
    const text = await selectAndRenderHint(flowInput(f));

    // Assert
    expect(text).toBe("");
  });
});
