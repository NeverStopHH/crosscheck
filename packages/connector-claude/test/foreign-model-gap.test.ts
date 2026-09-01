/**
 * WHAT A FOREIGN MODEL COST BEFORE THIS BRANCH — the four defects, each run
 * through the real worker with a real foreign binary.
 *
 * Every other new test on this branch names a module that the base commit
 * does not have, so its red is "cannot find module": honest, and weak. THIS
 * file imports nothing that moved. It runs unchanged on 77eea1c, and on that
 * tree it fails four times, once per defect — which is the only red that
 * proves the contract test next door is testing behaviour rather than the
 * existence of its own imports.
 *
 * Each case drives ONE corpus shape (corpus.ts) and asserts what session
 * state and the spool must hold afterwards. The shapes are ordinary habits of
 * instruction-tuned chat models, not any vendor's recorded output — the
 * corpus header says so at length, and so does docs/FOREIGN-MODELS.md.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { runSummarizeWorker } from "../src/summarizer/worker.ts";
import {
  FOREIGN_SESSION_ID,
  foreignFixture,
  foreignShape,
  foreignWorkerArgs,
  makeForeignModelBinary,
  spooledClaims,
} from "./fixtures/foreign-model-harness.ts";
import type { ForeignFixture } from "./fixtures/foreign-model-harness.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  cleanups.length = 0;
});

/** The body the corpus says a shape must produce, or "" for a shape that produces none. */
const expectedBody = (shapeName: string): string => {
  const expectation = foreignShape(shapeName).expect;
  return expectation.booked === "draft" ? expectation.body : "";
};

/**
 * One turn, answered by the foreign binary with the named corpus shape. The
 * binary is spawned by the runner exactly as a real wrapper would be — the
 * override is an executable PATH and nothing else.
 */
const runForeignTurn = async (shapeName: string): Promise<ForeignFixture> => {
  const fixture = await foreignFixture();
  const binary = await makeForeignModelBinary();
  cleanups.push(fixture.cleanup);
  cleanups.push(() => rm(binary.dir, { recursive: true, force: true }));
  await runSummarizeWorker(foreignWorkerArgs(fixture), {
    CROSSCHECK_HOME: fixture.home,
    CROSSCHECK_SUMMARIZER_CMD: binary.path,
    CX_FAKE_FOREIGN_SHAPE: shapeName,
  });
  return fixture;
};

describe("a foreign model's habits, through the real worker", () => {
  test("a polite NONE is a judged-empty turn, not a run that vanished", async () => {
    // Arrange & Act: the model greets before it answers — the single most
    // common packaging habit there is.
    const fixture = await runForeignTurn("polite-none");

    // Assert: the model judged the turn empty, and that is what is booked.
    // BEFORE: isNoneAnswer demanded that the WHOLE of stdout be the word, so
    // this was neither a NONE nor a claim and NOTHING was booked at all. A
    // foreign model judging every turn correctly was indistinguishable, on
    // every surface, from a runner that never spoke.
    const state = await readSessionState(fixture.home, FOREIGN_SESSION_ID);
    expect(state?.summarizerNoneCount).toBe(1);
    expect(await spooledClaims(fixture)).toHaveLength(0);
    expect(state?.summarizerFailCount).toBe(0);
  });

  test("a draft the model rejected in its own scratchpad is never filed", async () => {
    // Arrange & Act: the model weighs a candidate claim inside <think>,
    // discards it in the same breath, and answers NONE.
    const fixture = await runForeignTurn("scratchpad-holds-a-draft");

    // Assert: the answer was NONE, so nothing reaches the spool.
    // BEFORE: the brace hunt started at the first `{` ANYWHERE in stdout, so
    // the DISCARDED candidate was filed as a teammate-visible draft — a
    // fabricated conclusion, correctly clamped and correctly labelled
    // derived, and about nothing. The worst defect this path has had.
    expect(await spooledClaims(fixture)).toHaveLength(0);
    const state = await readSessionState(fixture.home, FOREIGN_SESSION_ID);
    expect(state?.summarizerDraftCount).toBe(0);
    expect(state?.summarizerNoneCount).toBe(1);
  });

  test("a closing pleasantry containing a brace does not destroy the answer", async () => {
    // Arrange & Act: a perfectly good claim, followed by "want the {full}
    // breakdown?".
    const fixture = await runForeignTurn("braced-chatter-json");

    // Assert: the claim lands. BEFORE: the hunt ran to the LAST `}` in
    // stdout, so the answer and the pleasantry were parsed as one object,
    // JSON.parse threw, and a correct answer was thrown away in silence.
    const claims = await spooledClaims(fixture);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.body.body).toBe(expectedBody("braced-chatter-json"));
    const state = await readSessionState(fixture.home, FOREIGN_SESSION_ID);
    expect(state?.summarizerDraftCount).toBe(1);
  });

  test("an answer nobody can read is booked, not left as arithmetic", async () => {
    // Arrange & Act: the model ignores the output contract and just talks —
    // the likeliest outcome the moment the binary is not a Claude whose
    // output shape the prompts were tuned on.
    const fixture = await runForeignTurn("prose-only");

    // Assert: its own outcome, with its own reason. BEFORE: this class was
    // booked NOWHERE. Its only trace was the fires-minus-outcomes remainder
    // on the cost line — a gap with no reason attached and no remedy
    // anywhere, which is exactly the silently-dead failure path rule 4
    // forbids.
    const state = await readSessionState(fixture.home, FOREIGN_SESSION_ID);
    expect(state?.summarizerUnreadableCount).toBe(1);
    expect(state?.summarizerLastUnreadable).toContain("unreadable");
    // Not a runner failure: the binary ran and exited 0.
    expect(state?.summarizerFailCount).toBe(0);
    expect(await spooledClaims(fixture)).toHaveLength(0);
  });
});
