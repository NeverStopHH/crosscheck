/**
 * THE HOOK PAIR BRACKETS ITS TOOL, and without that AT-4 answers from a race.
 *
 * `PostToolUse` runs once the tool has RETURNED. The edit is already on disk
 * by then, so the position that hook allocates is an upper bound on it, and an
 * MCP tool that allocated while the hook was still starting holds a LOWER
 * number than a change that came first. Comparing the numbers answers
 * `predeclared` — the value that exonerates — for an explanation written
 * afterwards. Measured on the real hooks: 10 inversions in 10 trials.
 *
 * So `PreToolUse` takes ONE position before the tool starts and the pair sends
 * it as `seq.after`. The edit is somewhere in `(after, n]`: anything at or
 * below `after` precedes it, anything above `n` follows it, and anything
 * BETWEEN raced it and is refused. The bracket position itself is never
 * attached to a record — it is a deliberate gap, and gaps are legal.
 *
 * THE FLOOR IS THIS CALL'S OWN, found by the key both of its hooks derive
 * from the host's `tool_use_id`. Claude Code runs tools in parallel, and the
 * earlier rule — the OLDEST open floor, drained by a count — could not name an
 * owner: a tool whose own `openToolWindow` was refused closed a PARALLEL
 * tool's window and took a floor recorded AFTER its own edit. That pairing is
 * owned by test/hook-window-pairing.test.ts; this file owns the bracket
 * itself, and the two parallel tests below say what it costs now.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { HTTP_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import {
  allocateSeq,
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionStateInput } from "@crosscheck/connector-core/state/session-state.ts";
import { causalComparisonOf, seqKindFor } from "@crosscheck/server";
import type { OrderedEvent, SessionCausalOrder } from "@crosscheck/server";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "hook-window-uuid";
const DEAD_HUB_URL = "http://127.0.0.1:1";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

interface Stamp {
  readonly epoch: string;
  readonly n: number;
  readonly after?: number;
}

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const stateFor = (repoRoot: string): SessionStateInput => ({
  hostSessionKey: SESSION_ID,
  crosscheckSessionId: `cc_${SESSION_ID}`,
  workContextId: `wc_cc_${SESSION_ID}`,
  repoId: REPO_ID,
  repoRoot,
  hubUrl: DEAD_HUB_URL,
  developerId: "dev_self",
  startedAt: new Date().toISOString(),
  seqEpoch: EPOCH,
  eventSeq: 0,
});

const env = (home: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
  CROSSCHECK_SSH_CANONICALIZE: "off",
});

interface Fixture {
  readonly home: string;
  readonly repo: string;
}

const fixture = async (label: string): Promise<Fixture> => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  paths.push(home, repo);
  await writeSessionState(home, stateFor(repo));
  return { home, repo };
};

/**
 * Both hooks of ONE call, which in every test below is the one call that edits
 * `file` — so the host's `tool_use_id`, the key that pairs the two hooks
 * (core state/tool-window-key.ts), is derived from the file.
 */
const payload = (fx: Fixture, event: string, file: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: fx.repo,
    hook_event_name: event,
    tool_name: "Edit",
    tool_input: { file_path: join(fx.repo, file) },
    tool_use_id: `toolu_${file}`,
    tool_response: {},
  });

/** The tool the agent actually ran, bracketed the way the host reports it. */
const openWindow = async (fx: Fixture, file: string): Promise<void> => {
  await runHook("pre-tool-use", payload(fx, "PreToolUse", file), env(fx.home));
};

const closeWindow = async (fx: Fixture, file: string): Promise<void> => {
  await runHook("post-tool-use", payload(fx, "PostToolUse", file), env(fx.home));
};

/** The hub's own gate, asked exactly as a consumer asks it. */
const USABLE_ORDER: SessionCausalOrder = {
  sessionId: "s",
  state: "usable",
  reason: "sequenced",
  epochs: 1,
};

/**
 * A tool-lane row as the HUB stores it, `seqKind` from the hub's own mapping:
 * a bracketed tool edit is `emitted`, an unbracketed one `observed`, and a
 * test that restated either could pass while the product's answer moved.
 */
const row = (stamp: Stamp): OrderedEvent => ({
  sessionId: "s",
  seqEpoch: stamp.epoch,
  seqN: stamp.n,
  seqAfter: stamp.after ?? null,
  seqKind: seqKindFor("tool_edit", stamp),
  seqReason: "sequenced",
  observedAt: new Date(),
});

const stamps = async (fx: Fixture): Promise<readonly Stamp[]> =>
  (await readSpoolLines(fx.home, repoKey(DEAD_HUB_URL, REPO_ID)))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record["kind"] === "target")
    .map((record) => record["seq"] as Stamp);

