/**
 * WHAT A DECLARED SURFACE COSTS, and what an author is told it cost.
 *
 * `resolveDeclaredSurface` breaks when paths KEPT reach the cap, which never
 * fires for a list whose entries all fail to resolve — the cap bounds the
 * answer, not the work. These are the guards for the second break, the one
 * that bounds the walk, and for the sentence that distinguishes a path refused
 * on inspection from a path nobody ever looked at.
 */
import { describe, expect, test } from "bun:test";

import {
  MAX_CLAIM_SURFACE_CANDIDATES,
  MAX_CLAIM_SURFACE_PATHS,
} from "../src/constants.ts";
import {
  droppedSurfaceNote,
  resolveDeclaredSurface,
} from "../src/flows/claim-surface.ts";

const root = process.cwd();

/** A path that resolves outside the repo — dropped, but only after a realpath. */
const outside = (index: number): string => `../outside-${String(index)}/x.ts`;

describe("a declared surface is bounded by what it reads, not what it keeps", () => {
  test("a real path past the candidate budget is never read", async () => {
    // THE ANCHOR. Every entry ahead of the real one is unresolvable, so the
    // keep cap never fires and only the walk budget can stop the loop. Remove
    // that break and `packages/connector-core/src/constants.ts` is kept —
    // which is also exactly the cost being refused: the walk that found it
    // read every one of the entries before it.
    const paths = [
      ...Array.from({ length: MAX_CLAIM_SURFACE_CANDIDATES + 1 }, (_unused, index) =>
        outside(index),
      ),
      "packages/connector-core/src/constants.ts",
    ];
    const surface = await resolveDeclaredSurface({ repoRoot: root, cwd: root, paths });
    expect(surface.paths).toEqual([]);
    expect(surface.dropped).toBe(paths.length);
    expect(surface.unexamined).toBe(paths.length - MAX_CLAIM_SURFACE_CANDIDATES);
  });

  test("a wire-legal declaration is read to the end", async () => {
    // The budget must sit far enough above the keep cap that ordinary
    // attrition cannot eat a legal declaration. One denied path per kept one
    // is well inside it.
    const paths = Array.from({ length: MAX_CLAIM_SURFACE_PATHS }, (_unused, index) => [
      outside(index),
      "packages/connector-core/src/constants.ts",
    ]).flat();
    const surface = await resolveDeclaredSurface({ repoRoot: root, cwd: root, paths });
    expect(surface.paths).toEqual(["packages/connector-core/src/constants.ts"]);
    expect(surface.unexamined).toBe(0);
  });

  test("the note names a reason only for the paths a verdict was reached on", () => {
    // A path past the budget has NO verdict — it was never opened. Telling its
    // author it was "denied by policy" is a reason written after the fact for
    // a measurement that never happened, which is the shape principle 3
    // forbids one level down in the claim ledger.
    const cut = droppedSurfaceNote({ paths: [], dropped: 200, unexamined: 80 });
    expect(cut).toContain("120 were dropped on inspection");
    expect(cut).toContain("80 were never inspected");

    const inspected = droppedSurfaceNote({ paths: [], dropped: 3, unexamined: 0 });
    expect(inspected).toContain("3 were dropped on inspection");
    expect(inspected).not.toContain("never inspected");

    expect(droppedSurfaceNote({ paths: ["a.ts"], dropped: 0, unexamined: 0 })).toBeNull();
  });
});
