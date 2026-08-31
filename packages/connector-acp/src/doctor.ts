/**
 * THE DOCTOR'S ACP SECTION: what crosscheck infers behind the proxy, and what
 * it deliberately does not, one sentence each from the static manifest
 * (capabilities.ts).
 *
 * The refusals are the half that is easy to skip and the half rule 4 is
 * about: a thing this product decided NOT to do on this wire, printed in
 * words, so nobody has to reverse-engineer a silence. They are PASS lines —
 * a refusal is a decision working, not a fault — and every one of them names
 * the protocol reason.
 *
 * "NOT USED HERE" IS ONE PASS LINE AND NOTHING ELSE. The Cursor section's
 * lesson, applied to a connector with no install artifact at all: the proxy is
 * a command a developer wraps their agent in, so there is no hooks file to
 * look for. The evidence that it has been used is the proxy's own — a log
 * under the crosscheck home, or a live session whose host key carries the
 * `acp-` prefix. Before either exists there is nothing true to say about THIS
 * machine, and eight capability lines for a connector nobody here runs is how
 * doctor gets ignored (the absence-check lesson).
 *
 * A capability WARNs only when an ACP SESSION on this machine booked something
 * against it. The filter matters: a Claude session's failed summarizer fire
 * must never light up the ACP rung, or the line stops meaning anything.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { summarizeStateCosts } from "@crosscheck/connector-core/derive/summarizer/cost.ts";
import { bareSummarizerLine } from "@crosscheck/connector-core/model/runner.ts";
import { ACP_HOST_KEY_PREFIX } from "@crosscheck/connector-core/state/host-session-key.ts";
import type { SessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { ACP_CAPABILITY_MANIFEST } from "./capabilities.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import {
  deriveBackendSentence,
  resolveDeriveBackend,
} from "@crosscheck/connector-core/model/backend.ts";
import { ACP_LOG_DIR_NAME } from "./constants.ts";

/** Structurally the Claude doctor's Check — no cross-package type import. */
export interface AcpCheck {
  readonly level: "PASS" | "WARN" | "FAIL";
  readonly name: string;
  readonly detail: string;
}

const check = (
  level: AcpCheck["level"],
  name: string,
  detail: string,
): AcpCheck => ({ level, name, detail });

/** `acp-<pid>.log` and its one rotated generation (logger.ts owns the shape). */
const ACP_LOG_PATTERN = /^acp-\d+\.log(\.1)?$/;

/**
 * Has an ACP proxy run for this home? Two independent signals, because each
 * one alone is wrong in a way the other covers: logs are swept after
 * ACP_LOG_MAX_AGE_DAYS (a developer who used the proxy last month has none),
 * and a session state exists only while a session is live. Either is enough,
 * and neither reads a byte of content.
 */
export const acpUsedHere = async (
  home: string,
  liveStates: readonly SessionState[],
): Promise<boolean> => {
  if (
    liveStates.some((state) =>
      state.hostSessionKey.startsWith(ACP_HOST_KEY_PREFIX),
    )
  ) {
    return true;
  }
  try {
    const names = await readdir(join(home, ACP_LOG_DIR_NAME));
    return names.some((name) => ACP_LOG_PATTERN.test(name));
  } catch {
    return false;
  }
};

/**
 * ONE capability line's detail. §4.4 SURFACE: the head is renderer-owned
 * literal (the rung and the manifest's platform sentence, capabilities.ts),
 * and the tail is NOT — `lastFailure` is whatever the model binary printed
 * when a fire was lost, read back out of a session-state file and printed
 * into a terminal, and through a Bash `crosscheck doctor` into an agent's
 * context. It goes through `bareSummarizerLine`, the one door from model
 * stdout to a rendered line, for the same reason its Cursor sibling does: a
 * state file is a file, and a doctor line that trusts one is one hostile
 * write away from carrying whatever is in it.
 */
export const acpCapabilityDetail = (input: {
  readonly rung: string;
  readonly sentence: string;
  readonly failures: number;
  readonly lastFailure: string | null;
  /**
   * One extra fact this machine knows about the rung, already in crosscheck's
   * own words and printed whether or not anything failed — for the outcomes
   * that are a LOSS rather than a fault and so move no failure counter.
   */
  readonly note?: string | null;
}): string => {
  const note =
    input.note === undefined || input.note === null ? "" : `; ${input.note}`;
  const head = `${input.rung} — ${input.sentence}${note}`;
  if (input.failures === 0) {
    return head;
  }
  const said =
    input.lastFailure === null ? "" : bareSummarizerLine(input.lastFailure);
  return (
    `${head}; ${String(input.failures)} fire${input.failures === 1 ? "" : "s"} booked a failure` +
    (said.length === 0 ? "" : `, last "${said}"`) +
    " — see the summarizer runner check (counts are per live session and clear when the session ends)"
  );
};

