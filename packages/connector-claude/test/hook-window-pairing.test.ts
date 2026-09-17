/**
 * EVERY WINDOW BELONGS TO ITS OWN TOOL CALL, and without that the exonerating
 * answer comes back from a foreign bracket.
 *
 * `openToolWindow` can be refused — a busy state lock, or a session whose
 * hooks were installed mid-flight and has no state file yet — and PostToolUse
 * cannot see that it was. Before the keyed list the close was driven by
 * `isEditTool(tool_name)` alone and the bracket was the OLDEST open window's
 * floor, so a tool whose own PreToolUse opened nothing closed a PARALLEL
 * tool's window and stamped its edit with a floor taken AFTER that edit
 * happened. Measured on the real hooks with the lock held on purpose: the hub
 * answered `predeclared` for an explanation written after the change, and the
 * parallel tool LOST its own bracket to the sibling's close.
 *
 * THE KEY IS THE HOST'S OWN ID FOR THE CALL, `tool_use_id`. A digest of
 * `tool_name` + `tool_input` was tried first and is not enough: two IDENTICAL
 * calls — the same edit issued twice in one batch — digest to one key, so a
 * twin whose open was refused still took its sibling's later floor and the hub
 * still answered `predeclared` (measured through a real hub, and pinned below
 * as "an identical twin call"). The id is what the host hands BOTH hooks of
 * one call and no other call; a payload without one opens no window at all.
 * The key lives in the session state and nowhere else: no record, no
 * renderer, no wire.
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

/**
 * ONE TOOL CALL: the file it edits and the id the host gives it. `id: null`
 * is a payload with no `tool_use_id` at all — a host that does not send one.
 */
