/**
 * `crosscheck confirm` — the way to the one page where your drafts become
 * yours (human provenance §6). Your agent and your terminal only DRAFT labels,
 * ratings, pins and settings; nothing counts as your judgement, protects
 * anything or changes a setting until you confirm it there with your passkey.
 *
 * WHAT THIS PRINTS IS COUNTS AND THE URL, NEVER A DRAFT'S CONTENT: the content
 * is read on the hub's own page, in your browser, where an agent cannot sign
 * for you. The URL is built from your configured hub url and a fixed path,
 * never from text the hub sent (04a §11.2).
 *
 * It opens the page in your browser when it can. An agent running this opens
 * a page on your screen; it still cannot touch your passkey.
 */
import { EXIT_FAIL, EXIT_OK, EXIT_UNREACHABLE } from "@crosscheck/connector-core/constants.ts";
import { loadConfig } from "@crosscheck/connector-core/config/config.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { resolveRepoIdentity } from "@crosscheck/connector-core/git/repo-identity.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import {
  CONFIRM_NOT_SERVED_STATUS,
  confirmPageUrl,
  getConfirmStatus,
} from "@crosscheck/connector-core/http/confirm.ts";
import type { ConfirmStatus } from "@crosscheck/connector-core/http/confirm.ts";

import type { CliResult } from "./login.ts";

export const CONFIRM_USAGE = [
  "usage: crosscheck confirm",
  "",
  "  open the page where your drafts become yours: what your agent and your",
  "  terminal recorded counts for nothing until you confirm it with your passkey",
  "",
].join("\n");

/** Opens a URL in the person's browser; false when it could not. Injected, so no test opens one. */
export type UrlOpener = (url: string) => Promise<boolean>;

const BROWSER_COMMAND: Readonly<Record<string, string>> = { darwin: "open", linux: "xdg-open" };

export const defaultUrlOpener: UrlOpener = async (url) => {
  const command = BROWSER_COMMAND[process.platform];
  if (command === undefined) {
    return false;
  }
  try {
    const child = Bun.spawn({ cmd: [command, url], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
};

export const CONFIRM_NOT_SERVED_LINE =
  "this hub predates human confirmation: what your agent and your terminal record there counts at once, unproven — upgrade the hub";

export const NO_HTTPS_LINE = "no human-confirmed judgements possible on this hub: set up https";

export const HUB_MACHINE_ONLY_LINE =
  "passkeys work on this hub only from the hub's own machine (localhost): confirm there, or set up https (tailscale serve) to confirm from yours";

const KIND_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  label: ["label", "labels"],
  pin_ok: ["pin still works", "pins still work"],
  outcome: ["rating", "ratings"],
  pin: ["pin", "pins"],
  pin_broke: ["pin broken", "pins broken"],
  mute: ["mute", "mutes"],
  unmute: ["unmute", "unmutes"],
  presence_on: ["presence back on", "presence back on"],
};

const kindWords = (kind: string, count: number): string => {
  const words = KIND_WORDS[kind] ?? [bareUntrusted(kind), bareUntrusted(kind)];
  return `${String(count)} ${count === 1 ? words[0] : words[1]}`;
};

/** How many drafts wait, by kind — or that none do. */
export const pendingLine = (status: ConfirmStatus): string =>
  status.pending === 0
    ? "nothing waits for your passkey"
    : `${String(status.pending)} draft${status.pending === 1 ? "" : "s"} wait for your passkey: ${Object.entries(
        status.pendingByKind,
      )
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => kindWords(kind, count))
        .join(" · ")}`;

/**
 * THE RP-ID POLICY, said plainly (§9): a passkey belongs to the address it was
 * enrolled at, and moving to another one is an explicit re-enrolment, never a
 * silent fallback. Null when the caller has a passkey that can sign here.
 */
export const passkeyLine = (status: ConfirmStatus, hubUrl: string): string | null => {
  const passkeysPage = `${hubUrl.replace(/\/+$/, "")}/ui/passkeys`;
  if (status.passkeys.total === 0) {
    return `you have no passkey yet: enrol one at ${passkeysPage} with a code from the admin; it can confirm your own drafts at once`;
  }
  if (status.passkeys.atConfiguredRp === 0) {
    const rpIds = status.rpIds.map((rpId) => bareUntrusted(rpId)).join(", ");
    return `your passkeys belong to another address than this hub's (${rpIds}), so none of them can confirm here — enrol one at ${passkeysPage} with a code from the admin`;
  }
  return null;
};

/** Where confirming is possible at all; null on a hub with an https origin. */
export const confirmabilityLine = (status: ConfirmStatus): string | null => {
  switch (status.humanConfirmation) {
    case "none":
      return NO_HTTPS_LINE;
    case "hub_machine_only":
      return HUB_MACHINE_ONLY_LINE;
    case "https":
      return null;
  }
};

const confirmContext = async (env: Env, cwd: string) => {
  const identity = await resolveRepoIdentity(cwd);
  const config = await loadConfig({ env, repoRoot: identity?.root });
  return config === null
    ? null
    : {
        hubUrl: config.hubUrl,
        ctx: {
          hubUrl: config.hubUrl,
          apiKey: config.apiKey,
          timeoutMs: config.timeoutMs,
          home: config.home,
          repoKey: "",
          now: () => new Date(),
        },
      };
};

export const runConfirm = async (env: Env, cwd: string, openUrl: UrlOpener = defaultUrlOpener): Promise<CliResult> => {
  const configured = await confirmContext(env, cwd);
  if (configured === null) {
    return { stdout: "not configured — run `crosscheck login <hubUrl>`\n", exitCode: EXIT_FAIL };
  }
  const result = await getConfirmStatus(configured.ctx);
  if (!result.ok) {
    if (result.kind === "network") {
      return { stdout: `hub unreachable: ${bareUntrusted(result.message)}\n`, exitCode: EXIT_UNREACHABLE };
    }
    return result.status === CONFIRM_NOT_SERVED_STATUS
      ? { stdout: `${CONFIRM_NOT_SERVED_LINE}\n`, exitCode: EXIT_FAIL }
      : { stdout: `the hub refused: ${bareUntrusted(result.message)}\n`, exitCode: EXIT_FAIL };
  }
  const status = result.data;
  const url = confirmPageUrl(configured.hubUrl);
  const opened = status.pending > 0 && (await openUrl(url));
  const lines = [
    pendingLine(status),
    confirmabilityLine(status),
    passkeyLine(status, configured.hubUrl),
    status.pending === 0
      ? null
      : `${opened ? "opened" : "open"} ${url} in your browser — one passkey touch confirms exactly what that page shows, and nothing that arrives after it loaded`,
  ].filter((line): line is string => line !== null);
  return { stdout: `${lines.join("\n")}\n`, exitCode: EXIT_OK };
};
