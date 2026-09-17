/**
 * EVERY WINDOW BELONGS TO ITS OWN TOOL, and without that the exonerating
 * answer comes back from a foreign bracket.
 *
 * `openToolWindow` can be refused — a busy state lock, or a session whose
 * hooks were installed mid-flight and has no state file yet — and PostToolUse
 * cannot see that it was. Before this file the close was driven by
 * `isEditTool(tool_name)` alone and the bracket was the OLDEST open window's
 * floor, so a tool whose own PreToolUse opened nothing closed a PARALLEL
 * tool's window and stamped its edit with a floor taken AFTER that edit
 * happened. Measured on the real hooks with the lock held on purpose: the hub
 * answered `predeclared` for an explanation written after the change, and the
 * parallel tool LOST its own bracket to the sibling's close.
 *
 * The pairing key is a digest of `tool_name` + canonical `tool_input`, the one
 * thing both hooks are handed for the same call. It lives in the session state
 * and nowhere else: no record, no renderer, no wire.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { readSpoolLines, repoKey, runHook } from "../src/index.ts";
import type { Env } from "../src/index.ts";
import { HTTP_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import { withLock } from "@crosscheck/connector-core/spool/lock.ts";
import {
  allocateSeq,
  readSessionState,
  sessionStateLockPath,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import type { SessionStateInput } from "@crosscheck/connector-core/state/session-state.ts";
import { compareEvents, seqKindFor } from "@crosscheck/server";
import type { OrderedEvent, SessionCausalOrder } from "@crosscheck/server";
import { makeHome, makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "hook-pairing-uuid";
const DEAD_HUB_URL = "http://127.0.0.1:1";
const EPOCH = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

interface Stamp {
  readonly epoch: string;
  readonly n: number;
  readonly after?: number;
}

interface Target {
  readonly value: string;
  readonly seq: Stamp;
}

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const env = (home: string): Env => ({
  CROSSCHECK_HOME: home,
  CROSSCHECK_HUB_URL: DEAD_HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  CROSSCHECK_TIMEOUT_MS: String(HTTP_TIMEOUT_MS),
  CROSSCHECK_SSH_CANONICALIZE: "off",
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

/** The two hooks of ONE tool call see the same tool_name and tool_input. */
const payload = (fx: Fixture, event: string, file: string): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: fx.repo,
    hook_event_name: event,
    tool_name: "Edit",
    tool_input: { file_path: join(fx.repo, file) },
    tool_response: {},
  });

const pre = async (fx: Fixture, file: string): Promise<void> => {
  await runHook("pre-tool-use", payload(fx, "PreToolUse", file), env(fx.home));
};

const post = async (fx: Fixture, file: string): Promise<void> => {
  await runHook("post-tool-use", payload(fx, "PostToolUse", file), env(fx.home));
};

/** A PreToolUse that meets a BUSY state lock, the way a sibling emitter makes one. */
const preUnderHeldLock = async (fx: Fixture, file: string): Promise<void> => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withLock(
    sessionStateLockPath(fx.home, SESSION_ID),
    null,
    async () => {
      await held;
      return null;
    },
  );
  await Bun.sleep(20);
  await pre(fx, file);
  release();
  await holder;
};

const targets = async (fx: Fixture): Promise<readonly Target[]> =>
  (await readSpoolLines(fx.home, repoKey(DEAD_HUB_URL, REPO_ID)))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record["kind"] === "target")
    .map((record) => ({
      value: (record["body"] as { value: string }).value,
      seq: record["seq"] as Stamp,
    }));

const targetFor = async (fx: Fixture, file: string): Promise<Target> => {
  const found = (await targets(fx)).find((target) => target.value === file);
  if (found === undefined) {
    throw new Error(`no target spooled for ${file}`);
  }
  return found;
};

/** The hub's own gate, asked exactly as a consumer asks it. */
const USABLE_ORDER: SessionCausalOrder = {
  sessionId: "s",
  state: "usable",
  reason: "sequenced",
  epochs: 1,
};

/**
 * A row as the hub itself would store it — `seqKind` from the hub's OWN
 * mapping rather than from a rule restated here, because the whole point of
 * an unbracketed tool-lane position is that it is stored `observed` and every
 * happens-before question against it is refused.
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

/**
 * The MCP lane is a POINT and the hub stores it `emitted`: `publish_claim` and
 * `set_intent` allocate with nothing of their own running, so the position is
 * the moment itself rather than the closed end of a window.
 */
