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
 *
 * RESUME IS CHECKED AGAINST IT (A2.5). `startDecision` refuses a resume whose
 * manifest names another mode, seed, order, harness HEAD or payload-template
 * hash — so `--measured --resume` over a dry run's dir can never fold the dry
 * run's winners and voids into the measurement — and refuses `--resume` on a
 * dir with no manifest instead of running with none.
 */
import { z } from "zod";

import { MANIFEST_SEED, PAYLOAD_IDS } from "./manifest.ts";
import type { Arm, Slot } from "./manifest.ts";
import type { ProfileCheck } from "./profile.ts";
import { claudeArgs, RUN_MODEL, RUN_SETTINGS } from "./run.ts";

/** An arm as it is read back from any results file. */
export const ArmSchema = z.union([
  z.object({ kind: z.literal("control") }),
  z.object({ kind: z.literal("treatment"), payload: z.enum(PAYLOAD_IDS) }),
]);

/** The fields of a stored manifest that a resume must match. */
const StoredManifestSchema = z.looseObject({
  mode: z.string(),
  seed: z.number().nullable(),
  order: z.array(z.object({ index: z.number().int(), arm: ArmSchema })),
  harnessHead: z.string(),
  payloadTemplateHash: z.string(),
});

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

const armKey = (arm: Arm): string => (arm.kind === "control" ? "control" : arm.payload);

/** An order as one comparable string: `index:arm` per slot, in order. */
const orderKey = (order: readonly { readonly index: number; readonly arm: Arm }[]): string =>
  order.map((slot) => `${String(slot.index)}:${armKey(slot.arm)}`).join(",");

/**
 * What differs between a stored manifest and the current one, among the
 * fields A2.5 names (mode, seed, order, harness HEAD, payload-template hash).
 * Empty means a resume may continue. Anything that is not a manifest is a
 * mismatch, never a pass. The claude version is not compared: every run
 * records its own.
 */
export const resumeMismatches = (stored: unknown, current: ManifestDocument): readonly string[] => {
  const parsed = StoredManifestSchema.safeParse(stored);
  if (!parsed.success) {
    return [`manifest.json is not a manifest: ${parsed.error.message}`];
  }
  const was = parsed.data;
  const fields: readonly (readonly [string, unknown, unknown])[] = [
    ["mode", was.mode, current.mode],
    ["seed", was.seed, current.seed],
    ["order", orderKey(was.order), orderKey(current.order)],
    ["harnessHead", was.harnessHead, current.harnessHead],
    ["payloadTemplateHash", was.payloadTemplateHash, current.payloadTemplateHash],
  ];
  return fields
    .filter(([, before, now]) => before !== now)
    .map(([field, before, now]) =>
      field === "order"
        ? "order: the stored run order is not this mode's seeded order"
        : `${field}: the manifest has ${String(before)}, this harness has ${String(now)}`,
    );
};

export type StartDecision =
  | { readonly kind: "write" }
  | { readonly kind: "resume" }
  | { readonly kind: "refuse"; readonly reason: string };

export interface StartInput {
  readonly resume: boolean;
  /** The parsed manifest.json, its raw text when it does not parse, or null when absent. */
  readonly stored: unknown;
  readonly current: ManifestDocument;
}

/** Whether a sweep may start in this results dir, and how (H1, A2.5). Pure. */
export const startDecision = (input: StartInput): StartDecision => {
  if (!input.resume) {
    return input.stored === null
      ? { kind: "write" }
      : { kind: "refuse", reason: "a manifest already exists here — use --resume, or a fresh --out" };
  }
  if (input.stored === null) {
    return { kind: "refuse", reason: "--resume needs this dir's manifest.json, and there is none" };
  }
  const mismatches = resumeMismatches(input.stored, input.current);
  return mismatches.length === 0
    ? { kind: "resume" }
    : {
        kind: "refuse",
        reason: `the manifest does not match this harness (A2.5): ${mismatches.join("; ")}`,
      };
};
