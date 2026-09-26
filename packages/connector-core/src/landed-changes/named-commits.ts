/**
 * The commits a landed-change stop NAMES: the first MAX_LANDED_COMMITS_SHOWN
 * it is missing, then the first MAX_LANDED_COMMITS_SHOWN recent ones it has.
 * One definition for the two readers that must agree on it — the renderer
 * (hints/render.ts), which prints those commits and a why for no other, and
 * the PreToolUse hook, which asks the hub about exactly those
 * (docs/1.0/landed-changes.md, step 3). Outside the render layer so the hook
 * can ask without becoming a render surface.
 */
import { MAX_LANDED_COMMITS_SHOWN } from "../constants.ts";
import type { LandedChanges, LandedCommit } from "./probe.ts";

export const namedLandedCommits = (landed: LandedChanges): readonly LandedCommit[] => [
  ...landed.missing.slice(0, MAX_LANDED_COMMITS_SHOWN),
  ...landed.recent.slice(0, MAX_LANDED_COMMITS_SHOWN),
];
