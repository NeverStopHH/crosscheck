/**
 * `registerSessionFlow` (DESIGN-agent-agnostic.md §1.3) — the session-start
 * recipe as an extracted function: register with `cc_<hostSessionKey>`
 * (+ `~r1`/`~r2` retry on 409) → `writeSessionState` BEFORE any append (reap
 * infers "writer alive" from the state file, so a spool without state is an
 * orphan on sight) → spool the work-context record.
 *
 * EXTRACTED FROM `connector-claude/src/hooks/session-start.ts`, not invented:
 * the hook now calls this, so there is exactly one implementation — the
 * §5 scheduling note's entry step, discharged by Block 4 (the first
 * connector block that needed a flow). Host-specific parsing (payloads,
 * titles from session metadata) stays in each connector; this flow takes the
 * already-resolved values.
 */
import { registerSession } from "../http/hub.ts";
import type { HubContext } from "../http/client.ts";
import { appendRecords } from "../spool/append.ts";
import {
  UNKNOWN_DEVELOPER_ID,
  workContextRecord,
} from "../capture/records.ts";
import {
  crosscheckSessionIdFor,
  workContextIdFor,
  writeSessionState,
} from "../state/session-state.ts";

/** A resumed session whose crosscheck session was closed gets a fresh suffix. */
const RETRY_SUFFIXES = ["", "~r1", "~r2"] as const;

const HTTP_CONFLICT = 409;

const LOCAL_REPO_PREFIX = "local:";

/**
 * Last segment of the shared repo id (`github.com/acme/api` → `api`), never a
 * local directory name: this title is uploaded and read by teammates. A
 * `local:` id has no shareable segment, so the branch alone has to carry it.
 */
const repoLabel = (repoId: string): string | null => {
  if (repoId.startsWith(LOCAL_REPO_PREFIX)) {
    return null;
  }
  const last = repoId.split("/").at(-1)?.trim();
  return last === undefined || last.length === 0 ? null : last;
};

/**
 * The honest work-context title when the host supplied none: branch @ repo,
 * never a fabricated task description — and never derived from prompt text
 * (the Claude connector's fallback and the ACP proxy's only title share this
 * privacy posture, design §2.4).
 */
export const fallbackWorkContextTitle = (
  branch: string,
  repoId: string,
): string => {
  const label = repoLabel(repoId);
  return label === null ? branch : `${branch} @ ${label}`;
};

export interface RegisterSessionFlowInput {
  readonly home: string;
  readonly repoKey: string;
  readonly hub: HubContext;
  readonly agentKind: string;
  /** The host's own id for this session (state/host-session-key.ts). */
  readonly hostSessionKey: string;
  readonly repoId: string;
  readonly repoRoot: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly hubUrl: string;
  /** Used when the hub does not answer (stored config identity). */
  readonly fallbackDeveloperId: string | null;
  readonly title: string;
  readonly status: string;
  readonly now: Date;
}

export interface RegisterSessionFlowResult {
  readonly crosscheckSessionId: string;
  readonly workContextId: string;
  readonly developerId: string | null;
  /** False when the hub never accepted a register — state + spool still exist. */
  readonly registered: boolean;
}

interface Registration {
  readonly sessionId: string;
  readonly developerId: string | null;
}

const registerWithRetry = async (
  input: RegisterSessionFlowInput,
  baseId: string,
): Promise<Registration | null> => {
  for (const suffix of RETRY_SUFFIXES) {
    const sessionId = `${baseId}${suffix}`;
    const result = await registerSession(input.hub, {
      id: sessionId,
      agentKind: input.agentKind,
      repo: input.repoId,
      branch: input.branch,
      baseCommit: input.baseCommit,
      status: input.status,
    });
    if (result.ok) {
      return { sessionId, developerId: result.data.session.developerId };
    }
    if (result.status !== HTTP_CONFLICT) {
      return null;
    }
  }
  return null;
};

/** The session-start recipe: register → state BEFORE append → work context. */
export const registerSessionFlow = async (
  input: RegisterSessionFlowInput,
): Promise<RegisterSessionFlowResult> => {
  const baseSessionId = crosscheckSessionIdFor(input.hostSessionKey);
  const registration = await registerWithRetry(input, baseSessionId);
  const crosscheckSessionId = registration?.sessionId ?? baseSessionId;
  const developerId = registration?.developerId ?? input.fallbackDeveloperId;
  const workContextId = workContextIdFor(crosscheckSessionId);

  // BEFORE the first append, always: `reap` decides that a spool file has no
  // writer left by finding no session state file for it, and that inference
  // is only sound while state is published before any record is written.
  await writeSessionState(input.home, {
    hostSessionKey: input.hostSessionKey,
    crosscheckSessionId,
    workContextId,
    repoId: input.repoId,
    repoRoot: input.repoRoot,
    hubUrl: input.hubUrl,
    developerId,
    startedAt: input.now.toISOString(),
    lastHeartbeatAt: input.now.toISOString(),
    seenTargets: [],
    deliveredHintRefs: [],
    deliveredHintHashes: [],
    tripwireAskedFiles: [],
  });
  await appendRecords(
    input.home,
    input.repoKey,
    input.hostSessionKey,
    [
      workContextRecord(
        {
          workContextId,
          sessionId: crosscheckSessionId,
          title: input.title,
          status: input.status,
        },
        {
          developerId: developerId ?? UNKNOWN_DEVELOPER_ID,
          agentKind: input.agentKind,
          sessionId: crosscheckSessionId,
        },
        input.now,
      ),
    ],
    input.now,
  );
  return {
    crosscheckSessionId,
    workContextId,
    developerId,
    registered: registration !== null,
  };
};
