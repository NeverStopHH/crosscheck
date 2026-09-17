/**
 * THE HISTORY `work_contexts.intent` NEVER HAD, rendered (spec 06 §5).
 *
 * The head is one sentence in one cell, and every re-declaration used to
 * destroy the one before it. This prints the chain: each version, what it
 * supersedes, why, and the paths it named — newest first, so the reader meets
 * the current plan before the ones it replaced.
 *
 * EVERY VERSION GOES THROUGH THE SAME LABEL-CLASS TREATMENT AS THE HEAD, and
 * that is load-bearing rather than tidy. An intent is LABEL class: every
 * surface that shows one blanks it WHOLE when the phrase filter matches, and
 * `set_intent` warns its author that teammates will see a redaction marker
 * instead of their words. A chain renderer that printed N historical summaries
 * some other way would be the BYPASS for the filter guarding the head — so the
 * summaries run through `renderIntent`, the one spelling, and the amendment
 * reasons run through the same span-redacting frame a claim body does.
 *
 * ONE « » PAIR PER LINE. The summary is framed on its own line and the reason
 * on its own line beneath it, because a framed line carrying two pairs is a
 * line a reader cannot tell apart from one pair containing a forged frame.
 *
 * THE POSITIONS ARE NOT HERE AND MUST NOT COME. Whether one version preceded a
 * change is the hub's answer, computed by a ladder whose refusals (an upper
 * bound, two overlapping windows) are the whole point; a renderer comparing
 * two integers would be a second ladder with none of them.
 */
import { MAX_INTENT_AMEND_REASON_CHARS } from "@crosscheck/schema";

import {
  INTENT_CHAIN_MAX_SHOWN,
  MAX_WORK_CONTEXT_TITLE_CHARS,
} from "../constants.ts";
import { renderIntent } from "../briefing/intent.ts";
import { bareUntrusted, spanRedactedUntrusted } from "../briefing/sanitize.ts";
import type { Diagnosis, IntentVersion } from "../http/hub.ts";

/**
 * WHAT AN OLDER HUB LOOKS LIKE, and why it may not look like innocence.
 *
 * An empty chain is what a hub sends for a context nobody ever amended AND
 * what a hub too old to know about the field leaves behind. "This session
 * never amended its intent" is the sentence that makes a stated plan read as
 * the plan all along — an exoneration — so it is only ever printed when a hub
 * actually said so.
 */
export const CHAIN_NOT_REPORTED =
  "Intent history: this hub does not report it, so whether this intent was amended is unknown.";

/**
 * A HUB THAT LOOKED AND DISAGREED WITH ITSELF, which is not the same refusal.
 *
 * The head is a projection of the ledger's newest row, so an intent with zero
 * versions is a hub contradicting its own store. Both this and the sentence
 * above withhold the answer — neither ever exonerates — but they send a reader
 * to different remedies: one says upgrade the hub, this one says the hub's
 * ledger and its head do not agree and that is a defect to report. Collapsing
 * them would be a refusal reported under another defect's reason, which is the
 * rule `session-order.ts` states for its own six indeterminacies.
 */
export const CHAIN_NO_VERSIONS =
  "Intent history: this hub reported none for an intent that exists, so whether it was amended is unknown.";

export const CHAIN_EMPTY = "Intent history: one declaration, never amended.";

const UNPRINTABLE_REASON = "(reason unprintable)";

/**
 * WHAT A VERSION WHOSE SENTENCE DID NOT SURVIVE STILL SAYS.
 *
 * The block's header counts the versions. A version that rendered nothing —
 * a summary of invisibles, a lone frame character — would drop out from under
 * that count, and a reader would meet "3 versions" above two of them. The
 * version that disappeared is exactly the amendment AT-4 asks about, so this
 * is the silent shortening in the one place it exonerates.
 *
 * `UNPRINTABLE_TARGET` (mcp/render.ts:79) is the same rule for a target row,
 * for the same stated reason: a section quietly one row shorter than its own
 * header. The head line may still vanish — nothing counts it.
 */
