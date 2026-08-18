/**
 * Block 2 compat pins (DESIGN-agent-agnostic.md §1.3): the `claudeSessionId`
 * → `hostSessionKey` rename must be invisible on disk and on the wire for
 * every existing Claude Code session.
 *
 * THE FIXTURES ARE FROZEN OUTPUT OF THE PRE-CHANGE CODE, not a reconstruction:
 * fixtures/compat/session-state-pre-block2.json was written by the old
 * writeSessionState at 57362fe (the last commit before this rename), and
 * fixtures/compat/identity-pins.json records the old code's slug, path and id
 * derivations for representative session ids. Nothing in this file derives an
 * expected value from the current implementation — that is the point.
 *
 * VERIFY: grep -c '"claudeSessionId"' packages/connector-core/test/fixtures/compat/session-state-pre-block2.json
 * PRINTS: 1
 * (the fixture really is old-schema: it carries the legacy key, and the tests
 * below prove the current code still reads it.)
 *
 * Three pinned guarantees, per the block spec:
 *   (a) a state file written by pre-change code parses and resolves
 *       identically — every field, and the identity triple in particular;
 *   (b) slug/filename derivation is byte-identical to the pre-change output
 *       for Claude session ids, so no spool or state file is orphaned;
 *   (c) MCP session resolution finds the same session for the same inputs,
 *       reading a legacy state file it did not write.
 */
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  sessionSlug,
  sessionStatePath,
  spoolDataPath,
} from "../src/config/paths.ts";
import {
  SessionStateSchema,
  crosscheckSessionIdFor,
  readSessionState,
  updateSessionState,
  withSeenTargets,
  workContextIdFor,
  writeSessionState,
} from "../src/state/session-state.ts";
import { resolveOwnWorkContext } from "../src/mcp/session.ts";
import type { RepoIdentity } from "../src/git/repo-identity.ts";
import { makeHome } from "./helpers.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "compat");

interface IdentityPin {
  readonly sessionId: string;
  readonly sessionSlug: string;
  readonly sessionStatePathRelative: string;
  readonly spoolDataPathRelative: string;
  readonly crosscheckSessionId: string;
  readonly workContextId: string;
}

interface IdentityPins {
  readonly fixtureSessionId: string;
  readonly fixtureStateFileName: string;
  readonly repoKey: string;
  readonly derivations: readonly IdentityPin[];
}

const readPins = async (): Promise<IdentityPins> =>
  JSON.parse(
    await readFile(join(FIXTURE_DIR, "identity-pins.json"), "utf8"),
  ) as IdentityPins;

/** The legacy fixture, byte-for-byte as the pre-change code wrote it. */
const readLegacyFixture = async (): Promise<string> =>
  readFile(join(FIXTURE_DIR, "session-state-pre-block2.json"), "utf8");

/** Installs the frozen legacy state file into a fresh home, name unchanged. */
const installLegacyState = async (home: string): Promise<IdentityPins> => {
  const pins = await readPins();
  await mkdir(join(home, "sessions"), { recursive: true });
  await copyFile(
    join(FIXTURE_DIR, "session-state-pre-block2.json"),
    join(home, "sessions", pins.fixtureStateFileName),
  );
  return pins;
};

describe("pin (b): slug, filename and id derivations are byte-identical", () => {
  test("every frozen derivation still holds", async () => {
    // Arrange
    const pins = await readPins();

    // Act + Assert: each derived name equals the pre-change code's output.
    for (const pin of pins.derivations) {
      expect(sessionSlug(pin.sessionId), pin.sessionId).toBe(pin.sessionSlug);
      expect(
        sessionStatePath("HOME", pin.sessionId),
        pin.sessionId,
      ).toBe(join("HOME", pin.sessionStatePathRelative));
      expect(
        spoolDataPath("HOME", pins.repoKey, sessionSlug(pin.sessionId)),
        pin.sessionId,
      ).toBe(join("HOME", pin.spoolDataPathRelative));
      expect(crosscheckSessionIdFor(pin.sessionId), pin.sessionId).toBe(
        pin.crosscheckSessionId,
      );
      expect(
        workContextIdFor(crosscheckSessionIdFor(pin.sessionId)),
        pin.sessionId,
      ).toBe(pin.workContextId);
    }
  });
});

