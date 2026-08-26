/**
 * The shared capture bookkeeping (#17/#18/#20) — the fold every connector owes
 * its session state, pinned as the PURE transform it is: no git, no hub, no
 * temp home, so the rules are readable in one file instead of being inferred
 * from three connectors' end-to-end suites.
 *
 * Red on main: state/capture-bookkeeping.ts did not exist, and only the Claude
 * hook knew these rules — which is why a Cursor or ACP session printed
 * `0 edit-tool fires → 0 targets` however many edits it had made.
 */
import { describe, expect, test } from "bun:test";

import {
  DOCTOR_CAPTURE_SILENT_FIRES_WARN,
  DOCTOR_PATH_MAX_CHARS,
  DOCTOR_TOOL_NAME_MAX_CHARS,
} from "../src/constants.ts";
import { withCaptureBookkeeping } from "../src/state/capture-bookkeeping.ts";
import type { TouchedRootsResolution } from "../src/capture/touched-root.ts";
import { deriveSessionState } from "../src/state/session-state.ts";
import type { SessionState } from "../src/state/session-state.ts";

const NOW = new Date("2026-08-26T10:00:00.000Z");

const state = (overrides: Partial<SessionState> = {}): SessionState => ({
  ...deriveSessionState({
    hostSessionKey: "cur-conv-1",
    repoId: "github.com/acme/api",
    repoRoot: "/repos/api",
    hubUrl: "http://127.0.0.1:9",
    developerId: "dev_self",
    startedAt: NOW.toISOString(),
  }),
  ...overrides,
});

const resolution = (
  overrides: Partial<TouchedRootsResolution> = {},
): TouchedRootsResolution => ({
  rootByPath: new Map(),
  foreignDrops: 0,
  outsideDrops: 0,
  newlyResolved: [],
  firstResolvedRoot: null,
  ...overrides,
});