/**
 * WHAT THE TURN SLICE CAP REFUSED, in words — the fourth derive outcome, and
 * the one that used to reach only the proxy's own per-pid log file.
 *
 * A PASS-level fact and never a WARN: the model ran, the outcome it booked is
 * real, and a chatty turn is not a fault anybody can fix. What the sentence
 * has to carry is the CONSEQUENCE — the gate judged a truncated turn — so a
 * reader who sees NONEs on turns that plainly concluded has somewhere to
 * look. Counts only; the refused characters are the agent's own prose and
 * never enter a state file, let alone a terminal.
 */
const sliceCapNote = (acpStates: readonly SessionState[]): string | null => {
  const dropped = acpStates.reduce(
    (total, state) => total + state.summarizerSliceDroppedChars,
    0,
  );
  return dropped === 0
    ? null
    : `${String(dropped)} characters of this session's turns were refused by the turn slice cap, so a conclusion may have arrived past it and the gate judged a truncated turn`;
};

const capabilityChecks = (
  acpStates: readonly SessionState[],
): readonly AcpCheck[] => {
  const summarizer = summarizeStateCosts(acpStates);
  const sum = (pick: (state: SessionState) => number): number =>
    acpStates.reduce((total, state) => total + pick(state), 0);
  const last = (pick: (state: SessionState) => string | null): string | null =>
    acpStates.reduce<string | null>(
      (carried, state) => pick(state) ?? carried,
      null,
    );
  const booked: Readonly<
    Record<string, { readonly count: number; readonly last: string | null }>
  > = {
    intent: {
      count: sum((state) => state.intentFailCount),
      last: last((state) => state.intentLastFailure ?? null),
    },
    ghost: {
      count: sum((state) => state.ghostFailCount),
      last: last((state) => state.ghostLastFailure ?? null),
    },
    summarizer: { count: summarizer.fails, last: summarizer.lastFailure },
    // A human's command: this machine books nothing against it per session.
    conference: { count: 0, last: null },
  };
  return ACP_CAPABILITY_MANIFEST.capabilities.map((capability) => {
    const outcome = booked[capability.name] ?? { count: 0, last: null };
    return check(
      outcome.count === 0 ? "PASS" : "WARN",
      `${capability.name} (acp)`,
      acpCapabilityDetail({
        rung: capability.rung,
        sentence: capability.sentence,
        failures: outcome.count,
        lastFailure: outcome.last,
        note:
          capability.name === "summarizer" ? sliceCapNote(acpStates) : null,
      }),
    );
  });
};

/** The refusals, always printed once the proxy is in use here. */
const refusalChecks = (): readonly AcpCheck[] =>
  ACP_CAPABILITY_MANIFEST.refusals.map((refusal) =>
    check("PASS", `${refusal.name} (acp)`, refusal.sentence),
  );

/**
 * CAN THIS MACHINE RUN A MODEL AT ALL — the Cursor line's twin, and for the
 * same reason: every ACP rung ends in the same spawned argv, so a machine
 * with no `claude` and no override derives nothing here however healthy the
 * proxy is. Only rendered once the proxy has actually run here, because a
 * host nobody uses has nothing to derive and does not need the warning.
 */
const backendCheck = (env: Env | undefined): AcpCheck => {
  const backend = resolveDeriveBackend(env ?? {});
  return check(
    backend.kind === "absent" ? "WARN" : "PASS",
    "derive backend (acp)",
    deriveBackendSentence(backend),
  );
};

export interface AcpDoctorInput {
  readonly home: string;
  /**
   * The environment doctor itself runs in — the one whose PATH decides
   * whether a spawned model can start at all. Optional so a caller that only
   * wants the refusals need not have one; absent reads as "no PATH", which
   * resolves to no backend, which is the honest answer for an empty env.
   */
  readonly env?: Env;
  /**
   * The doctor's ONE scan of the session directory, shared with every other
   * derive figure it prints. Filtered to ACP sessions here.
   */
  readonly liveStates: readonly SessionState[];
}

export const acpDoctorChecks = async (
  input: AcpDoctorInput,
): Promise<readonly AcpCheck[]> => {
  const acpStates = input.liveStates.filter((state) =>
    state.hostSessionKey.startsWith(ACP_HOST_KEY_PREFIX),
  );
  if (!(await acpUsedHere(input.home, input.liveStates))) {
    return [
      check(
        "PASS",
        "acp proxy",
        "not used here — `crosscheck acp -- <agent cmd>` wraps any ACP agent, and its derive rungs print here once one has run",
      ),
    ];
  }
  return [
    backendCheck(input.env),
    ...capabilityChecks(acpStates),
    ...refusalChecks(),
  ];
};
