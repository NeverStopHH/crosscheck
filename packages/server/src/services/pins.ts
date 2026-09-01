/**
 * The pin registry (regression-guard Stage 1): read, write and retract a
 * human's statement that a named surface currently WORKS.
 *
 * WHAT THIS SERVICE IS NOT. It never decides whether a change was deliberate
 * — no product in five surveyed mechanism families attempts that inference,
 * because without a declared reference the question is formally unanswerable.
 * This module stores the reference; `services/suspect.ts` reads it back after
 * the fact. Nothing here can interrupt anybody: every entry point serves a
 * command a person ran in a terminal.
 *
 * THE COVERAGE DENOMINATOR IS PART OF EVERY READ, not a separate endpoint.
 * "4 pins (12 files)" must never be readable as protection of the other 8,400
 * files in the repo, so the count travels with the list and `status` prints
 * both halves of the sentence.
 */
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNull,
  min,
  sql,
} from "drizzle-orm";
import { MAX_SPEAKING_PIN_FILES, isSpeakingPin } from "@crosscheck/schema";
import type { Pin } from "@crosscheck/schema";

import {
  agentSessions,
  developers,
  pinFiles,
  pins,
  workContextTargets,
  workContexts,
} from "../db/schema.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

/**
 * Read bound on one registry listing. A registry past this is not a registry,
 * it is a second copy of the file tree — and the coverage aggregate below is
 * computed in SQL rather than from the listed rows, so the numbers stay true
 * even at the cap (a listing that silently truncated its own denominator
 * would be the fail-silent shape this feature exists to remove).
 */
export const MAX_PINS_LISTED = 200;

interface Deps {
  readonly db: Db;
  readonly now: Clock;
}

export interface PinFileView {
  readonly path: string;
  readonly status: string;
}

export interface PinView {
  readonly id: string;
  readonly repo: string;
  readonly surface: string;
  readonly files: readonly PinFileView[];
  readonly check: string | null;
  /** Stored, not derived: the trust label prints "verified by a human". */
  readonly captureMode: string;
  readonly verifiedById: string;
  readonly verifiedByName: string;
  readonly verifiedAtCommit: string;
  readonly verifiedAt: string;
  readonly brokeAt: string | null;
  readonly brokeByName: string | null;
  /** Small enough to speak AND falsifiable — Stage 2's eligibility, printed now. */
  readonly speaking: boolean;
  /** Paths the sweep could not find at HEAD; > 0 means the pin is rotting. */
  readonly missingPaths: number;
}

export interface PinCoverage {
  /** LIVE pins — a retracted pin watches nothing and is counted separately. */
  readonly pins: number;
  readonly files: number;
  readonly speaking: number;
  readonly broken: number;
  readonly missingPaths: number;
  readonly oldestVerifiedAt: string | null;
}

export interface PinRegistryView {
  readonly pins: readonly PinView[];
  readonly coverage: PinCoverage;
}

export type CreatePinOutcome =
  | { readonly outcome: "created"; readonly id: string }
  | { readonly outcome: "duplicate" };

export type BreakPinOutcome = "broken" | "not_found";

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/**
 * Under the `touched_files` policy: which of these paths this developer has
 * NO recorded touch on, anywhere in this repo's history the hub holds.
 *
 * NO TIME WINDOW, deliberately. The policy exists against "a pin on code the
 * pinner has never opened", and a pin on a surface somebody verified two
 * months ago is exactly the pin worth having. The query is still bounded —
 * it is driven by the path list through work_context_targets' (kind, value)
 * index and narrowed to one developer — so its cost follows the pin's file
 * set, never the corpus.
 *
 * Returned as a LIST rather than a boolean because the refusal names the
 * files: "you may not pin that" with no path is a refusal nobody can act on.
 */
export const untouchedByDeveloper = async (
  deps: Deps,
  developerId: string,
  repo: string,
  files: readonly string[],
): Promise<readonly string[]> => {
  if (files.length === 0) {
    return [];
  }
  const rows = await deps.db
    .selectDistinct({ value: workContextTargets.value })
    .from(workContextTargets)
    .innerJoin(
      workContexts,
      eq(workContextTargets.workContextId, workContexts.id),
    )
    .innerJoin(agentSessions, eq(workContexts.sessionId, agentSessions.id))
    .where(
      and(
        eq(workContextTargets.kind, "file"),
        inArray(workContextTargets.value, [...files]),
        eq(agentSessions.repo, repo),
        eq(agentSessions.developerId, developerId),
      ),
    );
  const touched = new Set(rows.map((row) => row.value));
  return files.filter((file) => !touched.has(file));
};

