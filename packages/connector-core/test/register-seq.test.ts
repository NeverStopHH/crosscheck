/**
 * THE FIRST EVENT OF EVERY SESSION HAD NO POSITION, ON EVERY HOST.
 *
 * Spec 01 §3.2 gives `session.started` `n = 0`, the allocator reserves it —
 * `eventSeq` is minted at 0 and the first block starts at 1 — and the hub grew
 * a `seq` field on the register body to receive it. No connector sent one.
 * `registerSessionFlow` posted six fields and minted the epoch AFTERWARDS, so
 * the mint was on the wrong side of the call, and all three connectors share
 * this flow: the gap was host-uniform.
 *
 * WHAT AN ABSENT FIELD SAYS IS THE WORSE HALF. The hub reads a missing `seq`
 * as `pre_seq_connector` — "a connector from before this field" — so the one
 * row guaranteed to exist for every session reported an up-to-date connector
 * as an obsolete one, on every session on every hub, forever. That is exactly
 * the confounding the reason enum exists to prevent, and it made the
 * `pre_seq_connector` count — the number a reader uses to decide whether a
 * host is instrumented at all — at least 1 for every session ever recorded.
 *
 * The hub half was already green because its own test hand-writes the field
 * into the HTTP body, a shape no connector produced. This test reads the body
 * the flow actually posts.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { SeqFieldSchema } from "@crosscheck/schema";

import { registerSessionFlow } from "../src/flows/register-session.ts";
import { repoKey } from "../src/config/paths.ts";
import {
  readSessionState,
  writeSessionState,
} from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

/** Throwaway hub, in the band reserved for them. */
const PORT = 7931;
const HUB_URL = `http://127.0.0.1:${String(PORT)}`;
const REPO_ID = "github.com/acme/api";
const SESSION_KEY = "register-seq-uuid";

const bodies: Record<string, unknown>[] = [];
const paths: string[] = [];

