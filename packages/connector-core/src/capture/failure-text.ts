/**
 * Failure-TEXT extraction — a CROSS-CONNECTOR identity function, moved here
 * from `connector-claude/src/capture/tool-events.ts` verbatim (which now
 * re-exports it). The extracted text feeds `fingerprint()`, the cross-agent
 * match signal, so the "string fields joined, tail-sliced" rule must have
 * exactly one spelling: a Claude tool_response `{stderr}` and an ACP
 * `tool_call_update.rawOutput` `{stderr}` carrying the same bytes must
 * fingerprint identically (design §2.4 — "identical normalizer as Claude
 * Code = cross-agent fingerprint matching, which is the product"; pinned by
 * the ACP fingerprint-parity test).
 *
 * What counts as a FAILURE stays host-side (`isFailureResponse` parses
 * Claude's shapes; ACP has explicit `status: "failed"` / exit codes) — only
 * the text derivation is shared.
 */
import { FINGERPRINT_SOURCE_CHARS } from "../constants.ts";

const TEXT_FIELDS = ["stdout", "stderr", "output", "error"] as const;

export const extractFailureText = (toolResponse: unknown): string => {
  if (typeof toolResponse === "string") {
    return toolResponse.slice(-FINGERPRINT_SOURCE_CHARS);
  }
  if (typeof toolResponse !== "object" || toolResponse === null) {
    return "";
  }
  const record = toolResponse as Record<string, unknown>;
  const joined = TEXT_FIELDS.map((field) => record[field])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return joined.slice(-FINGERPRINT_SOURCE_CHARS);
};