/**
 * INSERT the pin and its files in ONE transaction: a pin row with no file
 * rows would be a registered surface watching nothing, which `status` would
 * happily count. `onConflictDoNothing` on the id makes a retry idempotent and
 * a COLLISION visible — the caller mints the id, so a second body under an
 * existing id is either a replayed request or somebody overwriting another
 * person's pin, and both want the 409 rather than a silent rewrite.
 */
export const createPin = async (
  deps: Deps,
  developerId: string,
  input: Pin,
): Promise<CreatePinOutcome> => {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(pins)
      .values({
        id: input.id,
        repo: input.repo,
        surface: input.surface,
        verifiedBy: developerId,
        verifiedAtCommit: input.verifiedAtCommit,
        verifiedAt: now,
        checkRecipe: input.check ?? null,
        // The literal the schema already enforced. Stored so the reader can
        // tell a human's word from an agent's report of one.
        captureMode: input.captureMode,
        brokeAt: null,
        brokeBy: null,
        createdAt: now,
      })
      .onConflictDoNothing({ target: pins.id })
      .returning({ id: pins.id });
    if (inserted[0] === undefined) {
      return { outcome: "duplicate" } as const;
    }
    // Deduped here rather than in the schema: two spellings of the same path
    // in one file set are a typo, not two watched files, and letting them
    // through would inflate the coverage denominator.
    const distinctPaths = [...new Set(input.files)];
    await tx.insert(pinFiles).values(
      distinctPaths.map((path) => ({
        pinId: input.id,
        repo: input.repo,
        path,
        status: "present" as const,
      })),
    );
    return { outcome: "created", id: input.id } as const;
  });
};

/**
 * The retraction. ANY member may record it, and who did is stored: the check
 * recipe belongs to the team, so the person who ran it and watched it fail is
 * often not the person who wrote the pin. A claim you cannot retract is a
 * monument, not a claim.
 *
 * IDEMPOTENT by design — re-breaking an already broken pin keeps the FIRST
 * timestamp, because that is when the surface was observed broken, and
 * `suspect` reads that timestamp as the falsifier's date.
 */
export const markPinBroke = async (
  deps: Deps,
  developerId: string,
  pinId: string,
): Promise<BreakPinOutcome> => {
  const updated = await deps.db
    .update(pins)
    .set({ brokeAt: deps.now(), brokeBy: developerId })
    .where(and(eq(pins.id, pinId), isNull(pins.brokeAt)))
    .returning({ id: pins.id });
  if (updated[0] !== undefined) {
    return "broken";
  }
  const existing = await deps.db
    .select({ id: pins.id })
    .from(pins)
    .where(eq(pins.id, pinId))
    .limit(1);
  return existing[0] === undefined ? "not_found" : "broken";
};

/** One aggregate over the LIVE pins of one repo — the printed denominator. */
const readCoverage = async (deps: Deps, repo: string): Promise<PinCoverage> => {
  const [live] = await deps.db
    .select({
      pins: countDistinct(pins.id),
      files: count(pinFiles.path),
      missingPaths: sql<number>`count(*) filter (where ${pinFiles.status} = 'missing')`,
      oldestVerifiedAt: min(pins.verifiedAt),
    })
    .from(pins)
    .leftJoin(pinFiles, eq(pinFiles.pinId, pins.id))
    .where(and(eq(pins.repo, repo), isNull(pins.brokeAt)));
  const [broken] = await deps.db
    .select({ broken: count() })
    .from(pins)
    .where(and(eq(pins.repo, repo), sql`${pins.brokeAt} IS NOT NULL`));
  // "Speaking" is two facts — file count and a check recipe — so it is
  // counted from the file rows rather than guessed from a column.
  const speakingRows = await deps.db
    .select({ pinId: pinFiles.pinId, files: count(), check: min(pins.checkRecipe) })
    .from(pinFiles)
    .innerJoin(pins, eq(pinFiles.pinId, pins.id))
    .where(and(eq(pins.repo, repo), isNull(pins.brokeAt)))
    .groupBy(pinFiles.pinId);
  const speaking = speakingRows.filter(
    (row) =>
      Number(row.files) <= MAX_SPEAKING_PIN_FILES &&
      row.check !== null &&
      row.check.length > 0,
  ).length;
  const oldest = live?.oldestVerifiedAt ?? null;
  return {
    pins: Number(live?.pins ?? 0),
    files: Number(live?.files ?? 0),
    speaking,
    broken: Number(broken?.broken ?? 0),
    missingPaths: Number(live?.missingPaths ?? 0),
    oldestVerifiedAt:
      oldest === null
        ? null
        : iso(oldest instanceof Date ? oldest : new Date(oldest)),
  };
};

