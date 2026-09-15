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
import { readSessionState } from "../src/state/session-state.ts";
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
