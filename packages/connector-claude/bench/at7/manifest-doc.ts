/**
 * The manifest DOCUMENT — what `manifest.json` holds, written to the results
 * dir before the first run (09 §3, A1.8) — as a pure builder, so its contents
 * are pinned by a unit test rather than trusted to a live sweep.
 *
 * It records, beside the seeded order (manifest.ts):
 *   - the harness identity: HEAD, dirty flag, payload-template hash (A2.5
 *     refuses a resume when these differ from the current ones);
 *   - the claude version at sweep start (every run also records its own);
 *   - the run env the children carry (A1.5) and the exact claude argv, with
 *     the inline `--settings` and the messaging disallow (A2.1, A2.2);
 *   - the A2.2 shell-profile check: the files read and any CROSSCHECK_,
 *     CLAUDE_ or ANTHROPIC_ name they set — names only.
 */
import { MANIFEST_SEED } from "./manifest.ts";
import type { Slot } from "./manifest.ts";
import type { ProfileCheck } from "./profile.ts";
import { claudeArgs, RUN_MODEL, RUN_SETTINGS } from "./run.ts";

/** The three ways the harness runs; only `measured` is ever counted. */
export type SweepMode = "dry-run" | "measured" | "live-control";

/** Placeholder for the per-attempt fixture root in the recorded argv. */
const FIXTURE_PLACEHOLDER = "<fixture>";

export interface ManifestInput {
  readonly mode: SweepMode;
  readonly order: readonly Slot[];
  readonly claudeVersion: string;
  readonly harnessHead: string;
  readonly harnessDirty: boolean;
  readonly payloadTemplateHash: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shellProfileCheck: ProfileCheck;
  /** ISO-8601, when the manifest was written. */
  readonly createdAt: string;
}

export interface ManifestDocument extends ManifestInput {
  readonly model: string;
  /** The seed the measured order is drawn from; null for the unshuffled modes. */
  readonly seed: number | null;
  readonly runSettings: typeof RUN_SETTINGS;
  readonly claudeArgv: readonly string[];
}

export const buildManifest = (input: ManifestInput): ManifestDocument => ({
  ...input,
  model: RUN_MODEL,
  seed: input.mode === "measured" ? MANIFEST_SEED : null,
  runSettings: RUN_SETTINGS,
  claudeArgv: claudeArgs(`${FIXTURE_PLACEHOLDER}/.mcp.json`, FIXTURE_PLACEHOLDER),
});
