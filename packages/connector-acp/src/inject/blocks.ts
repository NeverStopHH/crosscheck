/**
 * The ACP prompt-block composition point (design §2.5): every character the
 * proxy appends to a `session/prompt` passes through `acpPromptBlockText`,
 * and the content is EXCLUSIVELY the core renderers' output — the briefing
 * from `renderBriefing` (via the `assembleBriefing` flow), the hints from
 * `renderClaimHint`/`renderPointerHint` (via the `selectAndRenderHint`
 * flow). §1.4's rule made mechanical: any future ACP-specific framing text
 * is renderer-owned literal text that must be added HERE, on a registered
 * surface the corpus attacks — never inline in the injector.
 *
 * Today `acpPromptBlockText` is the identity on purpose (open question 2's
 * conservative shape): the briefing and hint renderers already open with a
 * self-identifying header under QUOTED_DATA_NOTICE, so a replayed prompt
 * block stays honest without a second header saying the same thing. The
 * corpus surfaces below exercise the DELIVERED composition — core renderer
 * through the ACP wrapper — so the day the wrapper stops being the identity,
 * every payload attacks the new framing automatically.
 */
import { renderBriefing } from "@crosscheck/connector-core/briefing/render.ts";
import type { BriefingInput } from "@crosscheck/connector-core/briefing/render.ts";
import {
  renderClaimHint,
  renderPointerHint,
} from "@crosscheck/connector-core/hints/render.ts";
import type {
  ClaimHintInput,
  PointerHintInput,
} from "@crosscheck/connector-core/hints/render.ts";

/**
 * The single wrapper between a core-rendered text and the appended prompt
 * block. Identity today — see the header for why that is a decision, not an
 * omission.
 */
export const acpPromptBlockText = (rendered: string): string => rendered;

/** The delivered briefing-block composition, as the corpus attacks it. */
export const acpBriefingBlock = (input: BriefingInput): string =>
  acpPromptBlockText(renderBriefing(input));

/** The delivered claim-hint composition, as the corpus attacks it. */
export const acpClaimHintBlock = (input: ClaimHintInput): string =>
  acpPromptBlockText(renderClaimHint(input));

/** The delivered pointer-hint composition, as the corpus attacks it. */
export const acpPointerHintBlock = (input: PointerHintInput): string =>
  acpPromptBlockText(renderPointerHint(input));
