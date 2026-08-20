/**
 * `hasSpendablePendingEnd` must answer true for EXACTLY the markers
 * `endDeferredSession` would actually spend a hub call on. The probe is what
 * costs the hosting hook one request timeout of drain budget (the holdback —
 * connector-claude/test/hook-budget.test.ts pins the livelock it prevents),
 * so a marker the reap would discard or retire WITHOUT a hub call must not
 * tax the drain: an unreadable marker is deleted on sight, and an expired one
 * is retired into the unclosed count — neither can ever spend the holdback.
 * The adversarial review measured the mismatch: an expired marker with an
 * empty backlog held one full request timeout back from a drain that had
 * real records to move, for a call that was never going to happen.
 *
 * All five faces are driven through real files and an injected clock — no
 * wall time is read anywhere in here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";

import { MAX_SPOOL_AGE_DAYS, MS_PER_DAY } from "../src/constants.ts";
import {
  ensureDir,
  repoKey,
  sessionSlug,
  spoolDir,
  spoolPendingEndPath,
} from "../src/config/paths.ts";
import { appendRecords } from "../src/spool/append.ts";
import { hasSpendablePendingEnd } from "../src/spool/reap.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import { makeHome } from "./helpers.ts";

const HUB_URL = "http://127.0.0.1:9";
const REPO_ID = "github.com/acme/api";
const KEY = repoKey(HUB_URL, REPO_ID);
/** The injected clock every case below measures marker age against. */
const NOW = new Date("2026-08-20T12:00:00.000Z");

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const home = async (label: string): Promise<string> => {
  const dir = await makeHome(label);
  paths.push(dir);
  return dir;
};

const strandMarker = async (
  dir: string,
  hostSessionKey: string,
  deferredAt: Date,
): Promise<void> => {
  await ensureDir(spoolDir(dir, KEY));
  await writeFile(
    spoolPendingEndPath(dir, KEY, sessionSlug(hostSessionKey)),
    `${JSON.stringify({
      crosscheckSessionId: `cc_${hostSessionKey}`,
      at: deferredAt.toISOString(),
    })}\n`,
    "utf8",
  );
};

const targetRecord = (hostSessionKey: string): Record<string, unknown> => ({
  cx: "0.1",
  id: "env_probe_1",
  ts: NOW.toISOString(),
  producer: {
    developerId: "dev_self",
    agentKind: "claude-code",
    sessionId: `cc_${hostSessionKey}`,
  },
  kind: "target",
  body: { workContextId: "wc_1", kind: "file", value: "src/f.ts" },
});

describe("hasSpendablePendingEnd", () => {
  test("a dead session's marker with a drained backlog is spendable", async () => {
    // Arrange: a marker, no state file, nothing left in the spool.
    const dir = await home("probe-spendable");
    await strandMarker(dir, "dead-uuid", NOW);

    // Act + Assert
    expect(await hasSpendablePendingEnd(dir, KEY, NOW)).toBe(true);
  });

  test("a marker whose session came back to life holds nothing back", async () => {
    // Arrange: same marker, but the session's state file exists again —
    // that session will end itself, so the reap would never touch it.
    const dir = await home("probe-live");
    await strandMarker(dir, "alive-uuid", NOW);
    await writeSessionState(dir, {
      hostSessionKey: "alive-uuid",
      crosscheckSessionId: "cc_alive-uuid",
      workContextId: "wc_cc_alive-uuid",
      repoId: REPO_ID,
      repoRoot: "/tmp/none",
      hubUrl: HUB_URL,
      developerId: "dev_self",
      startedAt: NOW.toISOString(),
      lastHeartbeatAt: null,
      seenTargets: [],
    });

    // Act + Assert
    expect(await hasSpendablePendingEnd(dir, KEY, NOW)).toBe(false);
  });

  test("a marker still waiting on its own backlog holds nothing back", async () => {
    // Arrange: the marker's session left records on disk — draining is what
    // that marker waits for, so the drain keeps its full spare.
    const dir = await home("probe-backlog");
    await strandMarker(dir, "waiting-uuid", NOW);
    await appendRecords(dir, KEY, "waiting-uuid", [targetRecord("waiting-uuid")], NOW);

    // Act + Assert
    expect(await hasSpendablePendingEnd(dir, KEY, NOW)).toBe(false);
  });

  test("an EXPIRED marker is not spendable — reap retires it without a hub call", async () => {
    // Arrange: deferred one day past MAX_SPOOL_AGE_DAYS. `endDeferredSession`
    // counts and removes this marker BEFORE it ever consults the ender, so a
    // holdback for it would starve the drain for a call that cannot happen.
    const dir = await home("probe-expired");
    const deferredAt = new Date(
      NOW.getTime() - (MAX_SPOOL_AGE_DAYS + 1) * MS_PER_DAY,
    );
    await strandMarker(dir, "expired-uuid", deferredAt);

    // Act + Assert
    expect(await hasSpendablePendingEnd(dir, KEY, NOW)).toBe(false);
  });

  test("an UNREADABLE marker is not spendable — reap discards it on sight", async () => {
    // Arrange: bytes no session id can be read out of. The reap deletes such
    // a marker without any hub call, so it can never spend a holdback either.
    const dir = await home("probe-garbage");
    await ensureDir(spoolDir(dir, KEY));
    await writeFile(
      spoolPendingEndPath(dir, KEY, sessionSlug("garbage-uuid")),
      "not json at all\n",
      "utf8",
    );

    // Act + Assert
    expect(await hasSpendablePendingEnd(dir, KEY, NOW)).toBe(false);
  });
});
