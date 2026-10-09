/**
 * A REPO CONNECTED TO ANOTHER HUB, said to the person (core
 * config/key-binding.ts). `doctor`, `status` and `conference` print the same
 * sentences: both origins, what was refused, the fix, and — from the local
 * ledger (core state/foreign-hub.ts) — how many hook events, tool calls and
 * proxy sessions captured nothing because of it. Never the key itself, and
 * no request: the surfaces that print this ask no hub at all.
 *
 * The repo-named origin IS text the repo chose, but only after `new URL`
 * reduced it to an origin — scheme, a host in the URL host alphabet
 * (punycode for anything else), a port — and the ledger keeps only origins
 * that are already canonical (core state/foreign-hub.ts). No newline, space
 * or instruction-shaped text survives that, so it is printed as is.
 */
import { FOREIGN_HUB_MAX_NAMED } from "@crosscheck/connector-core/constants.ts";
import { foreignHubFix, foreignHubWhy } from "@crosscheck/connector-core/config/key-binding.ts";
import type { ForeignHub } from "@crosscheck/connector-core/config/key-binding.ts";
import { formatForeignHubCount } from "@crosscheck/connector-core/state/foreign-hub.ts";
import type { ForeignHubLedger, ForeignHubRefusals } from "@crosscheck/connector-core/state/foreign-hub.ts";

import type { Check } from "./doctor.ts";

const isSameRefusal = (group: ForeignHubRefusals, repoId: string, foreign: ForeignHub): boolean =>
  group.repoId === repoId && group.hubOrigin === foreign.hubOrigin && group.keyOrigin === foreign.keyOrigin;

/**
 * This repo's own count, for the line beside the live mismatch. A FULL
 * ledger with no line for it has stopped counting, which is not the same as
 * nothing refused — said as such, never as zero.
 */
const countHere = (ledger: ForeignHubLedger, repoId: string, foreign: ForeignHub): string => {
  const group = ledger.groups.find((entry) => isSameRefusal(entry, repoId, foreign));
  if (group !== undefined) {
    return formatForeignHubCount(group, ledger.isFull);
  }
  return ledger.isFull
    ? "not counted — the local refusal ledger is full, so recent refusals were not recorded"
    : "no session has been refused here yet";
};

/** One sentence: what was refused, the fix, and what it cost here. */
export const foreignHubDetail = (
  foreign: ForeignHub,
  ledger: ForeignHubLedger,
  repoId: string | null,
): string => {
  const cost = repoId === null ? "" : ` Captures here: ${countHere(ledger, repoId, foreign)}.`;
  return `${foreignHubWhy(foreign)}. Fix: ${foreignHubFix(foreign)}.${cost}`;
};

/** The lines `status` and `conference` print in place of anything a hub says. */
export const foreignHubLines = (
  foreign: ForeignHub,
  ledger: ForeignHubLedger,
  repoId: string | null,
): readonly string[] => [`WARN key origin: ${foreignHubDetail(foreign, ledger, repoId)}`];

/**
 * OTHER repos on this machine refused inside the window — the bait repo a
 * person opened yesterday, read from a repo that is fine. Null when there is
 * none, so a clean machine prints nothing.
 */
export const otherForeignHubRepos = (
  ledger: ForeignHubLedger,
  repoId: string | null,
): string | null => {
  const others = ledger.groups.filter((group) => group.repoId !== repoId);
  if (others.length === 0) {
    return null;
  }
  const named = others
    .slice(0, FOREIGN_HUB_MAX_NAMED)
    .map((group) => `${group.repoId} names ${group.hubOrigin} (${formatForeignHubCount(group, ledger.isFull)})`);
  const hidden = others.length - named.length;
  const repoCount = new Set(others.map((group) => group.repoId)).size;
  return (
    `${String(repoCount)} other repo${repoCount === 1 ? "" : "s"} on this machine ` +
    `named a hub your key does not belong to, so nothing was sent from them: ${named.join("; ")}` +
    `${hidden > 0 ? `; +${String(hidden)} more` : ""}. Run crosscheck doctor inside one for the fix.`
  );
};

/**
 * `doctor`'s lines: the live mismatch here (a WARN — nothing is broken, the
 * key is safe, and the fix is a config edit), and the other repos on this
 * machine that were refused inside the window. A healthy machine gets none.
 */
export const keyOriginChecks = (
  foreign: ForeignHub | null,
  ledger: ForeignHubLedger,
  repoId: string | null,
): readonly Check[] => {
  const here: readonly Check[] =
    foreign === null
      ? []
      : [{ level: "WARN", name: "key origin", detail: foreignHubDetail(foreign, ledger, repoId) }];
  const elsewhere = otherForeignHubRepos(ledger, repoId);
  return elsewhere === null
    ? here
    : [...here, { level: "WARN", name: "key origin elsewhere", detail: elsewhere }];
};

/** The MCP line where the tools would only answer that this repo is refused. */
export const FOREIGN_HUB_MCP_CHECK: Check = {
  level: "WARN",
  name: "mcp tools usable",
  detail:
    "every tool call answers that this repo is connected to another hub than your key's, and " +
    "sends nothing — see the key origin line above",
};
