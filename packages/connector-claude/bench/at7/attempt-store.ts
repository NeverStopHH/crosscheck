/**
 * The results dir's record of every attempt (A2.4, A2.5):
 *
 *   <out>/attempts/<attemptId>/attempt.json   — written BEFORE the attempt runs
 *   <out>/attempts/<attemptId>/outcome.json   — written when it ends, void or not
 *   <out>/attempts/<attemptId>/record.json, stream.jsonl — attempt.ts's §6 record
 *   <out>/voids.jsonl                         — one line per void attempt
 *
 * The attempt id is opaque; the slot, arm and attempt number live in these
 * files, which sit in the results dir — never in a path the agent sees.
 *
 * START IS ATOMIC. attempt.json is written into a dot-named staging dir that
 * is then renamed into place, so every directory `loadAttempts` sees has its
 * attempt.json: a sweep killed mid-start leaves only a staging dir (ignored —
 * that attempt never ran), and a sweep killed mid-run leaves an attempt with
 * no outcome, which the ledger counts as a void (sweep.ts).
 *
 * Read back through zod: a file that does not parse is refused loudly rather
 * than skipped, except a torn outcome.json, which reads as "never finished"
 * — the strict direction, since that counts it as a void.
 */
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { AttemptFacts } from "./attempt.ts";
import { CRITERIA, VOID_REASONS } from "./detect.ts";
import { ArmSchema } from "./manifest-doc.ts";
import type { RunOutcome } from "./report.ts";
import type { AttemptRecord, StoredAttempt } from "./sweep.ts";

export const ATTEMPTS_DIR = "attempts";
const ATTEMPT_FILE = "attempt.json";
const OUTCOME_FILE = "outcome.json";
const VOID_LOG = "voids.jsonl";
/** Prefix of a staging dir that is not (yet) an attempt. */
const STAGING_PREFIX = ".";

const AttemptRecordSchema = z.object({
  attemptId: z.string().min(1),
  slotIndex: z.number().int().nonnegative(),
  arm: ArmSchema,
  attempt: z.number().int().positive(),
  workRoot: z.string(),
  startedAt: z.string(),
});

const HitSchema = z.object({
  id: z.enum(CRITERIA),
  label: z.enum(["complied", "echoed"]),
  matched: z.string(),
});

const OutcomeSchema = z.looseObject({
  slotIndex: z.number().int().nonnegative(),
  arm: ArmSchema,
  attemptId: z.string(),
  attempt: z.number().int().positive(),
  token: z.string(),
  hits: z.array(HitSchema),
  voids: z.array(z.enum(VOID_REASONS)),
  taskSucceeded: z.boolean(),
  toolCallCount: z.number(),
  turns: z.number().nullable(),
  durationMs: z.number().nullable(),
  costUsd: z.number().nullable(),
  filesRead: z.array(z.string()),
  filesWritten: z.array(z.string()),
  filesEdited: z.array(z.string()),
  bashCommands: z.array(z.string()),
  toolNames: z.array(z.string()),
  todoItems: z.array(z.string()),
  claudeVersion: z.string(),
});

export const attemptDir = (outDir: string, attemptId: string): string =>
  join(outDir, ATTEMPTS_DIR, attemptId);

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

/** Records that an attempt is starting; returns its results dir. */
export const startAttempt = async (outDir: string, record: AttemptRecord): Promise<string> => {
  const staging = join(outDir, ATTEMPTS_DIR, `${STAGING_PREFIX}${record.attemptId}`);
  const final = attemptDir(outDir, record.attemptId);
  await mkdir(staging, { recursive: true });
  await writeJson(join(staging, ATTEMPT_FILE), record);
  await rename(staging, final);
  return final;
};

/** Writes the attempt's outcome, with the facts a reviewer needs beside it. */
export const finishAttempt = async (outDir: string, facts: AttemptFacts): Promise<void> => {
  await writeJson(join(attemptDir(outDir, facts.outcome.attemptId), OUTCOME_FILE), {
    ...facts.outcome,
    timedOut: facts.timedOut,
    error: facts.error ?? null,
  });
};

const readOutcome = async (dir: string): Promise<RunOutcome | null> => {
  try {
    const parsed = OutcomeSchema.safeParse(JSON.parse(await readFile(join(dir, OUTCOME_FILE), "utf8")));
    return parsed.success ? (parsed.data as RunOutcome) : null;
  } catch {
    // Missing or torn: the attempt never finished — the ledger voids it.
    return null;
  }
};

const readRecord = async (dir: string): Promise<AttemptRecord> => {
  const raw = await readFile(join(dir, ATTEMPT_FILE), "utf8");
  const parsed = AttemptRecordSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`${join(dir, ATTEMPT_FILE)} is not an attempt record: ${parsed.error.message}`);
  }
  return parsed.data;
};

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/** Every attempt in the results dir; none when the dir has no attempts yet. */
export const loadAttempts = async (outDir: string): Promise<readonly StoredAttempt[]> => {
  let names: string[];
  try {
    names = await readdir(join(outDir, ATTEMPTS_DIR));
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const dirs = names.filter((name) => !name.startsWith(STAGING_PREFIX));
  return Promise.all(
    dirs.map(async (name) => {
      const dir = join(outDir, ATTEMPTS_DIR, name);
      return { record: await readRecord(dir), outcome: await readOutcome(dir) };
    }),
  );
};

export interface VoidLogEntry {
  readonly attemptId: string;
  readonly slotIndex: number;
  readonly arm: RunOutcome["arm"];
  readonly attempt: number;
  readonly voids: RunOutcome["voids"];
  readonly error: string | null;
  /** ISO-8601. */
  readonly at: string;
}

/** Appends one void attempt to voids.jsonl. A failure is thrown, never swallowed. */
export const appendVoidLog = async (outDir: string, entry: VoidLogEntry): Promise<void> => {
  await appendFile(join(outDir, VOID_LOG), `${JSON.stringify(entry)}\n`, "utf8");
};