const UNPRINTABLE_SUMMARY = "intent: (nothing printable in it)";

/** The same rule for a declared path: an entry is made unprintable, never dropped. */
const UNPRINTABLE_PATH = "(a path with nothing printable in it)";

/** A declared path, through the same treatment a target's path gets. */
const scopeValue = (raw: string): string =>
  bareUntrusted(
    spanRedactedUntrusted(raw, MAX_WORK_CONTEXT_TITLE_CHARS),
    MAX_WORK_CONTEXT_TITLE_CHARS,
  );

const scopeLine = (version: IntentVersion): string | null => {
  const scope = version.scope ?? [];
  if (scope.length === 0) {
    return null;
  }
  // AN ENTRY IS NEVER DROPPED, only made unprintable — the silent shortening
  // one level below the version count. A scope list quietly missing the path
  // it could not render tells a reader the session declared fewer paths than
  // it did, and the missing one is a path `explanationTimingFor` compared by
  // equality and the reader never saw.
  const rendered = scope.map((entry) => {
    const value = scopeValue(entry.value);
    const role = entry.role === "non_goal" ? "not" : "expects";
    return `${role} ${value.length === 0 ? UNPRINTABLE_PATH : value}`;
  });
  return `    scope: ${rendered.join(" · ")}`;
};

const versionLines = (version: IntentVersion): readonly string[] => {
  // The SAME spelling the head uses — one place the label can be weakened or
  // the frame lost, and one place the phrase filter blanks a whole sentence.
  const fragment =
    renderIntent({
      summary: version.summary,
      provenance: version.provenance,
    }) ?? UNPRINTABLE_SUMMARY;
  const supersedes =
    version.amendsVersion === null || version.amendsVersion === undefined
      ? "first declaration"
      : `supersedes v${version.amendsVersion}`;
  const reason =
    version.reason === null || version.reason === undefined
      ? null
      : spanRedactedUntrusted(version.reason, MAX_INTENT_AMEND_REASON_CHARS);
  const scope = scopeLine(version);
  return [
    `  v${version.version} · ${supersedes} · ${fragment}`,
    ...(reason === null
      ? []
      : [`    why: ${reason.length === 0 ? UNPRINTABLE_REASON : `«${reason}»`}`]),
    ...(scope === null ? [] : [scope]),
  ];
};

/**
 * The chain block for one diagnosis, the one sentence that says the hub did
 * not answer, or nothing at all when there is no intent to have a history of.
 *
 * THE BLOCK IS GATED ON THE INTENT FIELD, not on whether the head LINE
 * rendered, and the difference is deliberate. A context with no intent has no
 * history of one, so it says nothing — a tree that never declared anything must
 * not be told that nobody amended it. But a context whose intent is present and
 * merely UNPRINTABLE still has a history, and dropping the block there would
 * hide real amendments behind one unrenderable sentence. The head line may
 * vanish on its own; nothing counts it.
 */
export const renderIntentChain = (diagnosis: Diagnosis): readonly string[] => {
  const intent = diagnosis.workContext.intent;
  if (intent === null || intent === undefined) {
    return [];
  }
  if (!diagnosis.chainReported) {
    return [CHAIN_NOT_REPORTED];
  }
  const chain = diagnosis.intentChain;
  if (chain.length === 0) {
    // AN INTENT WITH NO VERSIONS IS A HUB DISAGREEING WITH ITSELF, and it is a
    // DIFFERENT refusal from the one above — the hub answered, and its answer
    // contradicts its own head. Still never the exonerating "never amended".
    return [CHAIN_NO_VERSIONS];
  }
  if (chain.length === 1) {
    return [CHAIN_EMPTY];
  }
  const shown = chain.slice(0, INTENT_CHAIN_MAX_SHOWN);
  const hidden = chain.length - shown.length;
  return [
    `Intent history: ${chain.length} versions, newest first.`,
    ...shown.flatMap(versionLines),
    ...(hidden > 0 ? [`  (+${hidden} earlier versions not shown)`] : []),
  ];
};
