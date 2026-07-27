import { z } from "zod";

import { MAX_SEEN_TARGETS } from "../constants.ts";
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
});

export type SessionState = z.infer<typeof SessionStateSchema>;

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
  state: SessionState,
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
  };
};
