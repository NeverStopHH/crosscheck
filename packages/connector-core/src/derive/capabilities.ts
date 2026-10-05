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

/**
 * What a connector can be asked to do — four model inferences and one thing
 * that is NOT one: `event_seq` asks a host to put every record it emits in the
 * session's own causal order, which is a lock and a counter rather than a
 * model call. It belongs in this list anyway, because the question a reader
 * asks of `doctor` is the same one — "is crosscheck doing this for ME, and if
 * not, why not?" — and because the meta-test that refuses a silent absence is
 * the only mechanism in the tree that can answer it in both directions.
 */
export const DERIVE_CAPABILITIES = [
  "intent",
  "ghost",
  "summarizer",
  "conference",
  "event_seq",
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

/**
 * THE LIMIT THAT BELONGS TO EVERY HOST, PHRASED ONCE AND SHARED BY
 * REFERENCE.
 *
 * Two of the nine canonical kinds — `intent.declared` and `intent.amended`,
 * the two AT-4 is actually about — are not projected into `session_events`.
 * The versioned intent ledger (server services/intent-ledger.ts) positions
 * each version on its own row instead, and both kinds have producers on every
 * host: `set_intent` (MCP) and the derived intent worker. The declaration
 * table (guarantees/declarations.ts) states them `partial /
 * derived_after_the_fact` on all three hosts, and this line says the same —
 * test/derive-capability-registry.test.ts reads the words off the table.
 * (Until 2026-10-02 it said "no host emits" them, from before the ledger
 * landed; decided by Nick, 2026-10-02.)
 *
 * IT IS A FACT ABOUT THE MODEL, NOT ABOUT A HOST, so it is not three
 * sentences. Two manifests once named the kinds nowhere at all — the silent
 * absence rule 2 above forbids — and the third scoped the absence to a
 * NON-DEFAULT flag, which told a default-mode reader the kinds worked for
 * them.
 */
export const UNPROJECTED_LEDGER_KINDS_REFUSAL: DeriveRefusal = {
  name: "intent timing events",
  sentence:
    "`intent.declared` and `intent.amended` are positioned on the intent ledger's own rows, not in the session's events, and on every host they are partial / derived_after_the_fact: `set_intent` positions a version when the agent calls it, but the session picker can withhold that position, and the derived intent worker positions its version when it writes it down, after the turn it describes — which the hub stores as an upper bound, so whether an explanation came before or after the change it excuses is answered only where both positions were emitted",
};

/** Lookup that cannot silently miss: an undeclared capability is a bug. */
export const rungOf = (
  manifest: DeriveCapabilityManifest,
  name: DeriveCapabilityName,
): DeriveRung =>
  manifest.capabilities.find((entry) => entry.name === name)?.rung ?? "off";
