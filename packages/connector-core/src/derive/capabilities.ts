/**
 * WHAT THIS CONNECTOR CAN INFER, DECLARED — the shape every connector exports
 * so `doctor` can answer the only question a developer actually asks when
 * nothing shows up: "is crosscheck deriving anything for ME, and if not,
 * why not?"
 *
 * THE PRIOR ART AND THE DELIBERATE DIFFERENCE. LSP, MCP and ACP all declare
 * capabilities at initialize and treat an absent one as graceful degradation
 * rather than an error — ACP's initialize carries agentCapabilities and
 * "editors adapt their UI accordingly". We adopt declare-then-degrade and
 * differ in two ways on purpose:
 *
 *   1. NEGOTIATION IS LOCAL. The manifest is static per connector and the
 *      machine probe is separate; there is no hub round trip, because the
 *      host that most needs diagnosing is the one that cannot reach a hub.
 *   2. AN ABSENT CAPABILITY IS A SENTENCE, NOT AN OMITTED FIELD. Our reader
 *      is a person asking why their Cursor is quiet, not a program
 *      intersecting feature sets — and an omitted field is precisely the
 *      silent absence rule 4 forbids. So `off` is a PASS line that SAYS it is
 *      off and says why, in the same words for everyone.
 *
 * THE RUNGS mean exactly this, and nothing looser:
 *   full     — the capability runs here with the same inputs Claude gives it.
 *   reduced  — it runs, on a poorer input this platform can actually supply;
 *              the sentence must say what is poorer about it.
 *   off      — it does not run on this platform, and the sentence says what
 *              in the platform makes that true. Never a silent absence, and
 *              never a pretend implementation.
 *
 * REFUSALS are the rungs' other half: a thing this product deliberately does
 * NOT do on this platform, with the platform reason. They are separate from
 * the capabilities because they are not degraded versions of anything — they
 * are decisions, and a decision nobody can find is indistinguishable from a
 * bug nobody fixed.
 */

export type DeriveRung = "full" | "reduced" | "off";

/** The four things a connector can be asked to make a model do. */
export const DERIVE_CAPABILITIES = [
  "intent",
  "ghost",
  "summarizer",
  "conference",
] as const;

export type DeriveCapabilityName = (typeof DERIVE_CAPABILITIES)[number];

export interface DeriveCapability {
  readonly name: DeriveCapabilityName;
  readonly rung: DeriveRung;
  /**
   * ONE sentence about the PLATFORM, not about crosscheck's plans. It is
   * printed verbatim to a human, so it names the host mechanism that decides
   * the rung — "Cursor's stop payload carries a transcript pointer" — and
   * never a roadmap.
   */
  readonly sentence: string;
}

export interface DeriveRefusal {
  /** The doctor line's name, e.g. "pre-edit ask". */
  readonly name: string;
  /** The whole refusal in one sentence, platform reason included. */
  readonly sentence: string;
}

export interface DeriveCapabilityManifest {
  /** The agent kind this connector reports as — the doctor line's suffix. */
  readonly connector: string;
  readonly capabilities: readonly DeriveCapability[];
  readonly refusals: readonly DeriveRefusal[];
}

/** Lookup that cannot silently miss: an undeclared capability is a bug. */
export const rungOf = (
  manifest: DeriveCapabilityManifest,
  name: DeriveCapabilityName,
): DeriveRung =>
  manifest.capabilities.find((entry) => entry.name === name)?.rung ?? "off";
