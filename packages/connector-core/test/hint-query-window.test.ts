/**
 * A PROMPT TOO LONG FOR THE WIRE (DESIGN.md §4, hold-out review round 3, M7;
 * round 4, H1). The hub's route caps the query at MAX_SEARCH_QUERY_CHARS, and
 * the connector used to send the first that many characters: a context dump
 * in front of "… the daily quota reset cron runs twice. Please fix it." left
 * the task past the cut, and the hub never saw it. Round 3 sent the head and
 * the tail; round 4 sends the ranked terms of all of it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { classifyPrompt } from "@crosscheck/schema";
import type { ClassifiedPrompt } from "@crosscheck/schema";

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

/** The query the connector put on the wire for `prompt`, classified by the caller or not. */
const sentQuery = async (label: string, prompt: string, classified?: ClassifiedPrompt): Promise<string> => {
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
    ...(classified === undefined ? {} : { classified }),
  });
  return hub.lastCandidatesQuery()?.get("query") ?? "";
};

describe("the prompt is classified once per hook (round 3, L4)", () => {
  test("the flow reads the classification its caller already made, never its own second one", async () => {
    // Arrange — the hook classified the prompt once; this one as content-free
    const prompt = "why does the checkout worker drop the idempotency key";
    const classified: ClassifiedPrompt = { ...classifyPrompt(prompt), terms: { ...classifyPrompt(prompt).terms, isContentFree: true } };

    // Act
    const sent = await sentQuery("qw-classified", prompt, classified);

    // Assert — no call: the caller's verdict is the one the flow acted on
    expect(sent).toBe("");
  });

  test("the control: unclassified, the same prompt goes on the wire", async () => {
    expect(await sentQuery("qw-unclassified", "why does the checkout worker drop the idempotency key")).toBe(
      "why does the checkout worker drop the idempotency key",
    );
  });
});

/**
 * A LONG PROMPT GOES AS THE RANKED TERMS OF ALL OF IT (hold-out review round
 * 4, H1). Its head and its tail were not enough: the round-4 hold-out's K094,
 * a 3 137-character German report of a double-billing night, says "utc",
 * "scheduler", "renewal" and "unique constraint" in its middle, and the
 * window sent the subscription-renewal tree's words to a deploy tree instead.
 * The hub only ever counted terms; the terms of the whole classified text —
 * task clauses only, topical words first — are what goes on the wire, cut
 * between words at the route's cap.
 */
describe("the query of a long prompt: its ranked terms, all of it (round 4, H1)", () => {
  const MIDDLE = "Oh, and the subscription renewal cron runs in Berlin time; it should run in UTC with a unique constraint per period. ";

  test("a task in the middle of a long prompt goes on the wire, every one of its words", async () => {
    // Arrange
    const prompt = `${OPENING}${NOISE.repeat(15)}${MIDDLE}${NOISE.repeat(15)}${TASK}`;
    expect(prompt.length).toBeGreaterThan(MAX_SEARCH_QUERY_CHARS);

    // Act
    const sent = (await sentQuery("qw-long", prompt)).split(" ");

    // Assert — the middle's words and the end's, none of them cut away
    expect(sent).toEqual(expect.arrayContaining(["subscription", "renewal", "cron", "berlin", "utc", "unique", "constraint", "quota", "reset"]));
  });

  test("the query is the prompt's ranked terms, topical first, within the cap", async () => {
    // Arrange
    const prompt = `${OPENING}${NOISE.repeat(15)}${MIDDLE}${NOISE.repeat(15)}${TASK}`;

    // Act
    const sent = await sentQuery("qw-ranked", prompt);

    // Assert
    expect(sent.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_CHARS);
    expect(sent).toBe(classifyPrompt(prompt).terms.ranked.join(" "));
  });

  test("ranked terms past the cap are cut between terms, never inside one", async () => {
    // Arrange — six hundred distinct words, far more terms than the cap carries
    const prompt = Array.from({ length: 600 }, (_, index) => `zebraword${String(index)}`).join(" ");

    // Act
    const sent = await sentQuery("qw-cut", prompt);

    // Assert — a prefix of the ranked terms, whole terms only
    const ranked = classifyPrompt(prompt).terms.ranked;
    expect(sent.length).toBeLessThanOrEqual(MAX_SEARCH_QUERY_CHARS);
    expect(sent.split(" ")).toEqual(ranked.slice(0, sent.split(" ").length));
    expect(sent.length).toBeGreaterThan(MAX_SEARCH_QUERY_CHARS - "zebraword600".length - 1);
  });

  test("a path in a long prompt travels whole, first, for the exact tier that matches targets on whole tokens", async () => {
    // Arrange
    const prompt = `${OPENING}${NOISE.repeat(15)}The cache lives in src/auth/refresh.ts, see "lib/jwks.ts". ${NOISE.repeat(15)}${TASK}`;

    // Act
    const sent = (await sentQuery("qw-path", prompt)).split(" ");

    // Assert
    expect(sent.slice(0, 2)).toEqual(["src/auth/refresh.ts", "lib/jwks.ts"]);
  });

  test("a trace's path travels as the file it names, its position and wrapping off (round 5, M1)", async () => {
    // Arrange — a pasted stack trace and a link, inside a prompt past the cap
    const trace = "at PermissionsGuard.canActivate (packages/api/src/auth/permissions.ts:27:13) and see lib/jwks.ts#L12.";
    const prompt = `${OPENING}${NOISE.repeat(15)}${trace} ${NOISE.repeat(15)}${TASK}`;

    // Act
    const sent = (await sentQuery("qw-trace", prompt)).split(" ");

    // Assert — the hub's exact tier gets the paths it can match a target on
    expect(sent).toEqual(expect.arrayContaining(["packages/api/src/auth/permissions.ts", "lib/jwks.ts"]));
    expect(sent.filter((term) => term.includes(":27") || term.includes("#L12"))).toEqual([]);
  });

  test("a prompt within the cap goes whole", async () => {
    const prompt = `${OPENING}${TASK}`;
    expect(await sentQuery("qw-short", prompt)).toBe(prompt);
  });
});
