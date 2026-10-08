/**
 * STAMPS DATED AHEAD OF THE CLOCK (review-2 round 8, L5).
 *
 * A heartbeat or a heal stamp written while the clock ran ahead — a VM resumed
 * with a drifted clock, an NTP step back — read as fresh for as long as the
 * clock stayed behind it: a dead host's state was never reaped and its spool
 * never released, and a heal's cooldown never ran out, so its life's records
 * were never sent again. A reader that finds one clamps it to now plus
 * CLOCK_SKEW_MS and writes that down, so it ages from there.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rm, utimes } from "node:fs/promises";

import { CLOCK_SKEW_MS, HEAL_COOLDOWN_MS, MAX_SPOOL_AGE_DAYS, MS_PER_DAY, MS_PER_SECOND } from "../src/constants.ts";
import { repoKey, sessionHealPathForSlug, sessionSlug, sessionStatePath, writePrivateFile } from "../src/config/paths.ts";
import { sessionHealer } from "../src/flows/heal-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../src/guarantees/declarations.ts";
import { reapStaleSessionStates } from "../src/state/session-reap.ts";
import { deriveSessionState, readSessionState, writeSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";

const HUB_URL = "http://127.0.0.1:9";
const REPO_ID = "github.com/acme/api";
const YEAR_MS = 365 * MS_PER_DAY;
/** Past the bound session-reap deletes a state file on, counted from a clamp at now. */
const PAST_REAP_BOUND_MS = MAX_SPOOL_AGE_DAYS * MS_PER_DAY + CLOCK_SKEW_MS + 60 * MS_PER_SECOND;
const cleanups: string[] = [];

afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

const fixture = async (label: string) => {
  const home = await makeHome(label);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(home, repo);
  return { home, repo, hostSessionKey: `acp-future--${label}` };
};

describe("a dead host's state dated a year ahead (review-2 round 8, L5)", () => {
  test("is clamped by the next SessionStart's reap, and reaped once silent past the bound from there", async () => {
    // Arrange: heartbeat and file both written a year ahead of the clock
    const { home, repo, hostSessionKey } = await fixture("future-heartbeat");
    const now = new Date();
    const ahead = new Date(now.getTime() + YEAR_MS);
    const state = deriveSessionState({
      hostSessionKey,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: HUB_URL,
      developerId: null,
      startedAt: ahead.toISOString(),
    });
    await writeSessionState(home, { ...state, lastHeartbeatAt: ahead.toISOString() });
    await utimes(sessionStatePath(home, hostSessionKey), ahead, ahead);

    // Act: one SessionStart now, one past the bound from now
    await reapStaleSessionStates(home, now);
    const clamped = await readSessionState(home, hostSessionKey);
    const reaped = await reapStaleSessionStates(home, new Date(now.getTime() + PAST_REAP_BOUND_MS));

    // Assert
    expect(Date.parse(clamped?.lastHeartbeatAt ?? "")).toBeLessThanOrEqual(now.getTime() + CLOCK_SKEW_MS);
    expect(reaped).toBe(1);
    expect(await readSessionState(home, hostSessionKey)).toBeNull();
  });

  test("is reaped once silent past the bound from now when only its file's write is dated ahead", async () => {
    // Arrange: a heartbeat from now, the file's mtime a year ahead
    const { home, repo, hostSessionKey } = await fixture("future-mtime");
    const now = new Date();
    const ahead = new Date(now.getTime() + YEAR_MS);
    const state = deriveSessionState({
      hostSessionKey,
      repoId: REPO_ID,
      repoRoot: repo,
      hubUrl: HUB_URL,
      developerId: null,
      startedAt: now.toISOString(),
    });
    await writeSessionState(home, { ...state, lastHeartbeatAt: now.toISOString() });
    await utimes(sessionStatePath(home, hostSessionKey), ahead, ahead);

    // Act
    await reapStaleSessionStates(home, now);
    const reaped = await reapStaleSessionStates(home, new Date(now.getTime() + PAST_REAP_BOUND_MS));

    // Assert
    expect(reaped).toBe(1);
  });
});

describe("a heal stamp dated a year ahead (review-2 round 8, L5)", () => {
  test("holds its life's records for one cooldown from now, not until the clock catches up", async () => {
    // Arrange: a finished walk that registered nothing for the life, stamped a year ahead
    const { home, hostSessionKey } = await fixture("future-heal");
    const lifeId = `cc_${hostSessionKey}`;
    const ahead = new Date(Date.now() + YEAR_MS);
    await writePrivateFile(
      sessionHealPathForSlug(home, sessionSlug(hostSessionKey)),
      `${JSON.stringify({ at: ahead.toISOString(), phase: "done", until: 0, failed: lifeId })}\n`,
    );
    let nowMs = Date.now();
    const key = repoKey(HUB_URL, REPO_ID);
    const healer = sessionHealer({
      home,
      repoKey: key,
      hub: { hubUrl: HUB_URL, apiKey: "k", timeoutMs: 400, home, repoKey: key, now: () => new Date(nowMs) },
      agentKind: "acp:test",
      hostSessionKey,
      repoId: REPO_ID,
      branch: "main",
      baseCommit: "0000000000000000000000000000000000000000",
      guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
      now: () => new Date(nowMs),
    });

    // Act: asked now, then once one cooldown and the skew have passed
    const heldNow = await healer.refusedFor?.(lifeId);
    nowMs += HEAL_COOLDOWN_MS + CLOCK_SKEW_MS + MS_PER_SECOND;
    const heldAfter = await healer.refusedFor?.(lifeId);

    // Assert
    expect(heldNow).toBe(true);
    expect(heldAfter).toBe(false);
  });
});
