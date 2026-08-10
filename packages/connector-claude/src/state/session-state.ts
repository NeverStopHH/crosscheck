import { z } from "zod";

import { MAX_SEEN_TARGETS, MAX_TRIPWIRE_ASKED_FILES } from "../constants.ts";
import {
  readJsonOrNull,
  removeFile,
  sessionStatePath,
  writePrivateFile,
} from "../config/paths.ts";

export const SessionStateSchema = z.looseObject({
  claudeSessionId: z.string().min(1),
  crosscheckSessionId: z.string().min(1),
  workContextId: z.string().min(1),
  repoId: z.string().min(1),
  repoRoot: z.string().min(1),
  hubUrl: z.string().min(1),
  developerId: z.string().min(1).nullable().default(null),
  startedAt: z.string().min(1),
  lastHeartbeatAt: z.string().nullable().default(null),
  seenTargets: z.array(z.string().min(1)).default([]),
  /**
   * Hint state that must survive hook process restarts (DESIGN.md §4): the
   * refs already delivered (seen-set dedup + the 5/session cap counts this),
   * the normalized-body hashes of delivered substance (echo-loop exclusion,
   * §3), and the files the tripwire already asked about (ask once). Defaults
   * keep every pre-hints state file parsing unchanged.
   */
  deliveredHintRefs: z.array(z.string().min(1)).default([]),
  deliveredHintHashes: z.array(z.string().min(1)).default([]),
  tripwireAskedFiles: z.array(z.string().min(1)).default([]),
});

export type SessionState = z.infer<typeof SessionStateSchema>;

/**
 * What a WRITER may pass: the defaulted fields are optional, exactly as they
 * are for a state file already on disk from before they existed. Readers
 * always see the full SessionState — readSessionState parses through the
 * schema, which fills the defaults.
 */
export type SessionStateInput = z.input<typeof SessionStateSchema>;

/** Deterministic ids survive a crash: no lookup, no id table, no drift. */
export const crosscheckSessionIdFor = (claudeSessionId: string): string =>
  `cc_${claudeSessionId}`;

export const workContextIdFor = (crosscheckSessionId: string): string =>
  `wc_${crosscheckSessionId}`;

export const readSessionState = async (
  home: string,
  claudeSessionId: string,
): Promise<SessionState | null> => {
  const parsed = SessionStateSchema.safeParse(
    await readJsonOrNull(sessionStatePath(home, claudeSessionId)),
  );
  return parsed.success ? parsed.data : null;
};

export const writeSessionState = async (
  home: string,
  state: SessionStateInput,
): Promise<void> => {
  await writePrivateFile(
    sessionStatePath(home, state.claudeSessionId),
    `${JSON.stringify(state, null, 2)}\n`,
  );
};

export const deleteSessionState = async (
  home: string,
  claudeSessionId: string,
): Promise<void> => {
  await removeFile(sessionStatePath(home, claudeSessionId));
};

/** FIFO cap: the oldest targets fall out, the session never grows unbounded. */
export const withSeenTargets = (
  state: SessionState,
  added: readonly string[],
): SessionState => {
  const merged = [...state.seenTargets, ...added];
  return {
    ...state,
    seenTargets:
      merged.length <= MAX_SEEN_TARGETS
        ? merged
        : merged.slice(merged.length - MAX_SEEN_TARGETS),
  };
};

/**
 * One delivered hint, remembered forever within the session: the ref for the
 * seen-set and the cap, the body hash (substance only — pointers carry no
 * body) for the echo-loop exclusion. No cap on these arrays beyond
 * MAX_HINTS_PER_SESSION itself, which the selector enforces before any append.
 */
export const withDeliveredHint = (
  state: SessionState,
  refId: string,
  bodyHash: string | null,
): SessionState => ({
  ...state,
  deliveredHintRefs: [...state.deliveredHintRefs, refId],
  deliveredHintHashes:
    bodyHash === null
      ? state.deliveredHintHashes
      : [...state.deliveredHintHashes, bodyHash],
});

/** FIFO cap, same shape as withSeenTargets: asks are once per file. */
export const withTripwireAsked = (
  state: SessionState,
  file: string,
): SessionState => {
  const merged = [...state.tripwireAskedFiles, file];
  return {
    ...state,
    tripwireAskedFiles:
      merged.length <= MAX_TRIPWIRE_ASKED_FILES
        ? merged
        : merged.slice(merged.length - MAX_TRIPWIRE_ASKED_FILES),
  };
};

export interface DeriveSessionStateInput {
  readonly claudeSessionId: string;
  readonly repoId: string;
  readonly repoRoot: string;
  readonly hubUrl: string;
  readonly developerId: string | null;
  readonly startedAt: string;
}

/**
 * Fallback for hooks that run without a state file (crash, or hooks installed
 * mid-session). The deterministic ids make this identical to what SessionStart
 * would have written.
 */
export const deriveSessionState = (
  input: DeriveSessionStateInput,
): SessionState => {
  const crosscheckSessionId = crosscheckSessionIdFor(input.claudeSessionId);
  return {
    claudeSessionId: input.claudeSessionId,
    crosscheckSessionId,
    workContextId: workContextIdFor(crosscheckSessionId),
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    hubUrl: input.hubUrl,
    developerId: input.developerId,
    startedAt: input.startedAt,
    lastHeartbeatAt: null,
    seenTargets: [],
    deliveredHintRefs: [],
    deliveredHintHashes: [],
    tripwireAskedFiles: [],
  };
};
