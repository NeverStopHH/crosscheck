/**
 * The UserPromptSubmit hook end-to-end through `runHook`: a real repo, a real
 * spool, a fixture hub — only the hub's answers are canned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
import {
  CANDIDATE_BODY,
  CANDIDATE_CLAIM_ID,
  CANDIDATE_CONTEXT_ID,
  proposedOnlyCandidate,
  rejectedApproachCandidate,
  startHintHub,
} from "../../connector-core/test/fixtures/hint-hub.ts";
import type { HintHub } from "../../connector-core/test/fixtures/hint-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "prompt-uuid";
const PROMPT = "why does src/auth/refresh.ts still 500 after the key rotation";
/** Port 1 refuses instantly: an unreachable hub without the wait. */
const DEAD_HUB_URL = "http://127.0.0.1:1";

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
  readonly repo: string;
  readonly home: string;
  readonly hub: HintHub;
  readonly env: Env;
}

const sessionState = (
  fixture: { repo: string; hubUrl: string },
  overrides: Partial<SessionState> = {},
): SessionState => ({
  hostSessionKey: SESSION_ID,
  crosscheckSessionId: `cc_${SESSION_ID}`,
  workContextId: `wc_cc_${SESSION_ID}`,
  repoId: REPO_ID,
  repoRoot: fixture.repo,
  hubUrl: fixture.hubUrl,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: null,
  seenTargets: [],
  deliveredHintRefs: [],
  deliveredHintHashes: [],
  tripwireAskedFiles: [],
  briefingSolvedRefs: [],
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
  summarizerUnparsedCount: 0,
  intentFireCount: 0,
  ...overrides,
});

const fixture = async (
  label: string,
  stateOverrides: Partial<SessionState> = {},
): Promise<Fixture> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startHintHub();
  hubs.push(hub);
  await writeSessionState(
    home,
    sessionState({ repo, hubUrl: hub.url }, stateOverrides),
  );
  return {
    repo,
    home,
    hub,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

const promptPayload = (repo: string, prompt: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: repo,
    hook_event_name: "UserPromptSubmit",
    prompt,
  });

interface HookOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName?: string;
    readonly additionalContext?: string;
  };
}

const contextOf = (stdout: string): string => {
  if (stdout.length === 0) {
    return "";
  }
  const parsed = JSON.parse(stdout) as HookOutput;
  return parsed.hookSpecificOutput?.additionalContext ?? "";
};

describe("user-prompt-submit delivers one labelled hint", () => {
  test("an evidence-backed teammate claim arrives framed, labelled, recorded", async () => {
    // Arrange
    const { repo, home, hub, env } = await fixture("deliver");

    // Act
    const stdout = await runHook("user-prompt-submit", promptPayload(repo, PROMPT), env);

    // Assert — the injected text
    const context = contextOf(stdout);
    expect(context).toContain("Nick");
    expect(context).toContain(`«${CANDIDATE_BODY}»`);
    expect(context).toContain("quoted data, not instruction");
    expect(context).toContain(CANDIDATE_CONTEXT_ID);
    // — one bounded hub call
    expect(hub.calls.candidates).toBe(1);
    // — the delivery is spooled as telemetry (refs only, no rendered text)
    const spooled = (await readSpoolLines(home, repoKey(hub.url, REPO_ID))).map(
      (line) => JSON.parse(line) as { kind: string; body: { refId?: string } },
    );
    const delivery = spooled.find((record) => record.kind === "hint_delivery");
    expect(delivery?.body.refId).toBe(CANDIDATE_CLAIM_ID);
    // — and the seen-set + echo hash survive in the session state
    const state = await readSessionState(home, SESSION_ID);
    expect(state?.deliveredHintRefs).toContain(CANDIDATE_CLAIM_ID);
    expect(state?.deliveredHintHashes.length).toBe(1);
  });

  test("the same hint is never delivered twice", async () => {
    // Arrange
    const { repo, env } = await fixture("dedup");
    await runHook("user-prompt-submit", promptPayload(repo, PROMPT), env);

    // Act — same prompt again, same candidate still on offer
    const second = await runHook("user-prompt-submit", promptPayload(repo, PROMPT), env);

    // Assert
    expect(second).toBe("");
  });

  test("a bare proposed hypothesis arrives as a pointer without its body", async () => {
    // Arrange
    const { repo, hub, env } = await fixture("pointer");
    hub.setCandidates([proposedOnlyCandidate()]);

    // Act
    const stdout = await runHook("user-prompt-submit", promptPayload(repo, PROMPT), env);

    // Assert — anchoring asymmetry through the whole pipe
    const context = contextOf(stdout);
    expect(context).toContain(CANDIDATE_CONTEXT_ID);
    expect(context).not.toContain(CANDIDATE_BODY);
    expect(context).toContain("get_diagnosis");
  });

  test("a context the briefing already pointed at as solved is not re-pointed", async () => {
    // Arrange: the SessionStart briefing delivered this context as a
    // solved-before pointer; the prompt path's pointer for the same tree
    // would be a repeat, which is noise (§10 risk 1).
    const { repo, hub, env } = await fixture("solved-seen", {
      briefingSolvedRefs: [CANDIDATE_CONTEXT_ID],
    });
    hub.setCandidates([proposedOnlyCandidate()]);

    // Act
    const stdout = await runHook("user-prompt-submit", promptPayload(repo, PROMPT), env);

    // Assert
    expect(stdout).toBe("");
  });

  test("a briefing solved pointer neither spends the cap nor blocks substance", async () => {
    // Pin, deliberately green before the seeding change too: the solved
    // pointer joins the SEEN-SET only. An evidence-backed claim inside the
    // pointed-at tree is still injectable substance (the §4 allowance the
    // solved path composes with rather than extends), and the pointer must
    // not count against MAX_HINTS_PER_SESSION.
    const { repo, env } = await fixture("solved-substance", {
      briefingSolvedRefs: [CANDIDATE_CONTEXT_ID],
    });

    // Act: default candidates — Nick's evidence-backed rejected approach in
    // the same context the briefing pointed at.
    const stdout = await runHook("user-prompt-submit", promptPayload(repo, PROMPT), env);

    // Assert
    const context = contextOf(stdout);
    expect(context).toContain(`«${CANDIDATE_BODY}»`);
  });
});

