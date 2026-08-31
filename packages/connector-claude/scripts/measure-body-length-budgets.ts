/**
 * What a claim-body cap costs the HOOKS, measured through the real
 * `crosscheck hook <name>` process against a hub that answers every
 * hook-visible route with MAXIMUM-LENGTH bodies.
 *
 * WHY THIS EXISTS. Raising MAX_CLAIM_BODY_LENGTH moves how many bytes the hook
 * paths carry on the WIRE even where the RENDER caps stay tight: a hint still
 * shows UNSOLICITED_CLAIM_BODY_MAX_CHARS characters, but the candidate row it
 * chose from arrived whole, was parsed whole, and was hashed whole. That is a
 * cost, it lands on a keystroke path, and the only honest way to know its size
 * is to measure it. Reasoning about it is what this script exists to replace —
 * the same argument scripts/measure-process-floor.ts makes for its own
 * constant: a figure nobody can reproduce is worse than no figure at all.
 *
 * WHAT IT MEASURES. Every hook, spawned as Claude Code spawns it, against a hub
 * whose every body field is `MAX_CLAIM_BODY_LENGTH` characters long — so the
 * SAME script measures the before and the after: it reads the constant out of
 * the tree it runs in rather than hard-coding a length.
 *
 * AT THE HUB'S OWN MAXIMA, derived rather than chosen. The page sizes come
 * from the server constants themselves — MAX_DRAFTS_LISTED, HINT_MAX_CONTEXTS
 * x HINT_MAX_CLAIMS_PER_CONTEXT, MAX_QUESTION_ANSWERS_LISTED,
 * SOLVED_MATCH_MAX_FINDINGS, TRIPWIRE_MAX_SESSIONS — so the harness is
 * maximal by construction and stays maximal when a bound moves. It used to
 * serve one hint candidate with one claim where the hub sends three contexts
 * of thirty, and answered the tripwire route with an empty list, so the
 * recorded `pre-tool-use out=0` row never exercised that render at all. A
 * harness that never sends what the hub can send will pass the change that
 * really does blow a budget, which is the one thing it exists to prevent.
 *
 *   bun run packages/connector-claude/scripts/measure-body-length-budgets.ts
 *   bun run packages/connector-claude/scripts/measure-body-length-budgets.ts --cursor
 *
 * `--cursor` adds the SECOND hook binary: `crosscheck cursor-hook` carries the
 * same wire payloads under the same BUDGET_RATIOS and was not measured at all,
 * so half the hook surface of a body-cap raise went unmeasured. Behind a flag
 * because it doubles the runtime.
 *
 * The hub binds a THROWAWAY port (7750 by default, `--port` to move it) and the
 * home and repo are temp directories removed on exit; nothing here touches a
 * real hub or a real ~/.crosscheck.
 *
 * THE NUMBERS ARE A READING FROM ONE HOST ON ONE DAY, like every other timing
 * table in this repo (test/hook-time-budget.test.ts says why at length). Runs,
 * load and machine belong with any figure quoted from it.
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { MAX_CLAIM_BODY_LENGTH } from "@crosscheck/schema";
import {
  HTTP_TIMEOUT_MS,
  POST_TOOL_USE_BUDGET_RATIO,
  POST_TOOL_USE_FAILURE_BUDGET_RATIO,
  PRE_TOOL_USE_BUDGET_RATIO,
  SESSION_END_BUDGET_RATIO,
  SESSION_START_BUDGET_RATIO,
  STOP_BUDGET_RATIO,
  USER_PROMPT_SUBMIT_BUDGET_RATIO,
} from "@crosscheck/connector-core/constants.ts";
import { appendRecords, repoKey } from "../src/index.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";
// THE PAGE SIZES ARE DERIVED FROM THE HUB'S OWN BOUNDS, not chosen here, so
// the harness is maximal by construction and stays maximal when a bound
// moves. Reached by relative path because the server package exports only its
// root — the same crossing this file already makes for the test helpers above.
import {
  MAX_DRAFTS_LISTED,
  MAX_QUESTION_ANSWERS_LISTED,
  SOLVED_MATCH_MAX_FINDINGS,
} from "../../server/src/constants.ts";
import {
  HINT_MAX_CLAIMS_PER_CONTEXT,
  HINT_MAX_CONTEXTS,
  TRIPWIRE_MAX_SESSIONS,
} from "../../server/src/services/hints.ts";

const BIN_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "cli",
  "src",
  "bin",
  "crosscheck.ts",
);

const REPO_ID = "github.com/acme/api";
const REPO_REMOTE = "git@github.com:acme/api.git";
const SESSION_ID = "budget-uuid";
const DEFAULT_PORT = 7750;
const RUNS = 10;
/** Claim records left in the spool, each carrying a maximum-length body. */
const SPOOL_RECORDS = 40;