const server = Bun.serve({
  port: PORT,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      bodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({
        session: { id: "cc_register-seq-uuid", developerId: "dev_self" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

afterEach(async () => {
  bodies.length = 0;
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

afterAll(() => {
  server.stop(true);
});

describe("registerSessionFlow positions the session it opens", () => {
  test("the register body carries position 0 under the session's own epoch", async () => {
    // Arrange
    const home = await makeHome("register-seq");
    const repo = await makeRepo("register-seq", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);

    // Act
    await registerSessionFlow({
      home,
      hub: {
        hubUrl: HUB_URL,
        apiKey: "test-key",
        timeoutMs: 2000,
        home,
        repoKey: repoKey(HUB_URL, REPO_ID),
        now: () => new Date(),
      },
      repoKey: repoKey(HUB_URL, REPO_ID),
      hostSessionKey: SESSION_KEY,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: HUB_URL,
      agentKind: "claude-code",
      branch: "main",
      baseCommit: "abc1234",
      status: "implementing",
      fallbackDeveloperId: "dev_self",
      title: "register seq",
      now: new Date(),
    });

    // Assert: the epoch on the wire is the one the state file kept, and the
    // position is the zero the allocator reserves — not an absent field the
    // hub would read as a connector from before the protocol.
    const state = await readSessionState(home, SESSION_KEY);
    expect(state?.seqEpoch).not.toBeNull();
    expect(state?.eventSeq).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.["seq"]).toEqual({ epoch: state!.seqEpoch!, n: 0 });
    // ...and it is the shape the hub validates the body with, so the two
    // halves cannot agree in this test and disagree on the wire.
    expect(SeqFieldSchema.safeParse(bodies[0]?.["seq"]).success).toBe(true);
  });
});

/**
 * THE RE-FIRE IS THE HALF THE TEST ABOVE CANNOT SEE.
 *
 * It fires once, so "the epoch on the wire is the one the state file kept"
 * held for the only reason it could: both were the same fresh mint. Claude
 * Code fires SessionStart AGAIN inside a live session on compact, resume and
 * clear, and `withCarriedCapture` keeps the PREVIOUS epoch in the state file
 * across that fire on purpose (the pair moves together, or positions already
 * handed out are re-issued). A register body that mints a fresh one anyway
 * therefore tells the hub an epoch the session does not use.
 *
 * WHY THAT IS NOT HARMLESS. It is invisible while the FIRST register landed:
 * the hub answers the re-register from its conflict branch and records no
 * second `session.started`. If the first register never reached the hub — an
 * unreachable hub, a 5xx, a rejected key, the offline start this connector is
 * built to survive — the hub holds no session row, so the re-fire's register
 * takes the CREATE branch and stores `session.started` under the foreign
 * epoch. `causalOrderOf` then sees two epochs and answers `broken /
 * epoch_split` for the WHOLE session, for the rest of its life: every
 * happens-before question in it is refused, including the explanation/edit
 * pairs this spec exists to order. Nothing repairs it — `session_events` is
 * append-only and this branch's retention is `off`.
 *
 * MEASURED before the fix, through the real hooks against a real hub with a
 * genuine refusal on the first SessionStart: four events under the carried
 * epoch, `session.started` under a foreign one, and
 * `readSessionCausalOrder` → `{"state":"broken","reason":"epoch_split"}`.
 */
describe("a SessionStart re-fire registers under the epoch the session uses", () => {
  test("the second fire sends the state file's epoch, not a fresh mint", async () => {
    // Arrange
    const home = await makeHome("register-seq-refire");
    const repo = await makeRepo("register-seq-refire", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    const fire = async (): Promise<void> => {
      await registerSessionFlow({
        home,
        hub: {
          hubUrl: HUB_URL,
          apiKey: "test-key",
          timeoutMs: 2000,
          home,
          repoKey: repoKey(HUB_URL, REPO_ID),
          now: () => new Date(),
        },
        repoKey: repoKey(HUB_URL, REPO_ID),
        hostSessionKey: SESSION_KEY,
        repoId: REPO_ID,
        repoRoot: repo,
        hubUrl: HUB_URL,
        agentKind: "claude-code",
        branch: "main",
        baseCommit: "abc1234",
        status: "implementing",
        fallbackDeveloperId: "dev_self",
        title: "register seq",
        now: new Date(),
      });
    };

    // Act: the session starts, then compacts.
    await fire();
    const afterFirst = await readSessionState(home, SESSION_KEY);
    await fire();

    // Assert: the state file carried its epoch across the re-fire, and the
    // re-fire's register body carries THAT epoch — the one every other event
    // of this session will be positioned under — rather than a second mint the
    // hub would file `session.started` under if it had no row yet.
    const afterSecond = await readSessionState(home, SESSION_KEY);
    expect(afterSecond?.seqEpoch).toBe(afterFirst!.seqEpoch!);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.["seq"]).toEqual({
      epoch: afterSecond!.seqEpoch!,
      n: 0,
    });
  });
});

/**
 * THE OTHER HALF OF THE CARRY RULE, and it has to be the SAME rule.
 *
 * `withCarriedCapture` keeps the previous epoch only when the re-fire is the
 * same BINDING — one repo, one hub — because a state file bound elsewhere is
 * another session's, and the first-wins rule decides those. The register body
 * now carries an epoch across a re-fire, so it has to answer that question the
 * same way: a body that announced a foreign state file's epoch while the
 * publication minted a fresh one would put the split back, with the two halves
 * swapped.
 */
describe("a re-fire over a foreign binding carries nothing", () => {
  test("a state file bound to another repo lends the wire no epoch", async () => {
    // Arrange: a state file for this host session key, bound to a DIFFERENT
    // repo — the shape `withCarriedCapture` refuses to carry from.
    const home = await makeHome("register-seq-foreign");
    const repo = await makeRepo("register-seq-foreign", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(home, repo);
    const foreignEpoch = "00000000-0000-4000-8000-00000000beef";
    await writeSessionState(home, {
      hostSessionKey: SESSION_KEY,
      crosscheckSessionId: "cc_register-seq-uuid",
      workContextId: "wc_register-seq-uuid",
      repoId: "github.com/acme/OTHER",
      repoRoot: repo,
      hubUrl: HUB_URL,
      developerId: "dev_self",
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      seenTargets: [],
      deliveredHintRefs: [],
      deliveredHintHashes: [],
      tripwireAskedFiles: [],
      landedAskedFiles: [],
      landedCleanKeys: [],
      workContextTitle: "foreign",
      workContextStatus: "implementing",
      seqEpoch: foreignEpoch,
      eventSeq: 9,
    });

    // Act
    await registerSessionFlow({
      home,
      hub: {
        hubUrl: HUB_URL,
        apiKey: "test-key",
        timeoutMs: 2000,
        home,
        repoKey: repoKey(HUB_URL, REPO_ID),
        now: () => new Date(),
      },
      repoKey: repoKey(HUB_URL, REPO_ID),
      hostSessionKey: SESSION_KEY,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: HUB_URL,
      agentKind: "claude-code",
      branch: "main",
      baseCommit: "abc1234",
      status: "implementing",
      fallbackDeveloperId: "dev_self",
      title: "register seq",
      now: new Date(),
    });

    // Assert: the foreign epoch reached neither half, and the two halves still
    // agree on the one that was minted.
    const state = await readSessionState(home, SESSION_KEY);
    expect(state?.seqEpoch).not.toBe(foreignEpoch);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.["seq"]).toEqual({ epoch: state!.seqEpoch!, n: 0 });
  });
});