interface Call {
  readonly file: string;
  readonly id: string | null;
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

/**
 * The two hooks of ONE tool call see the same tool_name, tool_input and
 * tool_use_id — the shape Claude Code's hooks reference documents for both.
 */
const payload = (fx: Fixture, event: string, call: Call): string =>
  JSON.stringify({
    session_id: SESSION_ID,
    cwd: fx.repo,
    hook_event_name: event,
    tool_name: "Edit",
    tool_input: { file_path: join(fx.repo, call.file) },
    ...(call.id === null ? {} : { tool_use_id: call.id }),
    tool_response: {},
  });

const pre = async (fx: Fixture, call: Call): Promise<void> => {
  await runHook("pre-tool-use", payload(fx, "PreToolUse", call), env(fx.home));
};

const post = async (fx: Fixture, call: Call): Promise<void> => {
  await runHook("post-tool-use", payload(fx, "PostToolUse", call), env(fx.home));
};

/** A PreToolUse that meets a BUSY state lock, the way a sibling emitter makes one. */
const preUnderHeldLock = async (fx: Fixture, call: Call): Promise<void> => {
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
  await pre(fx, call);
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

describe("a window is paired to the tool call that opened it", () => {
  test("a tool whose PreToolUse could not open a window sends NO bracket", async () => {
    // Arrange: the state lock is held when T1's PreToolUse runs, so its
    // `openToolWindow` is refused. PostToolUse cannot see that, and the only
    // honest bracket is none — least of all the floor of the PARALLEL tool
    // whose window is the one actually open.
    const fx = await fixture("pairing-refused");
    const t1: Call = { file: "src/a.ts", id: "toolu_refused_1" };
    const t2: Call = { file: "src/b.ts", id: "toolu_refused_2" };
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 2;\n");
    await pre(fx, t2);

    // Act
    await preUnderHeldLock(fx, t1);
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 100;\n");
    await post(fx, t1);

    // Assert: no bracket, and therefore the upper bound the hub refuses on.
    const target = await targetFor(fx, "src/a.ts");
    expect(target.seq.after).toBeUndefined();
    expect(row(target.seq).seqKind).toBe("observed");
  });

  test("an edit whose explanation came later is never ordered predeclared", async () => {
    // Arrange: the measured defect. T1's PreToolUse is refused, the edit lands,
    // the explanation is published AFTER it, and only THEN does a parallel T2
    // open a window. T1's PostToolUse used to close T2's window and take its
    // floor — a position later than the explanation — so the hub answered -1:
    // "the explanation preceded the edit", the value that exonerates.
    const fx = await fixture("pairing-predeclared");
    const t1: Call = { file: "src/a.ts", id: "toolu_late_1" };
    const t2: Call = { file: "src/b.ts", id: "toolu_late_2" };
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 2;\n");

    // Act
    await preUnderHeldLock(fx, t1);
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 100;\n");
    const explanation = await allocateSeq(fx.home, SESSION_ID, 1);
    await pre(fx, t2);
    await post(fx, t1);
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 200;\n");
    await post(fx, t2);

    // Assert: on the hub's own comparison, not on the connector's.
    const edit = await targetFor(fx, "src/a.ts");
    expect(explanation).not.toBeNull();
    expect(hubOrders(explanation!.from, edit.seq)).not.toBe(-1);
  });

  test("an identical twin call does not lend a refused tool its window", async () => {
    // Arrange: the case a digest of tool_name + tool_input cannot see. The
    // SAME edit issued twice in one batch — same tool, same input, two calls
    // with two ids. T1's open is refused, its edit lands, the explanation is
    // published, and only then does the twin T2 open. Keyed by the input, T1's
    // close found T2's entry and took its floor: a position later than the
    // explanation, so the hub answered -1. Measured through a real hub before
    // this key existed. The twin's own target is deduplicated away (same
    // file), so the foreign floor was the only bracket the edit ever had.
    const fx = await fixture("pairing-twin");
    const t1: Call = { file: "src/a.ts", id: "toolu_twin_1" };
    const t2: Call = { file: "src/a.ts", id: "toolu_twin_2" };
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");

    // Act
    await preUnderHeldLock(fx, t1);
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 100;\n");
    const explanation = await allocateSeq(fx.home, SESSION_ID, 1);
    await pre(fx, t2);
    await post(fx, t1);
    await post(fx, t2);

    // Assert: T1 opened nothing, so it brackets nothing — and the hub refuses
    // rather than exonerates.
    const edit = await targetFor(fx, "src/a.ts");
    expect(edit.seq.after).toBeUndefined();
    expect(explanation).not.toBeNull();
    expect(hubOrders(explanation!.from, edit.seq)).toBeNull();
    // ...and T2's own close still drained T2's own entry: nothing leaks.
    const state = await readSessionState(fx.home, SESSION_ID);
    expect(state?.toolWindows).toEqual([]);
  });

  test("a parallel tool keeps its OWN bracket rather than losing it to a sibling", async () => {
    // Arrange: the same interleaving, seen from T2. T1's close used to drain
    // the only open window — T2's — so T2's PostToolUse found none and stamped
    // the upper bound the bracket exists to replace.
    const fx = await fixture("pairing-sibling");
    const t1: Call = { file: "src/a.ts", id: "toolu_sibling_1" };
    const t2: Call = { file: "src/b.ts", id: "toolu_sibling_2" };
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 2;\n");

    // Act
    await preUnderHeldLock(fx, t1);
    await pre(fx, t2);
    await post(fx, t1);
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 200;\n");
    await post(fx, t2);

    // Assert
    const kept = await targetFor(fx, "src/b.ts");
    expect(kept.seq.after).not.toBeUndefined();
    expect(kept.seq.after).toBeLessThan(kept.seq.n);
  });

  test("two parallel tools each keep their own floor, neither taking the other's", async () => {
    // Arrange: both PreToolUse hooks succeed, so both floors exist and each
    // belongs to one call. Sharing the oldest was safe but imprecise; taking
    // the other call's is what a key makes impossible.
    const fx = await fixture("pairing-both");
    const one: Call = { file: "src/one.ts", id: "toolu_both_1" };
    const two: Call = { file: "src/two.ts", id: "toolu_both_2" };
    await writeRepoFile(fx.repo, "src/one.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/two.ts", "export const y = 2;\n");

    // Act
    await pre(fx, one);
    await pre(fx, two);
    await post(fx, two);
    await post(fx, one);

    // Assert: the second call's floor is its own, which is the LATER of the two.
    const first = await targetFor(fx, "src/one.ts");
    const second = await targetFor(fx, "src/two.ts");
    expect(first.seq.after).toBe(1);
    expect(second.seq.after).toBe(2);
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
    await pre(fx, { file: "src/b.ts", id: "toolu_unopened_2" });

    // Act: no PreToolUse for THIS call.
    await post(fx, { file: "src/a.ts", id: "toolu_unopened_1" });

    // Assert: no bracket, stored `observed` by the hub's own mapping — and the
    // sibling's window is still there for the sibling.
    const target = await targetFor(fx, "src/a.ts");
    expect(target.seq.after).toBeUndefined();
    expect(row(target.seq).seqKind).toBe("observed");
    const state = await readSessionState(fx.home, SESSION_ID);
    expect(state?.toolWindows).toHaveLength(1);
  });

  test("a failed edit closes its own window and nobody else's", async () => {
    // Arrange: a failed edit goes to PostToolUseFailure, never to
    // PostToolUse. With a key that names one call, no later call can match the
    // window it leaves behind, so an unclosed one only sits in the capped list
    // until an eviction counts it — as a bracket lost by an edit that never
    // happened. Failed edits are common (a stale old_string), so they would be
    // most of that count.
    const fx = await fixture("pairing-failed");
    const failed: Call = { file: "src/a.ts", id: "toolu_failed_1" };
    const sibling: Call = { file: "src/b.ts", id: "toolu_failed_2" };
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 2;\n");
    await pre(fx, failed);
    await pre(fx, sibling);

    // Act
    await runHook(
      "post-tool-use-failure",
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: fx.repo,
        hook_event_name: "PostToolUseFailure",
        tool_name: "Edit",
        tool_input: { file_path: join(fx.repo, failed.file) },
        tool_use_id: failed.id,
        error: "String to replace not found in file.\nString: export const z = 3;",
      }),
      env(fx.home),
    );
    const afterFailure = await readSessionState(fx.home, SESSION_ID);
    await writeRepoFile(fx.repo, "src/b.ts", "export const y = 200;\n");
    await post(fx, sibling);

    // Assert: the failed call's entry is gone, the sibling's was untouched and
    // still brackets the sibling's edit from the sibling's own floor...
    expect(afterFailure?.toolWindows).toHaveLength(1);
    expect((await targetFor(fx, "src/b.ts")).seq.after).toBe(2);
    // ...and the failure's own fingerprint is positioned exactly as before —
    // a position, no bracket — so closing the window changed nothing it says.
    const fingerprints = (await readSpoolLines(fx.home, repoKey(DEAD_HUB_URL, REPO_ID)))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (record) =>
          record["kind"] === "target" &&
          (record["body"] as { kind: string }).kind === "error_fingerprint",
      );
    expect(fingerprints).toHaveLength(1);
    const stamp = fingerprints[0]?.["seq"] as Stamp;
    expect(stamp.n).toBeGreaterThan(0);
    expect(stamp.after).toBeUndefined();
  });