const argOf = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const PORT = Number(argOf("--port") ?? DEFAULT_PORT);
/** `--cursor` adds the second hook binary's seven events; see CURSOR_CASES. */
const WITH_CURSOR = process.argv.includes("--cursor");

/**
 * A body at exactly the cap, in ordinary words.
 *
 * Not one repeated character: the hint path hashes bodies for its
 * already-delivered set and the sanitizer collapses whitespace, and a
 * degenerate string measures neither honestly.
 */
const maxBody = (seed: string): string => {
  const words = `${seed} the refresh path never reloads the rotated key and the cached jwks keeps answering with the old kid `;
  return words
    .repeat(Math.ceil(MAX_CLAIM_BODY_LENGTH / words.length))
    .slice(0, MAX_CLAIM_BODY_LENGTH);
};

const iso = (): string => new Date().toISOString();

const draftRow = (index: number): Record<string, unknown> => ({
  id: `clm_draft_${String(index)}`,
  workContextId: `wc_cc_${SESSION_ID}`,
  kind: "hypothesis",
  body: maxBody(`draft ${String(index)}`),
  status: "proposed",
  confidence: 0.5,
  captureMode: "agent",
  dedupCount: 1,
  createdAt: iso(),
});

const solvedRow = (): Record<string, unknown> => ({
  workContextId: "wc_solved",
  title: "Refresh 500s after key rotation",
  developerName: "Nick",
  repo: REPO_ID,
  solvedAt: "2026-03-12T08:00:00.000Z",
  landedAt: null,
  matchedTargetKind: "error_fingerprint",
  rootCause: maxBody("root cause"),
  rootCauseConfidence: 0.9,
});

/**
 * One hint candidate carrying the FULL page of claims the hub will send.
 *
 * The hub's own bounds are HINT_MAX_CONTEXTS contexts x
 * HINT_MAX_CLAIMS_PER_CONTEXT claims (services/hints.ts), and this harness
 * used to serve one context with one claim — about 10 KB measured against
 * roughly 900 KB reachable, on the hook that runs inside a keystroke. A
 * harness that never sends what the hub can send will pass a change that
 * really does blow a budget, which is the one thing it exists to prevent.
 */
const candidateRow = (index: number): Record<string, unknown> => ({
  workContext: {
    id: `wc_nick_${String(index)}`,
    title: "Refresh 500s after key rotation",
    status: "analyzing",
    tier: "exact",
    developerId: "dev_nick",
    developerName: "Nick",
    baseCommit: "a1b2c3d4e5f6a7b8",
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: null,
  },
  claims: Array.from(
    { length: HINT_MAX_CLAIMS_PER_CONTEXT },
    (_unused, claimIndex) => ({
      id: `clm_candidate_${String(index)}_${String(claimIndex)}`,
      workContextId: `wc_nick_${String(index)}`,
      kind: "rejected_approach",
      status: "rejected",
      confidence: 0.8,
      provenance: "declared",
      captureMode: "agent",
      evidenceRefCount: 1,
      authorDeveloperId: "dev_nick",
      authorDeveloperName: "Nick",
      body: maxBody(`candidate ${String(index)} ${String(claimIndex)}`),
      createdAt: "2026-08-10T08:00:00.000Z",
    }),
  ),
});

/**
 * A tripwire session, at the hub's TRIPWIRE_MAX_SESSIONS page size.
 *
 * The harness answered this route with an empty list, so the recorded
 * `pre-tool-use out=0` row never exercised the tripwire render at all — the
 * hook was measured doing nothing.
 */
