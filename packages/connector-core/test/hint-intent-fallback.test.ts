/**
 * No intent in place of a content-free prompt (DESIGN.md §4, owner decision
 * in review 1006b, M6), connector half: the session's intent never travels in
 * a prompt's place or beside it, a prompt with no searchable word costs no
 * call, and a hub that still reports an intent match is labelled honestly.
 * server/test/hint-content-floor pins the hub half: an intent sent by an
 * older connector is not matched either.
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
/** A prompt that carries a task, so a call is made at all. */
const TASK_PROMPT = "why does the refresh call 500 after the key rotation";

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

const fixture = async (
  label: string,
  intent: string | null,
  provenance: "declared" | "derived" | null = "derived",
): Promise<Fixture> => {
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
    workContextIntentProvenance: provenance,
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

describe("what goes on the wire: never the intent in a prompt's place (owner decision, review 1006b M6)", () => {
  test("a prompt with no searchable word stays home, and so does the session's intent", async () => {
    // Arrange
    const f = await fixture("if-noword", SESSION_INTENT);

    // Act
    const text = await selectAndRenderHint(flowInput(f, NO_WORD_PROMPT));

    // Assert — no hint and no call: nothing stands in for a prompt that said nothing
    expect(text).toBe("");
    expect(f.hub.calls.candidates).toBe(0);
  });

  test("a prompt with words is sent alone — the intent never rides beside it", async () => {
    // Arrange
    const f = await fixture("if-words", SESSION_INTENT);
    const prompt = "why does src/auth/refresh.ts still 500 after the key rotation";

    // Act
    await selectAndRenderHint(flowInput(f, prompt));

    // Assert
    expect(f.hub.calls.candidates).toBe(1);
    expect(f.hub.lastCandidatesQuery()?.get("query")).toBe(prompt);
    expect(f.hub.lastCandidatesQuery()?.has("intent")).toBe(false);
  });
});

/**
 * A hub that reports a candidate as matched on an intent — one built before
 * the stand-in was removed — is still labelled honestly: the header says
 * which intent, by who wrote it.
 */
describe("what the hint then says when a hub reports an intent match", () => {
  test("a candidate matched on a DERIVED intent says so, as every intent surface does", async () => {
    // Arrange — the intent worker's sentence: a model wrote it
    const f = await fixture("if-header", SESSION_INTENT, "derived");
    f.hub.setCandidates([intentMatchedCandidate()]);

    // Act
    const text = await selectAndRenderHint(flowInput(f, TASK_PROMPT));

    // Assert
    expect(text).toContain("may relate to this session's derived intent.");
    expect(text).not.toContain("this prompt");
    expect(text).not.toContain("stated");
  });

  test("a DECLARED intent (set_intent) is called the session's intent", async () => {
    // Arrange
    const f = await fixture("if-header-declared", SESSION_INTENT, "declared");
    f.hub.setCandidates([intentMatchedCandidate()]);

    // Act
    const text = await selectAndRenderHint(flowInput(f, TASK_PROMPT));

    // Assert
    expect(text).toContain("may relate to this session's intent.");
    expect(text).not.toContain("derived intent");
  });

  test("an intent whose writer nobody recorded is labelled derived — positive equality on declared", async () => {
    // Arrange — a state file older than the provenance field
    const f = await fixture("if-header-unknown", SESSION_INTENT, null);
    f.hub.setCandidates([intentMatchedCandidate()]);

    // Act
    const text = await selectAndRenderHint(flowInput(f, TASK_PROMPT));

    // Assert
    expect(text).toContain("this session's derived intent");
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
    expect(text).not.toContain("intent.");
  });
});

describe("PRIVACY: the prompt text never leaves the machine on this path either", () => {
  test("an intent-matched delivery writes no prompt text to the spool or the state", async () => {
    // Arrange
    const f = await fixture("if-privacy", SESSION_INTENT);
    f.hub.setCandidates([intentMatchedCandidate()]);
    const marker = "SECRETPROMPTMARKER";

    // Act
    const text = await selectAndRenderHint(flowInput(f, `${marker} ${TASK_PROMPT}`));

    // Assert — delivered (so the files were written), and the prompt is in none
    expect(text).toContain("this session's derived intent");
    const spool = await readSessionSpool(f.home, f.key, sessionSlug(HOST_KEY));
    expect(spool.lines.length).toBeGreaterThan(0);
    expect(spool.lines.join("\n")).not.toContain(marker);
    const state = await readSessionState(f.home, HOST_KEY);
    expect(JSON.stringify(state)).not.toContain(marker);
    expect(JSON.stringify(state)).not.toContain(CANDIDATE_BODY);
  });
});