const point = (n: number): OrderedEvent => ({
  sessionId: "s",
  seqEpoch: EPOCH,
  seqN: n,
  seqAfter: null,
  seqKind: "emitted",
  seqReason: "sequenced",
  observedAt: new Date(),
});

const hubOrders = (explanation: number, edit: Stamp): -1 | 0 | 1 | null =>
  compareEvents(USABLE_ORDER, point(explanation), row(edit));

describe("a window is paired to the tool that opened it", () => {
  test("a tool whose PreToolUse could not open a window sends NO bracket", async () => {
    // Arrange: the state lock is held when T1's PreToolUse runs, so its
    // `openToolWindow` is refused. PostToolUse cannot see that, and the only
    // honest bracket is none — least of all the floor of the PARALLEL tool
    // whose window is the one actually open.
    const fx = await fixture("pairing-refused");
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 2;\n");
    await pre(fx, "src/b.ts");

    // Act
    await preUnderHeldLock(fx, "src/a.ts");
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 100;\n");
    await post(fx, "src/a.ts");

    // Assert
    const target = await targetFor(fx, "src/a.ts");
    expect(target.seq.after).toBeUndefined();
  });

  test("an edit whose explanation came later is never ordered predeclared", async () => {
    // Arrange: the measured defect. T1's PreToolUse is refused, the edit lands,
    // the explanation is published AFTER it, and only THEN does a parallel T2
    // open a window. T1's PostToolUse used to close T2's window and take its
    // floor — a position later than the explanation — so the hub answered -1:
    // "the explanation preceded the edit", the value that exonerates.
    const fx = await fixture("pairing-predeclared");
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 2;\n");

    // Act
    await preUnderHeldLock(fx, "src/a.ts");
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 100;\n");
    const explanation = await allocateSeq(fx.home, SESSION_ID, 1);
    await pre(fx, "src/b.ts");
    await post(fx, "src/a.ts");
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 200;\n");
    await post(fx, "src/b.ts");

    // Assert: on the hub's own comparison, not on the connector's.
    const edit = await targetFor(fx, "src/a.ts");
    expect(explanation).not.toBeNull();
    expect(hubOrders(explanation!.from, edit.seq)).not.toBe(-1);
  });

  test("a parallel tool keeps its OWN bracket rather than losing it to a sibling", async () => {
    // Arrange: the same interleaving, seen from T2. T1's close used to drain
    // the only open window — T2's — so T2's PostToolUse found none and stamped
    // the upper bound the bracket exists to replace.
    const fx = await fixture("pairing-sibling");
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 2;\n");

    // Act
    await preUnderHeldLock(fx, "src/a.ts");
    await pre(fx, "src/b.ts");
    await post(fx, "src/a.ts");
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 200;\n");
    await post(fx, "src/b.ts");

    // Assert
    const kept = await targetFor(fx, "src/b.ts");
    expect(kept.seq.after).not.toBeUndefined();
    expect(kept.seq.after).toBeLessThan(kept.seq.n);
  });

  test("two parallel tools each keep their own floor, neither taking the other's", async () => {
    // Arrange: both PreToolUse hooks succeed, so both floors exist and each
    // belongs to one tool. Sharing the oldest was safe but imprecise; taking
    // the other tool's is what a key makes impossible.
    const fx = await fixture("pairing-both");
    await writeRepoFile(fx.repo, "src/one.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/two.ts", "export const y = 2;\n");

    // Act
    await pre(fx, "src/one.ts");
    await pre(fx, "src/two.ts");
    await post(fx, "src/two.ts");
    await post(fx, "src/one.ts");

    // Assert: the second tool's floor is its own, which is the LATER of the two.
    const one = await targetFor(fx, "src/one.ts");
    const two = await targetFor(fx, "src/two.ts");
    expect(one.seq.after).toBe(1);
    expect(two.seq.after).toBe(2);
    const state = await readSessionState(fx.home, SESSION_ID);
    expect(state?.toolWindows).toEqual([]);
  });

  test("a tool call with no window of its own sends no bracket", async () => {
    // Arrange: Bash opens nothing (PreToolUse returns before the window for a
    // non-edit tool), and a session whose hooks were installed mid-flight has
    // no PreToolUse for this call at all. Both must reach the hub as the upper
    // bound they are, even while a sibling tool's window sits open.
    const fx = await fixture("pairing-unopened");
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 2;\n");
    await pre(fx, "src/b.ts");

    // Act: no PreToolUse for THIS call.
    await post(fx, "src/a.ts");

    // Assert
    const target = await targetFor(fx, "src/a.ts");
    expect(target.seq.after).toBeUndefined();
  });
});
