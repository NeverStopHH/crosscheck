import { z } from "zod";

/**
 * THE GENERATED-TARGET RULE (release gate N2): a file that is MECHANICALLY
 * GENERATED AND NON-AUTHORITATIVE is not evidence of anybody's plan. Two people
 * whose only common ground is a lockfile and a regenerated client are not
 * colliding, and a warning about them is the over-warning the gate's negative
 * controls exist to refuse.
 *
 * BOTH HALVES ARE THE RULE. "Generated" alone is too absolute: a checked-in API
 * schema, a generated migration, client bindings that connect two pieces of
 * work — each is machine-written AND a shared surface two people meet on.
 * Such a file stays evidence. A default can only recognise the first half by
 * name, so the defaults below keep the names that are near-certainly both
 * (lockfiles, build output, `__generated__/`, `*.generated.*`), refuse to
 * suppress anything that resembles a contract or a migration
 * (`isContractLike`), and a repo names the rest itself — `authoritativeGenerated`
 * in its committed `.crosscheck.json` un-suppresses any file it matches
 * (connector-core capture/authoritative-generated.ts).
 *
 * THREE SIGNALS, ALL READ ON THE DEVELOPER'S MACHINE, and this module owns the
 * one that needs no machine at all:
 *
 *   path       a well-known name at ANY depth (isGeneratedPath below) — and a
 *              protobuf binding, but only beside its own `.proto`
 *              (protobufSourceOf: the connector asks the repo);
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
 * Mechanical and non-authoritative: the manifest beside it is what a person
 * changed, and the manifest is evidence.
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

/**
 * A DIRECTORY with one of these names, at any depth, holds machine output.
 * NOT `generated/`: plenty of repos hand-maintain a directory of that name,
 * and a name is all a default has — the attribute and header signals still
 * recognise one a generator really writes.
 */
export const GENERATED_DIRECTORY_NAMES = ["__generated__", "dist"] as const;

/**
 * `*.generated.*`, anywhere in the file's own name. NOT `*.gen.*`: "gen" is
 * also a generator's own source (`keys.gen.ts` that a person writes to drive
 * one), and a header or attribute is what tells the two apart.
 */
const GENERATED_NAME_INFIX = ".generated.";

/** Protobuf and gRPC codegen output, by the suffix each generator writes. */
const PROTOBUF_BINDING_SUFFIXES = ["_pb2.py", ".pb.go", "_pb.ts", "_pb.js"] as const;

/** Directories that hold migrations: a generated migration IS the change. */
const MIGRATION_DIRECTORY_NAMES: ReadonlySet<string> = new Set(["migrations", "migration", "migrate"]);

/** Source formats of a contract — a schema two pieces of work both stand on. */
const CONTRACT_EXTENSIONS = [".proto", ".graphql", ".gql", ".sql", ".prisma", ".avsc", ".thrift"] as const;

/** An API description (`openapi.json`, `api.swagger.yaml`, …) or a JSON Schema. */
const CONTRACT_NAME = /(?:openapi|swagger|asyncapi)[^/]*\.(?:json|ya?ml)$|\.schema\.json$/i;

const LOCKFILE_NAMES: ReadonlySet<string> = new Set(GENERATED_LOCKFILE_NAMES);
const DIRECTORY_NAMES: ReadonlySet<string> = new Set(GENERATED_DIRECTORY_NAMES);

const nameOf = (segments: readonly string[]): string => segments[segments.length - 1] ?? "";

/**
 * DOES THIS RESEMBLE A CONTRACT OR A MIGRATION — a schema, an API
 * description, a protocol definition, a migration? Those are the generated
 * files most often AUTHORITATIVE: a migration a tool wrote is the database
 * change itself, and a regenerated `openapi.json` is the API both sides of a
 * feature meet on. No default signal suppresses one, whichever fires: the
 * cost is a warning about a regenerated schema, and the alternative was
 * silence about the shared surface the warning exists for.
 */
export const isContractLike = (path: string): boolean => {
  const segments = path.split("/");
  const name = nameOf(segments);
  return (
    segments.slice(0, -1).some((segment) => MIGRATION_DIRECTORY_NAMES.has(segment)) ||
    CONTRACT_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
    CONTRACT_NAME.test(name)
  );
};

/**
 * The well-known NAMES alone — a lockfile, a directory of machine output, a
 * `*.generated.*` file — before the contract guard. The connector reads this
 * to say how many files the guard kept as evidence; everything that decides
 * suppression reads `isGeneratedPath`.
 */
export const matchesGeneratedName = (path: string): boolean => {
  const segments = path.split("/");
  const name = nameOf(segments);
  return (
    LOCKFILE_NAMES.has(name) ||
    segments.slice(0, -1).some((segment) => DIRECTORY_NAMES.has(segment)) ||
    name.includes(GENERATED_NAME_INFIX)
  );
};

/**
 * THE PATH SIGNAL, for a repo-relative POSIX path (the only spelling a target
 * value has): a well-known generated name that does not resemble a contract
 * or a migration. Pure and allocation-light — it runs on every captured path
 * and, on the hub, on every field-less target an older connector sends.
 */
export const isGeneratedPath = (path: string): boolean =>
  matchesGeneratedName(path) && !isContractLike(path);

/**
 * The `.proto` a protobuf binding was generated from (`messages_pb.ts` →
 * `messages.proto`), or null for any other file. A binding is suppressed
 * ONLY when that source is in the repo: with it, the `.proto` is the
 * authoritative surface and the binding a mechanical copy; without it, the
 * binding may be the only copy of the contract this repo has — a vendored
 * client two pieces of work both meet on. Only the connector can ask the
 * repo, so the hub never applies this half of the path signal.
 */
export const protobufSourceOf = (path: string): string | null => {
  const name = nameOf(path.split("/"));
  const suffix = PROTOBUF_BINDING_SUFFIXES.find(
    (candidate) => name.endsWith(candidate) && name.length > candidate.length,
  );
  return suffix === undefined ? null : `${name.slice(0, -suffix.length)}.proto`;
};
