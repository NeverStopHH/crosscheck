/**
 * A PROMPT TOO LONG FOR THE WIRE GOES AS ITS HEAD AND ITS TAIL (DESIGN.md §4,
 * hold-out review round 3, M7). The hub's route caps the query at
 * MAX_SEARCH_QUERY_CHARS, and the connector used to send the first that many
 * characters: a context dump in front of "… the daily quota reset cron runs
 * twice. Please fix it." left the task past the cut, and the hub never saw it.
 * A task is written first or last, so both ends travel, cut at word bounds.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { MAX_SEARCH_QUERY_CHARS } from "../src/constants.ts";
import { selectAndRenderHint } from "../src/flows/hint.ts";
import { repoKey } from "../src/config/paths.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import { SELF_DEVELOPER_ID, startHintHub } from "./fixtures/hint-hub.ts";
import type { HintHub } from "./fixtures/hint-hub.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HOST_KEY = "query-window-uuid";
const NOW = new Date("2026-10-06T12:00:00.000Z");
const OPENING = "Context dump, sorry, this is long. ";
const NOISE = "the printer is broken again, the coffee order needs confirming, the badge reader beeps twice, ";
const TASK = "The one thing for you: the daily quota reset cron runs twice at midnight. Please fix it.";

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  hubs.forEach((hub) => hub.stop());
  hubs.length = 0;
});

/** The query the connector put on the wire for `prompt`. */
const sentQuery = async (label: string, prompt: string): Promise<string> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  paths.push(home, repo);
  const hub = startHintHub();
  hubs.push(hub);
  const key = repoKey(hub.url, REPO_ID);
  await writeSessionState(home, {
    hostSessionKey: HOST_KEY, crosscheckSessionId: `cc_${HOST_KEY}`, workContextId: `wc_cc_${HOST_KEY}`, repoId: REPO_ID, repoRoot: repo,
    hubUrl: hub.url, developerId: SELF_DEVELOPER_ID, startedAt: NOW.toISOString(), lastHeartbeatAt: null, seenTargets: [], deliveredHintRefs: [],
    deliveredHintHashes: [], tripwireAskedFiles: [], landedAskedFiles: [], landedCleanKeys: [],
  });
  await selectAndRenderHint({
    home, repoKey: key, hub: { hubUrl: hub.url, apiKey: "test-key", timeoutMs: 20_000, home, repoKey: key, now: () => NOW },
    hostSessionKey: HOST_KEY, repoId: REPO_ID, repoRoot: repo, agentKind: "acp:fake-agent", prompt, now: NOW,
  });
  return hub.lastCandidatesQuery()?.get("query") ?? "";
};

describe("the query window (M7)", () => {
  test("a prompt past the cap sends its head and its tail, the task at the end included", async () => {
    // Arrange
    const prompt = `${OPENING}${NOISE.repeat(30)}${TASK}`;
    expect(prompt.length).toBeGreaterThan(MAX_SEARCH_QUERY_CHARS);

    // Act
    const sent = await sentQuery("qw-long", prompt);

    // Assert
    expect(sent.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_CHARS);
    expect(sent.startsWith(OPENING)).toBe(true);
    expect(sent.endsWith(TASK)).toBe(true);
  });

  test("the cut falls between words, never inside one", async () => {
    // Arrange
    const prompt = `${OPENING}${NOISE.repeat(30)}${TASK}`;

    // Act
    const words = (await sentQuery("qw-words", prompt)).split(/\s+/u);

    // Assert — every word sent is a word of the prompt
    const written = new Set(prompt.split(/\s+/u));
    expect(words.filter((word) => !written.has(word))).toEqual([]);
  });

  test("a prompt within the cap goes whole", async () => {
    const prompt = `${OPENING}${TASK}`;
    expect(await sentQuery("qw-short", prompt)).toBe(prompt);
  });
});
