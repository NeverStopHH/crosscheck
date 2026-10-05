/**
 * The session's intent in place of a content-free prompt (DESIGN.md §4),
 * connector half: what goes on the wire, what the hint then says, and what
 * never leaves the machine.
 *
 * The hub decides whether a prompt carried anything task-bearing — only it
 * holds the team's words to count against (server/test/hint-content-floor
 * pins that half) — so the connector's job is to put the session's intent on
 * the SAME call, keep a prompt with no searchable word off the wire
 * entirely, and say honestly what a delivered hint was matched on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { selectAndRenderHint } from "../src/flows/hint.ts";
import { repoKey, sessionSlug } from "../src/config/paths.ts";
import type { HubContext } from "../src/http/client.ts";
import { readSessionSpool } from "../src/spool/files.ts";
import { readSessionState, writeSessionState } from "../src/state/session-state.ts";
import {
  CANDIDATE_BODY,
  SELF_DEVELOPER_ID,
  rejectedApproachCandidate,
  startHintHub,
} from "./fixtures/hint-hub.ts";
import type { HintHub } from "./fixtures/hint-hub.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HOST_KEY = "intent-fallback-uuid";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const SESSION_INTENT = "Stop the refresh 500s by refetching the JWKS on an unknown kid";
/** Two words, neither of HINT_MIN_TOKEN_CHARS: no searchable word at all. */
const NO_WORD_PROMPT = "ok ja";

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

const fixture = async (label: string, intent: string | null): Promise<Fixture> => {
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
    workContextIntent: intent,
  });
  return {
    home,
    repo,
    hub,
    key,
    ctx: { hubUrl: hub.url, apiKey: "test-key", timeoutMs: 20_000, home, repoKey: key, now: () => NOW },
  };
};

const flowInput = (f: Fixture, prompt: string) => ({
  home: f.home,
  repoKey: f.key,
  hub: f.ctx,
  hostSessionKey: HOST_KEY,
  repoId: REPO_ID,
  repoRoot: f.repo,
  agentKind: "acp:fake-agent",
  prompt,
  now: NOW,
});

/** The canned injectable candidate, as a hub answers it when the intent stood in. */
const intentMatchedCandidate = (): Record<string, unknown> => ({
  ...rejectedApproachCandidate(),
  matchedOn: "intent",
});

describe("what goes on the wire", () => {
  test("a prompt with no searchable word stays home; the session's intent travels in its place", async () => {
    // Arrange
    const f = await fixture("if-noword", SESSION_INTENT);

    // Act
    await selectAndRenderHint(flowInput(f, NO_WORD_PROMPT));

    // Assert — ONE call, carrying the intent and no prompt text at all
    expect(f.hub.calls.candidates).toBe(1);
    const sent = f.hub.lastCandidatesQuery();
    expect(sent?.get("intent")).toBe(SESSION_INTENT);
    expect(sent?.get("query") ?? "").toBe("");
    expect(sent?.toString()).not.toContain("ja");
  });

  test("a prompt with words is sent as before, with the intent beside it for the hub to fall back on", async () => {
    // Arrange
    const f = await fixture("if-words", SESSION_INTENT);

    // Act
    await selectAndRenderHint(flowInput(f, "mache weiter"));

    // Assert — the hub, not the connector, decides "mache weiter" carries
    // nothing; both ride the one call so the fallback costs no round trip
    expect(f.hub.calls.candidates).toBe(1);
    expect(f.hub.lastCandidatesQuery()?.get("query")).toBe("mache weiter");
    expect(f.hub.lastCandidatesQuery()?.get("intent")).toBe(SESSION_INTENT);
  });

  test("without an intent, a prompt with no searchable word still costs zero HTTP", async () => {
    // Arrange
    const f = await fixture("if-nointent", null);

    // Act
    const text = await selectAndRenderHint(flowInput(f, NO_WORD_PROMPT));

    // Assert
    expect(text).toBe("");
    expect(f.hub.calls.candidates).toBe(0);
  });

  test("an intent that looks like a credential is never sent", async () => {
    // Arrange — the writers screen it already (set_intent, the intent
    // worker); this is the query's own gate, the prompt's sibling
    const f = await fixture("if-secret", "rotate AKIAIOSFODNN7EXAMPLE before the deploy");

    // Act
    const text = await selectAndRenderHint(flowInput(f, NO_WORD_PROMPT));

    // Assert
    expect(text).toBe("");
    expect(f.hub.calls.candidates).toBe(0);
  });
});

describe("what the hint then says", () => {
  test("a candidate matched on the intent says so, not that it relates to the prompt", async () => {
    // Arrange
    const f = await fixture("if-header", SESSION_INTENT);
    f.hub.setCandidates([intentMatchedCandidate()]);

    // Act
    const text = await selectAndRenderHint(flowInput(f, "mache weiter"));

    // Assert
    expect(text).toContain("this session's stated intent");
    expect(text).not.toContain("this prompt");
  });

  test("a candidate matched on the prompt keeps the prompt header", async () => {
    // Arrange
    const f = await fixture("if-prompt-header", SESSION_INTENT);

    // Act
    const text = await selectAndRenderHint(
      flowInput(f, "why does src/auth/refresh.ts still 500 after the key rotation"),
    );

    // Assert
    expect(text).toContain("this prompt");
    expect(text).not.toContain("stated intent");
  });
});

describe("PRIVACY: the prompt text never leaves the machine on this path either", () => {
  test("an intent-matched delivery writes no prompt text to the spool or the state", async () => {
    // Arrange
    const f = await fixture("if-privacy", SESSION_INTENT);
    f.hub.setCandidates([intentMatchedCandidate()]);
    const marker = "SECRETPROMPTMARKER";

    // Act
    const text = await selectAndRenderHint(flowInput(f, `${marker} weiter`));

    // Assert — delivered (so the files were written), and the prompt is in none
    expect(text).toContain("this session's stated intent");
    const spool = await readSessionSpool(f.home, f.key, sessionSlug(HOST_KEY));
    expect(spool.lines.length).toBeGreaterThan(0);
    expect(spool.lines.join("\n")).not.toContain(marker);
    const state = await readSessionState(f.home, HOST_KEY);
    expect(JSON.stringify(state)).not.toContain(marker);
    expect(JSON.stringify(state)).not.toContain(CANDIDATE_BODY);
  });
});
