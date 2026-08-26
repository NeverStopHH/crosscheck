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

    // Assert: the last EDITED path is still the last edit
    expect(after.editToolFires).toBe(1);
    expect(after.targetsCapturedCount).toBe(2);
    expect(after.lastEditedPath).toBe("/repos/api/src/a.ts");
    expect(after.lastEditedPathResolvedAgainst).toBe("/repos/api");
    expect(after.lastPostToolUseTool).toBe("read");
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
          { root: "/repos/api-featB", repoId: "github.com/acme/api", attempts: 1 },
          { root: "/repos/mystery", repoId: null, attempts: 2 },
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
      { root: "/repos/api-featB", repoId: "github.com/acme/api", attempts: 1 },
      { root: "/repos/mystery", repoId: null, attempts: 2 },
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
        newlyResolved: [{ root: "/repos/x", repoId: null, attempts: 1 }],
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
