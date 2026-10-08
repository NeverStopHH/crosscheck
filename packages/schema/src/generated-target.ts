import { z } from "zod";

/**
 * THE GENERATED-TARGET RULE (release gate N2): a file a machine writes is not
 * evidence of anybody's plan. Two people whose only common ground is a
 * lockfile and a regenerated client are not colliding, and a warning about
 * them is the over-warning the gate's negative controls exist to refuse.
 *
 * THREE SIGNALS, ALL READ ON THE DEVELOPER'S MACHINE, and this module owns the
 * one that needs no machine at all:
 *
 *   path       a well-known name at ANY depth (isGeneratedPath below);
 *   attribute  `git check-attr linguist-generated linguist-vendored` is set;
 *   header     an `@generated` token or a `Code generated … DO NOT EDIT.` line
 *              in the file's first bytes, read locally and never sent.
 *
 * The connector classifies a target and sends the signal that fired with it
 * (connector-core capture/generated.ts). The hub keeps the target — `suspect`
 * and coverage still see the touch — and leaves it out of every overlap count
 * and every context's size. The hub also applies the PATH signal itself to a
 * target that carries no field, so an older connector is covered for the
 * well-known names: which is why the path signal lives here, in the one
 * package both sides import, and nowhere else.
 *
 * FAIL TOWARD WARNING. A classification that could not run — git missing or
 * slow, the file unreadable — sends NO field and the target stays ordinary.
 * An unknown answer never becomes a reason for silence.
 */
export const GENERATED_SIGNALS = ["path", "attribute", "header"] as const;

export const GeneratedSignalSchema = z.enum(GENERATED_SIGNALS);

export type GeneratedSignal = z.infer<typeof GeneratedSignalSchema>;

/**
 * Every lockfile name, matched as the file's own name at any depth: the
 * connector's denylist anchors `package-lock.json` and `pnpm-lock.yaml` at the
 * repo root, so a monorepo's nested `apps/x/package-lock.json` reached the hub
 * as an ordinary file and two people who ran `npm install` collided on it.
 */
export const GENERATED_LOCKFILE_NAMES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
] as const;

/** A DIRECTORY with one of these names, at any depth, holds machine output. */
export const GENERATED_DIRECTORY_NAMES = ["__generated__", "generated", "dist"] as const;

/** `*.generated.*` and `*.gen.*`: the infix, anywhere in the file's own name. */
const GENERATED_NAME_INFIXES = [".generated.", ".gen."] as const;

/** Protobuf and gRPC codegen output, by the suffix each generator writes. */
const GENERATED_NAME_SUFFIXES = ["_pb2.py", ".pb.go", "_pb.ts", "_pb.js"] as const;

const LOCKFILE_NAMES: ReadonlySet<string> = new Set(GENERATED_LOCKFILE_NAMES);
const DIRECTORY_NAMES: ReadonlySet<string> = new Set(GENERATED_DIRECTORY_NAMES);

/**
 * THE PATH SIGNAL, for a repo-relative POSIX path (the only spelling a target
 * value has): a lockfile's name, a directory named for machine output, or a
 * codegen name. Pure and allocation-light — it runs on every captured path
 * and, on the hub, on every field-less target an older connector sends.
 */
export const isGeneratedPath = (path: string): boolean => {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  return (
    LOCKFILE_NAMES.has(name) ||
    segments.slice(0, -1).some((segment) => DIRECTORY_NAMES.has(segment)) ||
    GENERATED_NAME_INFIXES.some((infix) => name.includes(infix)) ||
    GENERATED_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
};
