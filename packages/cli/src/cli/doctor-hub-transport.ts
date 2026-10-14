/**
 * HOW THE HUB IS REACHABLE, as doctor WARNs with their fixes (hub hardening,
 * review M7 and H6). The hub reports two flags on GET /api/hub-status
 * (`transport`); every word below is doctor's own. An older hub sends no
 * block, and then there is no line: doctor says nothing it was not told.
 *
 *   - hub listen: CROSSCHECK_LISTEN is unset on a data dir older than the
 *     setting, so the hub kept 0.10's every-interface listen, reachable from
 *     any network its machine joins over plain http;
 *   - passkey origins: a localhost origin listed beside an https one, which
 *     the hub refuses anyway, and which a person may still be enrolling at.
 */
import type { HubResult } from "@crosscheck/connector-core/http/client.ts";
import type { HubStatus } from "@crosscheck/connector-core/http/hub.ts";

import type { Check } from "./doctor.ts";

export const HUB_LISTEN_WARNING =
  "the hub listens on every network interface over plain http (CROSSCHECK_LISTEN is unset on a data dir " +
  "older than the setting); on the hub's machine set CROSSCHECK_LISTEN=127.0.0.1,<its tailnet IP> " +
  "(`tailscale ip -4`), or CROSSCHECK_LISTEN=127.0.0.1 behind `tailscale serve`, and restart the hub";

export const PASSKEY_ORIGINS_WARNING =
  "the hub lists a localhost passkey origin beside an https one and refuses passkeys at localhost there; " +
  "drop localhost from CROSSCHECK_WEBAUTHN_ORIGINS, restart the hub, and enrol passkeys at the https address";

/** The transport WARNs a hub's status asks for; none from an older hub or a failed read. */
export const hubTransportChecks = (result: HubResult<HubStatus>): readonly Check[] => {
  const transport = result.ok ? result.data.transport : undefined;
  if (transport === undefined) {
    return [];
  }
  return [
    ...(transport.listensOnEveryInterface
      ? [{ level: "WARN" as const, name: "hub listen", detail: HUB_LISTEN_WARNING }]
      : []),
    ...(transport.localhostBesideHttps
      ? [{ level: "WARN" as const, name: "passkey origins", detail: PASSKEY_ORIGINS_WARNING }]
      : []),
  ];
};
