/**
 * HUMAN PROVENANCE, as doctor lines (0.11 §6, §9). One GET of
 * /api/confirm/status; every word below is doctor's own, and the hub's RP IDs
 * pass through the untrusted-text class.
 *
 *   - human confirmation: WARN when no passkey can confirm anything on this
 *     hub (no secure origin), or only from the hub's own machine — the
 *     figures stay empty and doctor says why, never as if nobody had judged;
 *   - passkeys: WARN when the caller has none, or none at an RP this hub
 *     accepts (the RP-ID policy: moving addresses is a re-enrolment);
 *   - drafts: WARN while drafts wait — they count for nothing until confirmed.
 *
 * An older hub answers 404 and gets one PASS line saying it predates this; a
 * hub that cannot be read gets a WARN, never a PASS.
 */
import type { HubResult } from "@crosscheck/connector-core/http/client.ts";
import { CONFIRM_NOT_SERVED_STATUS } from "@crosscheck/connector-core/http/confirm.ts";
import type { ConfirmStatus } from "@crosscheck/connector-core/http/confirm.ts";

import { confirmabilityLine, passkeyLine, pendingLine } from "./confirm.ts";
import type { Check } from "./doctor.ts";

const NAME = "human confirmation";

export const confirmChecks = (result: HubResult<ConfirmStatus>, hubUrl: string): readonly Check[] => {
  if (!result.ok) {
    return result.kind !== "network" && result.status === CONFIRM_NOT_SERVED_STATUS
      ? [{ level: "PASS", name: NAME, detail: "this hub predates human confirmation: what a key records counts at once, unproven — upgrade the hub" }]
      : [{ level: "WARN", name: NAME, detail: "could not read whether your drafts can be confirmed here" }];
  }
  const status = result.data;
  const confirmability = confirmabilityLine(status);
  const passkey = passkeyLine(status, hubUrl);
  return [
    confirmability === null
      ? { level: "PASS", name: NAME, detail: "a passkey can confirm your drafts at this hub's https address" }
      : { level: "WARN", name: NAME, detail: confirmability },
    ...(passkey === null ? [] : [{ level: "WARN" as const, name: "confirming passkey", detail: passkey }]),
    status.pending === 0
      ? { level: "PASS", name: "drafts", detail: "nothing waits for your passkey" }
      : { level: "WARN", name: "drafts", detail: `${pendingLine(status)} — they count for nothing until you confirm them: crosscheck confirm` },
  ];
};