describe("pin (a): a pre-change state file parses and resolves identically", () => {
  test("the legacy claudeSessionId key parses into hostSessionKey with every field intact", async () => {
    // Arrange
    const home = await makeHome("legacy-read");
    const pins = await installLegacyState(home);
    const legacy = JSON.parse(await readLegacyFixture()) as Record<string, unknown>;

    // Act
    const state = await readSessionState(home, pins.fixtureSessionId);

    // Assert: identity triple resolved exactly as before the rename
    expect(state).not.toBeNull();
    expect(state?.hostSessionKey).toBe(pins.fixtureSessionId);
    expect(state?.crosscheckSessionId).toBe(legacy["crosscheckSessionId"] as string);
    expect(state?.workContextId).toBe(legacy["workContextId"] as string);
    // …and every non-identity field byte-equal to the frozen file.
    expect(state?.repoId).toBe(legacy["repoId"] as string);
    expect(state?.repoRoot).toBe(legacy["repoRoot"] as string);
    expect(state?.hubUrl).toBe(legacy["hubUrl"] as string);
    expect(state?.developerId).toBe(legacy["developerId"] as string);
    expect(state?.startedAt).toBe(legacy["startedAt"] as string);
    expect(state?.lastHeartbeatAt).toBe(legacy["lastHeartbeatAt"] as string);
    expect(state?.seenTargets).toEqual(legacy["seenTargets"] as string[]);
    expect(state?.deliveredHintRefs).toEqual(legacy["deliveredHintRefs"] as string[]);
    expect(state?.deliveredHintHashes).toEqual(legacy["deliveredHintHashes"] as string[]);
    expect(state?.tripwireAskedFiles).toEqual(legacy["tripwireAskedFiles"] as string[]);
    expect(state?.briefingSolvedRefs).toEqual(legacy["briefingSolvedRefs"] as string[]);
    expect(state?.stopTurnCount).toBe(legacy["stopTurnCount"] as number);
    expect(state?.summarizerFireCount).toBe(legacy["summarizerFireCount"] as number);
    expect(state?.summarizerLastFireTurn).toBe(legacy["summarizerLastFireTurn"] as number);
    expect(state?.summarizerEstimatedTokens).toBe(legacy["summarizerEstimatedTokens"] as number);
  });

  test("a state file carrying BOTH keys resolves through hostSessionKey", () => {
    // Arrange: an upgraded writer's file that a stray old writer re-added the
    // legacy key to — the design's precedence is hostSessionKey ?? legacy.
    const parsed = SessionStateSchema.safeParse({
      hostSessionKey: "new-key",
      claudeSessionId: "old-key",
      crosscheckSessionId: "cc_new-key",
      workContextId: "wc_cc_new-key",
      repoId: "github.com/acme/api",
      repoRoot: "/work/checkouts/acme-api",
      hubUrl: "https://hub.example.com",
      startedAt: "2026-08-18T09:30:00.000Z",
    });

    // Assert
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.hostSessionKey).toBe("new-key");
      // The legacy key must not survive into the parsed state: a write-back
      // would otherwise re-emit both keys forever.
      expect("claudeSessionId" in parsed.data).toBe(false);
    }
  });

  test("a mid-flight upgrade write-back keeps the filename and writes only the new key", async () => {
    // Arrange: the frozen legacy file on disk, then a routine mid-session
    // update — the exact moment a session written by old code is first
    // touched by new code.
    const home = await makeHome("legacy-upgrade");
    const pins = await installLegacyState(home);

    // Act
    const updated = await updateSessionState(home, pins.fixtureSessionId, (fresh) =>
      withSeenTargets(fresh, ["file:src/new.ts"]),
    );

    // Assert: same file, new schema, nothing else changed.
    expect(updated).toBe(true);
    const raw = await readFile(
      join(home, "sessions", pins.fixtureStateFileName),
      "utf8",
    );
    expect(raw).toContain('"hostSessionKey"');
    expect(raw).not.toContain('"claudeSessionId"');
    const reread = await readSessionState(home, pins.fixtureSessionId);
    expect(reread?.hostSessionKey).toBe(pins.fixtureSessionId);
    expect(reread?.seenTargets).toEqual([
      "file:src/app.ts",
      "symbol:startServer",
      "file:src/new.ts",
    ]);
  });

  test("a fresh write lands at the frozen filename and carries only hostSessionKey", async () => {
    // Arrange
    const home = await makeHome("fresh-write");
    const pins = await readPins();

    // Act: what the upgraded SessionStart writes for the same session id.
    await writeSessionState(home, {
      hostSessionKey: pins.fixtureSessionId,
      crosscheckSessionId: crosscheckSessionIdFor(pins.fixtureSessionId),
      workContextId: workContextIdFor(crosscheckSessionIdFor(pins.fixtureSessionId)),
      repoId: "github.com/acme/api",
      repoRoot: "/work/checkouts/acme-api",
      hubUrl: "https://hub.example.com",
      developerId: "dev_7f3a",
      startedAt: "2026-08-18T09:30:00.000Z",
    });

    // Assert: byte-identical filename to the pre-change era, new key inside.
    const raw = await readFile(
      join(home, "sessions", pins.fixtureStateFileName),
      "utf8",
    );
    expect(raw).toContain('"hostSessionKey"');
    expect(raw).not.toContain('"claudeSessionId"');
  });
});