const toPinView = (
  row: {
    readonly id: string;
    readonly repo: string;
    readonly surface: string;
    readonly checkRecipe: string | null;
    readonly captureMode: string;
    readonly verifiedById: string;
    readonly verifiedByName: string;
    readonly verifiedAtCommit: string;
    readonly verifiedAt: Date;
    readonly brokeAt: Date | null;
  },
  files: readonly PinFileView[],
  brokeByName: string | null,
): PinView => ({
  id: row.id,
  repo: row.repo,
  surface: row.surface,
  files,
  check: row.checkRecipe,
  captureMode: row.captureMode,
  verifiedById: row.verifiedById,
  verifiedByName: row.verifiedByName,
  verifiedAtCommit: row.verifiedAtCommit,
  verifiedAt: row.verifiedAt.toISOString(),
  brokeAt: iso(row.brokeAt),
  brokeByName,
  speaking: isSpeakingPin({
    files: files.map((file) => file.path),
    check: row.checkRecipe ?? undefined,
  }),
  missingPaths: files.filter((file) => file.status === "missing").length,
});

/**
 * The repo's registry, newest first, with every pin's files and author.
 *
 * THREE BOUNDED QUERIES: the pin page (MAX_PINS_LISTED), the file rows of
 * exactly those pins, and the names of whoever retracted any of them. Broken
 * pins stay in the LIST — a retraction is knowledge, and hiding it would
 * leave "why did this pin stop mattering" unanswerable — while the coverage
 * above counts only the live ones.
 */
export const listPins = async (
  deps: Deps,
  repo: string,
): Promise<PinRegistryView> => {
  const rows = await deps.db
    .select({
      id: pins.id,
      repo: pins.repo,
      surface: pins.surface,
      checkRecipe: pins.checkRecipe,
      captureMode: pins.captureMode,
      verifiedById: pins.verifiedBy,
      verifiedByName: developers.name,
      verifiedAtCommit: pins.verifiedAtCommit,
      verifiedAt: pins.verifiedAt,
      brokeAt: pins.brokeAt,
      brokeBy: pins.brokeBy,
    })
    .from(pins)
    .innerJoin(developers, eq(pins.verifiedBy, developers.id))
    .where(eq(pins.repo, repo))
    .orderBy(desc(pins.createdAt), asc(pins.id))
    .limit(MAX_PINS_LISTED);
  const ids = rows.map((row) => row.id);
  const files =
    ids.length === 0
      ? []
      : await deps.db
          .select({
            pinId: pinFiles.pinId,
            path: pinFiles.path,
            status: pinFiles.status,
          })
          .from(pinFiles)
          .where(and(eq(pinFiles.repo, repo), inArray(pinFiles.pinId, ids)))
          .orderBy(asc(pinFiles.path));
  const breakerIds = [
    ...new Set(
      rows
        .map((row) => row.brokeBy)
        .filter((value): value is string => value !== null),
    ),
  ];
  const breakers =
    breakerIds.length === 0
      ? []
      : await deps.db
          .select({ id: developers.id, name: developers.name })
          .from(developers)
          .where(inArray(developers.id, breakerIds));
  const breakerNames = new Map(breakers.map((row) => [row.id, row.name]));
  const filesByPin = new Map<string, PinFileView[]>();
  for (const file of files) {
    const bucket = filesByPin.get(file.pinId) ?? [];
    bucket.push({ path: file.path, status: file.status });
    filesByPin.set(file.pinId, bucket);
  }
  return {
    pins: rows.map((row) =>
      toPinView(
        row,
        filesByPin.get(row.id) ?? [],
        row.brokeBy === null ? null : breakerNames.get(row.brokeBy) ?? null,
      ),
    ),
    coverage: await readCoverage(deps, repo),
  };
};