const tripwireRow = (index: number): Record<string, unknown> => ({
  sessionId: `cc_other_${String(index)}`,
  developerId: `dev_other_${String(index)}`,
  developerName: "Robin",
  branch: `feat/rotation-${String(index)}`,
  status: "active",
  lastHeartbeatAt: iso(),
  workContextId: `wc_other_${String(index)}`,
  workContextTitle: "Refresh 500s after key rotation",
  workContextIntent: {
    summary: "tracing the refresh 500s back to the rotated signing key",
    provenance: "derived",
    confidence: 0.4,
    capturedAt: iso(),
  },
});

const answerRow = (): Record<string, unknown> => ({
  questionId: "qn_backoff",
  questionBody: "Is the uploader's backoff shared with the importer?",
  claimId: "clm_answer",
  workContextId: "wc_nick_answer",
  claimBody: maxBody("answer"),
  claimKind: "observation",
  claimStatus: "proposed",
  confidence: 0.6,
  provenance: "declared",
  answererDeveloperName: "Nick",
  answeredAt: "2026-08-19T09:00:00.000Z",
});

const sessionBody = (): Response =>
  Response.json({
    ok: true,
    data: { session: { id: `cc_${SESSION_ID}`, developerId: "dev_self" } },
  });

/**
 * Every hook-visible route, answered instantly and at maximum body length.
 *
 * Zero latency deliberately: a sleeping hub measures the sleep. What is under
 * measurement is the bytes — transfer, parse, hash, render, spool.
 */
const startHub = (port: number): { readonly stop: () => void; readonly url: string } => {
  const server = Bun.serve({
    port,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/records") {
        const body = (await request.json()) as { records: readonly unknown[] };
        return Response.json({
          ok: true,
          data: {
            accepted: body.records.length,
            duplicates: 0,
            ignored: 0,
            rejected: 0,
          },
        });
      }
      if (pathname === "/api/drafts") {
        return Response.json({
          ok: true,
          data: {
            drafts: Array.from({ length: MAX_DRAFTS_LISTED }, (_unused, index) =>
              draftRow(index),
            ),
          },
        });
      }
      if (pathname === "/api/solved-matches") {
        return Response.json({
          ok: true,
          data: {
            matches: Array.from({ length: SOLVED_MATCH_MAX_FINDINGS }, () =>
              solvedRow(),
            ),
          },
        });
      }
      if (pathname === "/api/hints/candidates") {
        return Response.json({
          ok: true,
          data: {
            candidates: Array.from(
              { length: HINT_MAX_CONTEXTS },
              (_unused, index) => candidateRow(index),
            ),
            answers: Array.from({ length: MAX_QUESTION_ANSWERS_LISTED }, () =>
              answerRow(),
            ),
          },
        });
      }
      if (pathname === "/api/hints/tripwire") {
        return Response.json({
          ok: true,
          data: {
            sessions: Array.from(
              { length: TRIPWIRE_MAX_SESSIONS },
              (_unused, index) => tripwireRow(index),
            ),
          },
        });
      }
      if (pathname === "/api/presence") {
        return Response.json({ ok: true, data: { sessions: [] } });
      }
      if (pathname === "/api/work-contexts") {
        return Response.json({ ok: true, data: { workContexts: [] } });
      }
      if (pathname === "/api/questions") {
        return Response.json({ ok: true, data: { questions: [] } });
      }
      if (pathname === "/api/ghost-checks") {
        return Response.json({ ok: true, data: { checks: [] } });
      }
      if (pathname === "/api/absences") {
        return Response.json({ ok: true, data: { absences: [] } });
      }
      if (pathname === "/api/contradictions") {
        return Response.json({ ok: true, data: { contradictions: [] } });
      }
      return sessionBody();
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    stop: () => {
      server.stop(true);
    },
  };
};