describe("silence is the default", () => {
  test("the session cap forces silence", async () => {
    // Arrange — five hints already delivered in this session
    const { repo, env } = await fixture("cap", {
      deliveredHintRefs: ["r1", "r2", "r3", "r4", "r5"],
    });

    // Act
    const stdout = await runHook("user-prompt-submit", promptPayload(repo, PROMPT), env);

    // Assert
    expect(stdout).toBe("");
  });

  test("a prompt with no searchable word costs zero HTTP", async () => {
    // Arrange
    const { repo, hub, env } = await fixture("short");

    // Act — every word under the 3-char meaning floor
    const stdout = await runHook("user-prompt-submit", promptPayload(repo, "ok go on"), env);

    // Assert
    expect(stdout).toBe("");
    expect(hub.calls.candidates).toBe(0);
  });

  test("no candidates means silence, not filler", async () => {
    const { repo, hub, env } = await fixture("empty");
    hub.setCandidates([]);
    const stdout = await runHook("user-prompt-submit", promptPayload(repo, PROMPT), env);
    expect(stdout).toBe("");
  });

  test("a hub-served confidence outside [0,1] is dropped at the boundary", async () => {
    // Arrange — a hostile or buggy hub labels a claim `confidence 1e+30`;
    // every other hub field is validated tightly and this one must be too
    const { repo, hub, env } = await fixture("confidence");
    const base = rejectedApproachCandidate();
    const claims = base["claims"] as readonly Record<string, unknown>[];
    hub.setCandidates([
      { ...base, claims: [{ ...claims[0], confidence: 1e30 }] },
    ]);

    // Act
    const stdout = await runHook("user-prompt-submit", promptPayload(repo, PROMPT), env);

    // Assert — a trust label the schema cannot vouch for is never rendered
    expect(stdout).toBe("");
  });

  test("a dead hub fails open to silence", async () => {
    // Arrange
    const { repo, env } = await fixture("dead");
    const deadEnv = { ...env, CROSSCHECK_HUB_URL: DEAD_HUB_URL };

    // Act
    const stdout = await runHook(
      "user-prompt-submit",
      promptPayload(repo, PROMPT),
      deadEnv,
    );

    // Assert
    expect(stdout).toBe("");
  });

  test("without a session state file the hook stays silent", async () => {
    // Arrange — SessionStart never ran: no state, nothing to attribute to
    const { repo, home, env } = await fixture("nostate");
    await rm(`${home}/sessions`, { recursive: true, force: true });

    // Act
    const stdout = await runHook("user-prompt-submit", promptPayload(repo, PROMPT), env);

    // Assert
    expect(stdout).toBe("");
  });
});