/** One pin with its files — the falsifier gate's input in `suspect`. */
export const readPin = async (
  deps: Deps,
  pinId: string,
): Promise<PinView | null> => {
  const rows = await deps.db
    .select({
      id: pins.id,
      repo: pins.repo,
      surface: pins.surface,
      checkRecipe: pins.checkRecipe,
      captureMode: pins.captureMode,
      verifiedById: pins.verifiedBy,
      verifiedByName: developers.name,
      verifiedAtCommit: pins.verifiedAtCommit,
      verifiedAt: pins.verifiedAt,
      brokeAt: pins.brokeAt,
      brokeBy: pins.brokeBy,
    })
    .from(pins)
    .innerJoin(developers, eq(pins.verifiedBy, developers.id))
    .where(eq(pins.id, pinId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const files = await deps.db
    .select({ path: pinFiles.path, status: pinFiles.status })
    .from(pinFiles)
    .where(eq(pinFiles.pinId, pinId))
    .orderBy(asc(pinFiles.path));
  const breaker =
    row.brokeBy === null
      ? []
      : await deps.db
          .select({ name: developers.name })
          .from(developers)
          .where(eq(developers.id, row.brokeBy))
          .limit(1);
  return toPinView(
    row,
    files.map((file) => ({ path: file.path, status: file.status })),
    breaker[0]?.name ?? null,
  );
};

export interface PinPathUpdate {
  readonly pinId: string;
  readonly path: string;
  /** Where git says the file is now — the same path, a new one, or null. */
  readonly newPath: string | null;
}

export interface SweepOutcome {
  readonly applied: number;
  readonly ignored: number;
}

/**
 * Records what the machine-side sweep found (git/pin-sweep.ts computes it;
 * the hub has no checkout and cannot).
 *
 * THREE MOVES, and the third is the one that keeps the register honest:
 *
 *   - a FOLLOWED RENAME rewrites the path in place, so the pin goes on
 *     watching the same behaviour under its new name;
 *   - an UNFOLLOWABLE path becomes `missing`, which doctor prints as
 *     "BROKEN — 2 of 3 paths missing" instead of counting it as watched;
 *   - a path that CAME BACK becomes present again. Branch checkouts make
 *     files vanish and return, and a sweep that could only ever mark things
 *     missing would leave permanent scars from ordinary git.
 *
 * An update naming a pin outside this repo is IGNORED and counted: the sweep
 * speaks for one checkout, and a body reaching across repos is either a bug
 * or somebody editing another team's registry from their own machine.
 */
export const applyPinSweep = async (
  deps: Deps,
  repo: string,
  updates: readonly PinPathUpdate[],
): Promise<SweepOutcome> => {
  let applied = 0;
  let ignored = 0;
  for (const update of updates) {
    const owner = await deps.db
      .select({ repo: pins.repo })
      .from(pins)
      .where(eq(pins.id, update.pinId))
      .limit(1);
    if (owner[0]?.repo !== repo) {
      ignored += 1;
      continue;
    }
    if (update.newPath === null) {
      const marked = await deps.db
        .update(pinFiles)
        .set({ status: "missing" })
        .where(
          and(eq(pinFiles.pinId, update.pinId), eq(pinFiles.path, update.path)),
        )
        .returning({ path: pinFiles.path });
      applied += marked.length;
      continue;
    }
    // INSERT-then-DELETE rather than UPDATE: the primary key is
    // (pin_id, path), so renaming onto a path the pin already watches would
    // otherwise be a constraint violation instead of a merge.
    const inserted = await deps.db
      .insert(pinFiles)
      .values({
        pinId: update.pinId,
        repo,
        path: update.newPath,
        status: "present",
      })
      .onConflictDoUpdate({
        target: [pinFiles.pinId, pinFiles.path],
        set: { status: "present" },
      })
      .returning({ path: pinFiles.path });
    if (update.newPath !== update.path) {
      await deps.db
        .delete(pinFiles)
        .where(
          and(eq(pinFiles.pinId, update.pinId), eq(pinFiles.path, update.path)),
        );
    }
    applied += inserted.length;
  }
  return { applied, ignored };
};