describe("the hook pair brackets the tool it reports", () => {
  test("a tool-lane position carries the window its hook opened before the tool", async () => {
    // Arrange
    const fx = await fixture("hook-window");
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");

    // Act
    await openWindow(fx, "src/a.ts");
    await closeWindow(fx, "src/a.ts");

    // Assert: the bracket is a real position, taken before the block, and it
    // is never the position of a record — it is the gap the window opens on.
    const [stamp] = await stamps(fx);
    expect(stamp?.epoch).toBe(EPOCH);
    expect(stamp?.after).toBe(1);
    expect(stamp?.n).toBeGreaterThan(1);
  });

  test("an emitter that raced the tool lands INSIDE the window, not before it", async () => {
    // Arrange: the shape measured on the real hooks — the file is written,
    // then an MCP publish and the edit's own hook go for a position together,
    // and the publish wins. Without the bracket the claim's lower number reads
    // as "the reason existed before the change", which is the opposite of what
    // happened.
    const fx = await fixture("hook-window-race");
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");

    // Act
    await openWindow(fx, "src/a.ts");
    const raced = await allocateSeq(fx.home, SESSION_ID, 1);
    await closeWindow(fx, "src/a.ts");

    // Assert: the racing position sits strictly inside (after, n], which is
    // exactly the interval the hub refuses to order against.
    const [stamp] = await stamps(fx);
    expect(raced?.from).toBeGreaterThan(stamp!.after!);
    expect(raced?.from).toBeLessThanOrEqual(stamp!.n);
  });

  test("a second tool opens its own window rather than reusing the first", async () => {
    // Arrange: the list must DRAIN, or every later edit keeps the first
    // tool's floor and its window swallows the whole session.
    const fx = await fixture("hook-window-twice");
    await writeRepoFile(fx.repo, "src/one.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/two.ts", "export const y = 2;\n");

    // Act
    await openWindow(fx, "src/one.ts");
    await closeWindow(fx, "src/one.ts");
    await openWindow(fx, "src/two.ts");
    await closeWindow(fx, "src/two.ts");

    // Assert
    const [first, second] = await stamps(fx);
    expect(second?.after).toBeGreaterThanOrEqual(first!.n);
    const state = await readSessionState(fx.home, SESSION_ID);
    expect(state?.toolWindows).toEqual([]);
  });

  test("a SessionStart re-fire inside a running tool keeps the window open", async () => {
    // Arrange: compact, resume and clear all re-fire SessionStart INSIDE a
    // live session, and a tool can be running across one. The re-fire
    // re-creates the state file; a window dropped there closes at zero, and
    // the PostToolUse that follows stamps an unbracketed position — the upper
    // bound this pair exists to avoid — on an edit whose PreToolUse already
    // paid for a floor.
    const fx = await fixture("hook-window-refire");
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");

    // Act
    await openWindow(fx, "src/a.ts");
    await runHook(
      "session-start",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fx.repo,
        hook_event_name: "SessionStart",
        source: "compact",
      }),
      env(fx.home),
    );
    await closeWindow(fx, "src/a.ts");

    // Assert
    const edits = (await stamps(fx)).filter(
      (stamp) => stamp.after !== undefined,
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]?.after).toBe(1);
  });

  test("two tools open at once keep own floors and still refuse each other", async () => {
    // Arrange: Claude Code runs tools in parallel. Each tool now keeps the
    // floor ITS OWN PreToolUse took — the second one's is later than the
    // first's, which the shared-oldest rule could not express — and the point
    // of this test is what that does NOT buy: the two windows still overlap,
    // so the hub refuses to order the two edits against each other. Precision
    // is the side of the trade that may be spent; an answer is not.
    const fx = await fixture("hook-window-parallel");
    await writeRepoFile(fx.repo, "src/one.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/two.ts", "export const y = 2;\n");

    // Act
    await openWindow(fx, "src/one.ts");
    await openWindow(fx, "src/two.ts");
    await closeWindow(fx, "src/two.ts");
    await closeWindow(fx, "src/one.ts");

    // Assert: own floors, and the hub's OWN gate says concurrent — asked of
    // `causalComparisonOf` rather than restated here, so a change to the gate
    // cannot leave this file passing while the product's answer moves.
    const [second, first] = await stamps(fx);
    expect(first?.after).toBe(1);
    expect(second?.after).toBe(2);
    expect(causalComparisonOf(USABLE_ORDER, row(first!), row(second!))).toEqual({
      outcome: "indeterminate",
      reason: "concurrent",
    });
    const state = await readSessionState(fx.home, SESSION_ID);
    expect(state?.toolWindows).toEqual([]);
  });
});
