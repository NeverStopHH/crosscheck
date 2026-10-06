/**
 * A turn the harness wrote never earns a hint (DESIGN.md §4), connector half.
 * Live on 0.10.0: Claude Code delivers a background task's notification as a
 * user turn — "[SYSTEM NOTIFICATION - NOT USER INPUT]", a <task-notification>
 * block — and its words (PR, CI, checks, pass, event) pointed the session at
 * unrelated teammate trees. A turn that is all harness makes NO hub call, not
 * even the session's intent in its place: nobody typed anything to relate to.
 * A turn with human text around a wrapper sends that text and only that.
 *
 * The fixture hub answers every call with an injectable candidate, so silence
 * here can only come from the connector.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { SYSTEM_NOTIFICATION_MARKER } from "@crosscheck/schema";

import { selectAndRenderHint } from "../src/flows/hint.ts";
import { repoKey } from "../src/config/paths.ts";
import type { HubContext } from "../src/http/client.ts";
import { readSessionState, writeSessionState } from "../src/state/session-state.ts";
import { SELF_DEVELOPER_ID, startHintHub } from "./fixtures/hint-hub.ts";
import type { HintHub } from "./fixtures/hint-hub.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HOST_KEY = "harness-turn-uuid";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const SESSION_INTENT = "Stop the refresh 500s by refetching the JWKS on an unknown kid";
const TASK_NOTIFICATION =
  "<task-notification><task-id>bp1v5vsl4</task-id>" +
  '<summary>Monitor event: "PR #74 CI checks for 493ffb4f"</summary>' +
  "<event>Comment claims (macos-latest): pass</event></task-notification>";

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

/** A session WITH an intent, so a silence cannot be the intent's absence. */
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
    workContextIntent: SESSION_INTENT,
    workContextIntentProvenance: "derived",
  });
  return {
    home,
    repo,
    hub,
    key,
    ctx: { hubUrl: hub.url, apiKey: "test-key", timeoutMs: 20_000, home, repoKey: key, now: () => NOW },
  };
};

const hintFor = (f: Fixture, prompt: string): Promise<string> =>
  selectAndRenderHint({
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

describe("a turn that is all harness gets no hint and costs no call", () => {
  test.each([
    ["a task notification", TASK_NOTIFICATION],
    ["a turn headed by the system-notification marker", `${SYSTEM_NOTIFICATION_MARKER}\n${TASK_NOTIFICATION}`],
    ["another agent's message", '<agent-message from="a781e1e961b68f4c2">Report: CI checks pass</agent-message>'],
    ["another session's message", '<cross-session-message from="ken">PR #74 checks pass</cross-session-message>'],
  ])("%s", async (_, turn) => {
    // Arrange
    const f = await fixture("ht-silent");

    // Act
    const text = await hintFor(f, turn);

    // Assert — silence, and not even the intent went out in its place
    expect(text).toBe("");
    expect(f.hub.calls.candidates).toBe(0);
  });
});

describe("each turn the prompt path stood down on is counted, and only counted (review 1006b, M7)", () => {
  /** The state file's whole text — a count is all it may gain. */
  const stateText = async (f: Fixture): Promise<string> => JSON.stringify(await readSessionState(f.home, HOST_KEY));

  test("a harness turn books one harness turn and no floored prompt", async () => {
    // Arrange
    const f = await fixture("ht-count-harness");

    // Act
    await hintFor(f, TASK_NOTIFICATION);
    await hintFor(f, `${SYSTEM_NOTIFICATION_MARKER}\n${TASK_NOTIFICATION}`);

    // Assert
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.harnessTurnCount).toBe(2);
    expect(state?.flooredPromptCount).toBe(0);
  });

  test("a content-free prompt books one floored prompt and no harness turn", async () => {
    // Arrange
    const f = await fixture("ht-count-floored");

    // Act
    await hintFor(f, "mache weiter, limit zuruckgesetzt. bitte alles wiederuafnhemen");

    // Assert
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.flooredPromptCount).toBe(1);
    expect(state?.harnessTurnCount).toBe(0);
  });

  test("a prompt with a task books neither", async () => {
    // Arrange
    const f = await fixture("ht-count-task");

    // Act
    await hintFor(f, "why does the refresh handler 500 after the key rotation");

    // Assert
    const state = await readSessionState(f.home, HOST_KEY);
    expect(state?.flooredPromptCount).toBe(0);
    expect(state?.harnessTurnCount).toBe(0);
  });

  test("PRIVACY: the counts are all that is kept — no word of either turn reaches the state", async () => {
    // Arrange
    const f = await fixture("ht-count-private");

    // Act
    await hintFor(f, TASK_NOTIFICATION);
    await hintFor(f, "ok weiter, wiederuafnhemen");

    // Assert
    const text = await stateText(f);
    expect(text).not.toContain("493ffb4f");
    expect(text).not.toContain("Monitor");
    expect(text).not.toContain("wiederuafnhemen");
  });
});

describe("human text around a wrapper is the query, and only it", () => {
  test("the words a notification carries never reach the wire", async () => {
    // Arrange
    const f = await fixture("ht-mixed");
    const human = "why does the refresh handler 500 after the key rotation";

    // Act
    await hintFor(f, `${TASK_NOTIFICATION}\n${human}`);

    // Assert
    expect(f.hub.calls.candidates).toBe(1);
    const sent = f.hub.lastCandidatesQuery();
    expect(sent?.get("query")).toBe(human);
    expect(sent?.toString()).not.toContain("493ffb4f");
    expect(sent?.toString()).not.toContain("Monitor");
  });
});