describe("the counters a WARN is measured on", () => {
  test("books the edit-tool fire even when every path dropped", () => {
    // Arrange: one edit, resolved to a DIFFERENT repo — nothing captured
    const before = state();

    // Act
    const after = withCaptureBookkeeping(before, {
      resolution: resolution({ foreignDrops: 1 }),
      capturedCount: 0,
      editFired: true,
      toolLabel: "afterFileEdit",
      firstPath: "/repos/web/src/app.ts",
      now: NOW,
    });

    // Assert: "1 fire → 0 targets" is exactly what a reader must see
    expect(after.editToolFires).toBe(1);
    expect(after.targetsCapturedCount).toBe(0);
    expect(after.foreignRepoDrops).toBe(1);
    expect(after.outsideRootDrops).toBe(0);
    expect(after.lastPostToolUseTool).toBe("afterFileEdit");
    expect(after.lastEditedPath).toBe("/repos/web/src/app.ts");
    expect(after.lastEditedPathResolvedAgainst).toBeNull();
    expect(after.lastTargetAt).toBeNull();
  });

  test("a captured target stamps lastTargetAt; a dropped one leaves it alone", () => {
    // Arrange
    const landed = withCaptureBookkeeping(state(), {
      resolution: resolution({ firstResolvedRoot: "/repos/api-featB" }),
      capturedCount: 2,
      editFired: true,
      toolLabel: "edit",
      firstPath: "/repos/api-featB/src/a.ts",
      now: NOW,
    });

    // Act: a second invocation that captures nothing
    const after = withCaptureBookkeeping(landed, {
      resolution: resolution({ outsideDrops: 1 }),
      capturedCount: 0,
      editFired: true,
      toolLabel: "edit",
      firstPath: "/tmp/loose.ts",
      now: new Date(NOW.getTime() + 60_000),
    });

    // Assert
    expect(landed.lastTargetAt).toBe(NOW.toISOString());
    expect(landed.lastEditedPathResolvedAgainst).toBe("/repos/api-featB");
    expect(after.lastTargetAt).toBe(NOW.toISOString());
    expect(after.targetsCapturedCount).toBe(2);
    expect(after.editToolFires).toBe(2);
    expect(after.outsideRootDrops).toBe(1);
    expect(after.lastEditedPathResolvedAgainst).toBeNull();
  });

  test("a non-edit event never overwrites the #18 diagnosis fields", () => {
    // Arrange: an edit set them, then a read-shaped event touches paths too
    const edited = withCaptureBookkeeping(state(), {
      resolution: resolution({ firstResolvedRoot: "/repos/api" }),
      capturedCount: 1,
      editFired: true,
      toolLabel: "edit",
      firstPath: "/repos/api/src/a.ts",
      now: NOW,
    });

    // Act
    const after = withCaptureBookkeeping(edited, {
      resolution: resolution(),
      capturedCount: 1,
      editFired: false,
      toolLabel: "read",
      firstPath: "/repos/api/src/b.ts",
      now: NOW,
    });

    // Assert: the last EDITED path is still the last edit, and the read's
    // captured target is NOT added to the ratio's numerator (see below)
    expect(after.editToolFires).toBe(1);
    expect(after.targetsCapturedCount).toBe(1);
    expect(after.lastEditedPath).toBe("/repos/api/src/a.ts");
    expect(after.lastEditedPathResolvedAgainst).toBe("/repos/api");
    expect(after.lastPostToolUseTool).toBe("read");
  });

  test("a non-edit touch's captured targets cannot mask the WARN", () => {
    // Arrange: three in-repo READS, each capturing a target — the shape only
    // ACP can produce, because only there does a non-edit tool call carry
    // `locations`. Then DOCTOR_CAPTURE_SILENT_FIRES_WARN edits that all drop.
    let session = state();
    for (const path of ["/repos/api/a.ts", "/repos/api/b.ts", "/repos/api/c.ts"]) {
      session = withCaptureBookkeeping(session, {
        resolution: resolution({ firstResolvedRoot: "/repos/api" }),
        capturedCount: 1,
        editFired: false,
        toolLabel: "read",
        firstPath: path,
        now: NOW,
      });
    }

    // Act
    for (let index = 0; index < DOCTOR_CAPTURE_SILENT_FIRES_WARN; index += 1) {
      session = withCaptureBookkeeping(session, {
        resolution: resolution({ foreignDrops: 1 }),
        capturedCount: 0,
        editFired: true,
        toolLabel: "edit",
        firstPath: "/repos/other/src/x.ts",
        now: NOW,
      });
    }

    // Assert: fires >= the threshold AND targets 0 — the predicate the doctor
    // WARN is measured on stays reachable, and the reads' targets did not
    // silently become evidence that edit capture is alive
    expect(session.editToolFires).toBe(DOCTOR_CAPTURE_SILENT_FIRES_WARN);
    expect(session.targetsCapturedCount).toBe(0);
    // ...while the reads' targets DID land, so the moment one did is stamped
    expect(session.lastTargetAt).toBe(NOW.toISOString());
  });

  test("a non-edit touch's drops never raise a foreign-repo WARN", () => {
    // Arrange: a session that has edited NOTHING, whose agent read a file in
    // a second connected repo and a file under no root at all
    const before = state();

    // Act
    const after = withCaptureBookkeeping(before, {
      resolution: resolution({ foreignDrops: 1, outsideDrops: 1 }),
      capturedCount: 0,
      editFired: false,
      toolLabel: "read",
      firstPath: "/repos/web/src/app.ts",
      now: NOW,
    });

    // Assert: doctor WARNs machine-wide on drops > 0, and "one agent session
    // reports to one repo — open the other repo as its own session" is not
    // advice a session that never edited anything has earned
    expect(after.foreignRepoDrops).toBe(0);
    expect(after.outsideRootDrops).toBe(0);
    expect(after.editToolFires).toBe(0);
  });

  test("a null tool label keeps the previous one rather than erasing it", () => {
    // Arrange: Cursor's afterFileEdit carries no tool name; an ACP
    // tool_call_update carries no kind — neither may blank the last one.
    const before = withCaptureBookkeeping(state(), {
      resolution: null,
      capturedCount: 0,
      editFired: true,
      toolLabel: "edit",
      firstPath: null,
      now: NOW,
    });

    // Act
    const after = withCaptureBookkeeping(before, {
      resolution: null,
      capturedCount: 0,
      editFired: false,
      toolLabel: null,
      firstPath: null,
      now: NOW,
    });

    // Assert
    expect(after.lastPostToolUseTool).toBe("edit");
  });
});