  test("a failed call dropped as another repo's still closes its own window", async () => {
    // Arrange: the failure hook's own first-wins drop path — the call edits a
    // file in acme/other while this session reports to acme/api.
    const fx = await fixture("pairing-failed-foreign");
    const other = await makeRepo("pairing-failed-foreign-other", {
      remote: "git@github.com:acme/other.git",
    });
    paths.push(other);
    await writeRepoFile(other, "src/x.ts", "export const x = 1;\n");
    const foreign = (event: string): string =>
      JSON.stringify({
        session_id: SESSION_ID,
        cwd: other,
        hook_event_name: event,
        tool_name: "Edit",
        tool_input: { file_path: join(other, "src/x.ts") },
        tool_use_id: "toolu_failed_foreign_1",
        error: "String to replace not found in file.\nString: export const z = 3;",
      });

    // Act
    await runHook("pre-tool-use", foreign("PreToolUse"), env(fx.home));
    const opened = await readSessionState(fx.home, SESSION_ID);
    await runHook("post-tool-use-failure", foreign("PostToolUseFailure"), env(fx.home));

    // Assert
    expect(opened?.toolWindows).toHaveLength(1);
    const state = await readSessionState(fx.home, SESSION_ID);
    expect(state?.foreignRepoDrops).toBe(1);
    expect(state?.toolWindows).toEqual([]);
  });

  test("a host that sends no tool_use_id opens no window and sends no bracket", async () => {
    // Arrange: the documented refusal. Without the host's id there is no key
    // that names ONE call, and a key that can name two is how a refused tool
    // borrowed its twin's floor. So nothing is opened: the edit travels as
    // the upper bound it is, and the hub refuses rather than guesses.
    const fx = await fixture("pairing-no-id");
    const call: Call = { file: "src/a.ts", id: null };
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 1;\n");

    // Act
    await pre(fx, call);
    const opened = await readSessionState(fx.home, SESSION_ID);
    await writeRepoFile(fx.repo, "src/a.ts", "export const x = 100;\n");
    await post(fx, call);

    // Assert
    expect(opened?.toolWindows).toEqual([]);
    const target = await targetFor(fx, "src/a.ts");
    expect(target.seq.after).toBeUndefined();
    expect(row(target.seq).seqKind).toBe("observed");
  });
});