describe("pin (c): MCP session resolution still finds the same session", () => {
  const identity: RepoIdentity = {
    repoId: "github.com/acme/api",
    root: "/work/checkouts/acme-api",
    branch: "main",
    baseCommit: "0000000000000000000000000000000000000000",
  };

  test("a legacy state file resolves to the identical work context", async () => {
    // Arrange
    const home = await makeHome("legacy-mcp");
    const pins = await installLegacyState(home);
    const legacy = JSON.parse(await readLegacyFixture()) as Record<string, unknown>;

    // Act
    const own = await resolveOwnWorkContext(home, identity, "https://hub.example.com");

    // Assert: the same session the pre-change resolver picked, same triple.
    expect(own).not.toBeNull();
    expect(own?.hostSessionKey).toBe(pins.fixtureSessionId);
    expect(own?.crosscheckSessionId).toBe(legacy["crosscheckSessionId"] as string);
    expect(own?.workContextId).toBe(legacy["workContextId"] as string);
    expect(own?.developerId).toBe(legacy["developerId"] as string);
  });

  test("legacy and new-schema files compete on startedAt exactly as two new files would", async () => {
    // Arrange: the frozen legacy session plus a NEWER new-schema sibling in a
    // different worktree — worktree preference must still pick the legacy one
    // for its own root, which proves the two schemas are one population.
    const home = await makeHome("legacy-mixed");
    const pins = await installLegacyState(home);
    await writeSessionState(home, {
      hostSessionKey: "11111111-2222-4333-8444-555555555555",
      crosscheckSessionId: "cc_11111111-2222-4333-8444-555555555555",
      workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
      repoId: "github.com/acme/api",
      repoRoot: "/work/checkouts/acme-api-other",
      hubUrl: "https://hub.example.com",
      developerId: "dev_7f3a",
      startedAt: "2026-08-18T11:00:00.000Z",
    });

    // Act
    const own = await resolveOwnWorkContext(home, identity, "https://hub.example.com");

    // Assert
    expect(own?.hostSessionKey).toBe(pins.fixtureSessionId);
  });

  test("an unparseable sibling still cannot break resolution of the legacy file", async () => {
    // Arrange
    const home = await makeHome("legacy-torn");
    const pins = await installLegacyState(home);
    await writeFile(join(home, "sessions", "torn.json"), "{ half a fi", "utf8");

    // Act
    const own = await resolveOwnWorkContext(home, identity, "https://hub.example.com");

    // Assert
    expect(own?.hostSessionKey).toBe(pins.fixtureSessionId);
  });
});