describe("the root cache and the drops it explains", () => {
  test("newly resolved roots are folded in with the attempts they cost", () => {
    // Arrange
    const before = state();

    // Act
    const after = withCaptureBookkeeping(before, {
      resolution: resolution({
        newlyResolved: [
          {
            root: "/repos/api-featB",
            repoId: "github.com/acme/api",
            attempts: 1,
            stamp: "1:2:3",
          },
          { root: "/repos/mystery", repoId: null, attempts: 2, stamp: null },
        ],
        outsideDrops: 1,
      }),
      capturedCount: 1,
      editFired: true,
      toolLabel: "Edit",
      firstPath: "/repos/api-featB/src/a.ts",
      now: NOW,
    });

    // Assert: a positive and an UNKNOWN answer are both remembered, and the
    // unknown keeps its attempt budget so the resolver may retry it
    expect(after.knownWorktreeRoots).toEqual([
      {
        root: "/repos/api-featB",
        repoId: "github.com/acme/api",
        attempts: 1,
        stamp: "1:2:3",
      },
      { root: "/repos/mystery", repoId: null, attempts: 2, stamp: null },
    ]);
  });

  test("a null resolution books no drops and no cache entries", () => {
    // Arrange: an edit event that carried no path at all
    const before = state({ foreignRepoDrops: 3, outsideRootDrops: 4 });

    // Act
    const after = withCaptureBookkeeping(before, {
      resolution: null,
      capturedCount: 0,
      editFired: true,
      toolLabel: "afterFileEdit",
      firstPath: null,
      now: NOW,
    });

    // Assert: the fire counts, nothing else moves
    expect(after.editToolFires).toBe(1);
    expect(after.foreignRepoDrops).toBe(3);
    expect(after.outsideRootDrops).toBe(4);
    expect(after.knownWorktreeRoots).toEqual([]);
    expect(after.lastEditedPath).toBeNull();
  });

  test("the transform never mutates the state handed to it", () => {
    // Arrange
    const before = state();

    // Act
    withCaptureBookkeeping(before, {
      resolution: resolution({
        foreignDrops: 1,
        newlyResolved: [
          { root: "/repos/x", repoId: null, attempts: 1, stamp: null },
        ],
      }),
      capturedCount: 1,
      editFired: true,
      toolLabel: "Edit",
      firstPath: "/repos/x/a.ts",
      now: NOW,
    });

    // Assert
    expect(before.editToolFires).toBe(0);
    expect(before.foreignRepoDrops).toBe(0);
    expect(before.knownWorktreeRoots).toEqual([]);
    expect(before.lastEditedPath).toBeNull();
  });
});

describe("the two diagnosis fields the agent gets to choose (finding A5)", () => {
  test("a huge path is stored bounded, not verbatim", () => {
    // Arrange: on Claude and Cursor these strings come from the trusted host,
    // but on ACP `firstPath` is a `locations[].path` off the untrusted wire
    // and `toolLabel` is the agent's own `kind`. Neither had a length bound,
    // so one session/update with a ~1 MiB path wrote a megabyte-scale state
    // file that every later capture, `crosscheck status` and `crosscheck
    // doctor` then re-parsed and re-wrote under the state lock.
    const before = state();
    const huge = `/repos/api/${"a".repeat(300_000)}.ts`;

    // Act
    const after = withCaptureBookkeeping(before, {
      resolution: resolution({ outsideDrops: 1 }),
      capturedCount: 0,
      editFired: true,
      toolLabel: "x".repeat(300_000),
      firstPath: huge,
      now: NOW,
    });

    // Assert: bounded to what can ever be DISPLAYED, keeping the TAIL — the
    // same rule and the same direction as doctor's own renderer, so nothing a
    // reader used to see changes
    expect(after.lastEditedPath?.length).toBe(DOCTOR_PATH_MAX_CHARS);
    expect(after.lastEditedPath?.endsWith("aaa.ts")).toBe(true);
    expect(after.lastPostToolUseTool?.length).toBe(DOCTOR_TOOL_NAME_MAX_CHARS);
  });

  test("a path that fits is stored byte-for-byte", () => {
    // Arrange: the bound must be invisible for every real path
    const before = state();

    // Act
    const after = withCaptureBookkeeping(before, {
      resolution: resolution({ outsideDrops: 1 }),
      capturedCount: 0,
      editFired: true,
      toolLabel: "afterFileEdit",
      firstPath: "/repos/api/src/auth/refresh.ts",
      now: NOW,
    });

    // Assert
    expect(after.lastEditedPath).toBe("/repos/api/src/auth/refresh.ts");
    expect(after.lastPostToolUseTool).toBe("afterFileEdit");
  });

  test("a path carrying a secret is refused, not stored and printed", () => {
    // Arrange: the identical string would be REFUSED as a capture target by
    // `containsSecret` inside captureFileTargets. Storing it in the state
    // file — which doctor prints — was the one way round that screen. The
    // fixture below is a synthetic non-credential shaped to trip the matcher.
    const before = state();

    // Act
    const after = withCaptureBookkeeping(before, {
      resolution: resolution({ outsideDrops: 1 }),
      capturedCount: 0,
      editFired: true,
      toolLabel: "edit",
      firstPath: `/tmp/ghp_${"0123456789".repeat(4)}/x.ts`,
      now: NOW,
    });

    // Assert: the diagnosis field stays empty rather than becoming a leak
    expect(after.lastEditedPath).toBeNull();
    // ...and the drop it explains is still counted, so the WARN still fires
    expect(after.editToolFires).toBe(1);
    expect(after.outsideRootDrops).toBe(1);
  });
});
