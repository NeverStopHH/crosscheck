/**
 * The Cursor injection composition point (design §3.3) — the sibling of the
 * ACP connector's `inject/blocks.ts`: every character this connector injects
 * into a Cursor conversation passes through `cursorInjectionOutput`, and the
 * content is EXCLUSIVELY the core renderers' output — the briefing from
 * `renderBriefing` (via the `assembleBriefing` flow), the hints from
 * `renderClaimHint`/`renderPointerHint` (via the `selectAndRenderHint`
 * flow) and `renderSolvedHint` (via `selectAndRenderSolvedHint`). §1.4's
 * rule made mechanical: any future Cursor-specific framing text is
 * renderer-owned literal text that must be added HERE, on a registered §4.4
 * surface the corpus attacks — never inline in a handler.
 *
 * THE EMITTED PAYLOAD IS JSON, and that is what the corpus must survive:
 * the hook prints `{"additional_context": "<text>"}` on stdout and Cursor
 * decodes the string back before injecting it. The registered surface
 * adapters below therefore run the REAL encode→decode round trip —
 * renderer → `cursorInjectionOutput` → `deliveredAdditionalContext` — so
 * the corpus attacks exactly what the model would see, and a wrapper that
 * ever mangled the notice or the « » frame in transit turns the §4.4
 * registry red instead of shipping.
 */
import { renderBriefing } from "@crosscheck/connector-core/briefing/render.ts";
import type { BriefingInput } from "@crosscheck/connector-core/briefing/render.ts";
import {
  renderClaimHint,
  renderPointerHint,
  renderSolvedHint,
} from "@crosscheck/connector-core/hints/render.ts";
import type {
  ClaimHintInput,
  PointerHintInput,
} from "@crosscheck/connector-core/hints/render.ts";
import type { SolvedMatchEntry } from "@crosscheck/connector-core/http/hub.ts";

import { CURSOR_ADDITIONAL_CONTEXT_KEY } from "../constants.ts";

/**
 * The one stdout shape an injecting handler may answer: single-line JSON,
 * exactly one documented key, no directives. JSON.stringify is the entire
 * encoding — lossless for every string, which the round-trip surfaces prove
 * on every corpus payload.
 */
export const cursorInjectionOutput = (text: string): string =>
  JSON.stringify({ [CURSOR_ADDITIONAL_CONTEXT_KEY]: text });

/**
 * What Cursor would decode from the emitted stdout JSON — the delivered
 * text. Tolerant like every boundary parser: not JSON, not an object, or a
 * non-string field → "" (nothing was delivered).
 */
export const deliveredAdditionalContext = (stdoutJson: string): string => {
  try {
    const parsed = JSON.parse(stdoutJson) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "";
    }
    const value = (parsed as Record<string, unknown>)[
      CURSOR_ADDITIONAL_CONTEXT_KEY
    ];
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
};

/** The delivered briefing composition, as the §4.4 corpus attacks it. */
export const cursorBriefingContext = (input: BriefingInput): string =>
  deliveredAdditionalContext(cursorInjectionOutput(renderBriefing(input)));

/** The delivered claim-hint composition, as the §4.4 corpus attacks it. */
export const cursorClaimHintContext = (input: ClaimHintInput): string =>
  deliveredAdditionalContext(cursorInjectionOutput(renderClaimHint(input)));

/** The delivered pointer-hint composition, as the §4.4 corpus attacks it. */
export const cursorPointerHintContext = (input: PointerHintInput): string =>
  deliveredAdditionalContext(cursorInjectionOutput(renderPointerHint(input)));

/** The delivered solved-hint composition, as the §4.4 corpus attacks it. */
export const cursorSolvedHintContext = (
  entry: SolvedMatchEntry,
  repoId: string,
  now: Date,
): string =>
  deliveredAdditionalContext(
    cursorInjectionOutput(renderSolvedHint(entry, repoId, now)),
  );