const spoolRecord = (index: number, body: string): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_claim_${String(index)}`,
  ts: iso(),
  producer: {
    developerId: "dev_self",
    agentKind: "claude-code",
    sessionId: `cc_${SESSION_ID}`,
  },
  kind: "claim",
  body: {
    workContextId: `wc_cc_${SESSION_ID}`,
    kind: "hypothesis",
    body,
    status: "proposed",
    confidence: 0.5,
    captureMode: "agent",
    provenance: "declared",
    evidenceRefs: [],
  },
});

interface HookCase {
  readonly name: string;
  readonly budgetMs: number;
  readonly payload: (repo: string) => Record<string, unknown>;
}

const CASES: readonly HookCase[] = [
  {
    name: "session-start",
    budgetMs: SESSION_START_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      session_id: SESSION_ID,
      cwd: repo,
      hook_event_name: "SessionStart",
    }),
  },
  {
    name: "user-prompt-submit",
    budgetMs: USER_PROMPT_SUBMIT_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      session_id: SESSION_ID,
      cwd: repo,
      hook_event_name: "UserPromptSubmit",
      prompt:
        "why does src/auth/refresh.ts still 500 after the key rotation lands",
    }),
  },
  {
    name: "pre-tool-use",
    budgetMs: PRE_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      session_id: SESSION_ID,
      cwd: repo,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: `${repo}/src/auth/refresh.ts` },
    }),
  },
  {
    name: "post-tool-use",
    budgetMs: POST_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      session_id: SESSION_ID,
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: `${repo}/src/auth/refresh.ts` },
      tool_response: { filePath: `${repo}/src/auth/refresh.ts` },
    }),
  },
  {
    name: "post-tool-use-failure",
    budgetMs: POST_TOOL_USE_FAILURE_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      session_id: SESSION_ID,
      cwd: repo,
      // The FAILURE envelope, not a PostToolUse one: this leg has its own
      // event name and carries the failure text in `error` (test/failure-hook.test.ts).
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "bun test" },
      error: "Exit code 1\nerror: expected 3 to be 4\n  at src/limiter.test.ts",
      is_interrupt: false,
    }),
  },
  {
    name: "stop",
    budgetMs: STOP_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      session_id: SESSION_ID,
      cwd: repo,
      hook_event_name: "Stop",
    }),
  },
  {
    name: "session-end",
    budgetMs: SESSION_END_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      session_id: SESSION_ID,
      cwd: repo,
      hook_event_name: "SessionEnd",
    }),
  },
];

/**
 * The SECOND hook binary, measured behind `--cursor`.
 *
 * `crosscheck cursor-hook` carries the same wire payloads under the same
 * BUDGET_RATIOS (connector-cursor/src/runner.ts) and was not measured at all,
 * so half the hook surface of a body-cap raise went unmeasured. Behind a flag
 * because it doubles the runtime and the Claude lane is the one CI cares
 * about first.
 *
 * `conversation_id` is the field every event maps (payload.ts MAPPED_FIELDS);
 * an event missing it degrades to contract drift rather than doing the work,
 * which would measure the wrong thing.
 */
const CURSOR_CASES: readonly HookCase[] = [
  {
    name: "sessionStart",
    budgetMs: SESSION_START_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      conversation_id: SESSION_ID,
      hook_event_name: "sessionStart",
      workspace_roots: [repo],
    }),
  },
  {
    name: "afterFileEdit",
    budgetMs: POST_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      conversation_id: SESSION_ID,
      hook_event_name: "afterFileEdit",
      workspace_roots: [repo],
      file_path: `${repo}/src/auth/refresh.ts`,
    }),
  },
  {
    name: "afterShellExecution",
    budgetMs: POST_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      conversation_id: SESSION_ID,
      hook_event_name: "afterShellExecution",
      workspace_roots: [repo],
    }),
  },
  {
    name: "postToolUse",
    budgetMs: POST_TOOL_USE_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      conversation_id: SESSION_ID,
      hook_event_name: "postToolUse",
      workspace_roots: [repo],
      file_path: `${repo}/src/auth/refresh.ts`,
    }),
  },
  {
    name: "postToolUseFailure",
    budgetMs: POST_TOOL_USE_FAILURE_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      conversation_id: SESSION_ID,
      hook_event_name: "postToolUseFailure",
      workspace_roots: [repo],
      error_message: "Exit code 1\nerror: expected 3 to be 4",
    }),
  },
  {
    name: "stop",
    budgetMs: STOP_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      conversation_id: SESSION_ID,
      hook_event_name: "stop",
      workspace_roots: [repo],
    }),
  },
  {
    name: "sessionEnd",
    budgetMs: SESSION_END_BUDGET_RATIO * HTTP_TIMEOUT_MS,
    payload: (repo) => ({
      conversation_id: SESSION_ID,
      hook_event_name: "sessionEnd",
      workspace_roots: [repo],
    }),
  },
];

/**
 * One run: its wall time, and HOW MANY BYTES IT PUT INTO THE SESSION.
 *
 * The byte count is not decoration. A hook that silently stopped delivering —
 * a parse that now fails on a longer row, a fitter that drops its only
 * substance line — gets FASTER, and a table of milliseconds alone would read
 * that regression as an improvement. The `out` column is what makes a fast row
 * distinguishable from a dead one.
 */
interface Run {
  readonly elapsedMs: number;
  readonly outBytes: number;
}

const runOnce = async (
  subcommand: string,
  hookName: string,
  payload: Record<string, unknown>,
  env: Record<string, string>,
): Promise<Run> => {
  const startedAt = Bun.nanoseconds();
  const proc = Bun.spawn({
    cmd: [process.execPath, BIN_PATH, subcommand, hookName],
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return {
    elapsedMs: Math.round((Bun.nanoseconds() - startedAt) / 1e6),
    outBytes: stdout.length,
  };
};

const percentile = (sorted: readonly number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;

const main = async (): Promise<void> => {
  const repo = await makeRepo("budget", { remote: REPO_REMOTE });
  const home = await makeHome("budget");
  const hub = startHub(PORT);
  const key = repoKey(hub.url, REPO_ID);
  try {
    console.log(
      `MAX_CLAIM_BODY_LENGTH ${String(MAX_CLAIM_BODY_LENGTH)} · hub ${hub.url} · ${String(RUNS)} runs each`,
    );
    console.log(
      "hook                   budget    min    p50    max  (ms)     out",
    );
    const lanes: readonly (readonly [string, readonly HookCase[]])[] = WITH_CURSOR
      ? [
          ["hook", CASES],
          ["cursor-hook", CURSOR_CASES],
        ]
      : [["hook", CASES]];
    for (const [subcommand, cases] of lanes) {
      if (subcommand !== "hook") {
        console.log(`-- crosscheck ${subcommand} --`);
      }
      for (const hookCase of cases) {
      // A FRESH SESSION AND A FRESH SPOOL PER HOOK: a previous hook's flush
      // would otherwise pay this one's bill and the row would read low.
      await rm(home, { recursive: true, force: true });
      await writeSessionState(home, {
        hostSessionKey: SESSION_ID,
        crosscheckSessionId: `cc_${SESSION_ID}`,
        workContextId: `wc_cc_${SESSION_ID}`,
        repoId: REPO_ID,
        repoRoot: repo,
        hubUrl: hub.url,
        developerId: "dev_self",
        startedAt: iso(),
        lastHeartbeatAt: null,
        seenTargets: [],
      });
      await appendRecords(
        home,
        key,
        SESSION_ID,
        Array.from({ length: SPOOL_RECORDS }, (_unused, index) =>
          spoolRecord(index, maxBody(`spool ${String(index)}`)),
        ),
        new Date(),
      );
      const env = {
        CROSSCHECK_HOME: home,
        CROSSCHECK_HUB_URL: hub.url,
        CROSSCHECK_API_KEY: "measure-key",
        CROSSCHECK_DISABLED: "0",
      };
      const runs: Run[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        runs.push(
          await runOnce(subcommand, hookCase.name, hookCase.payload(repo), env),
        );
      }
      const sorted = runs
        .map((run) => run.elapsedMs)
        .sort((left, right) => left - right);
      const outBytes = Math.max(...runs.map((run) => run.outBytes));
      console.log(
        `${hookCase.name.padEnd(21)} ${String(hookCase.budgetMs).padStart(6)} ${String(sorted[0] ?? 0).padStart(6)} ${String(percentile(sorted, 0.5)).padStart(6)} ${String(sorted[sorted.length - 1] ?? 0).padStart(6)}  ${String(outBytes).padStart(6)}`,
      );
      }
    }
  } finally {
    hub.stop();
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
};

await main();
