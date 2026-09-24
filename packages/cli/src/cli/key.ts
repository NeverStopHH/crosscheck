/**
 * `crosscheck key rotate [--print]` — replace your api key, now.
 *
 * WHY IT EXISTS: `doctor` has long told people to "rotate the key" when a
 * connector older than the fetch shield printed it into debug logs, and the
 * hub offered no way to do it. A rotation kills the old key at once — for
 * the API and for every web session opened with it — so this command also
 * does the half a person would get wrong by hand: it writes the new key into
 * the stored config and proves it works before saying "done". With a stored
 * key, running sessions need no restart: hooks and the MCP server read the
 * config on every call, and the ACP proxy re-reads it on the first refusal.
 * A key from `CROSSCHECK_API_KEY` is read once, when a process starts, so
 * every process holding the old value needs a restart — the output says so.
 *
 * A PERSON AT A TERMINAL, like `pin` and `noise`: an agent that could run
 * this could print a live key into its own transcript.
 *
 * WHEN THE KEY COMES FROM THE ENVIRONMENT (`CROSSCHECK_API_KEY`), this
 * command cannot update where it lives, and a silent rotation would leave
 * that variable holding a dead key. So it refuses, unless `--print` asks for
 * the new key on the terminal to put there by hand.
 *
 * ONE HUB PER KEY: a stored key is sent only to the hub it was stored for. A
 * `CROSSCHECK_HUB_URL` naming another hub is refused rather than trusted —
 * that hub would receive the key, and whatever it answered would be saved.
 *
 * AN UNREADABLE ANSWER IS NOT A REFUSAL. The hub commits the rotation before
 * it answers, so a lost or mangled answer (a timeout, a proxy page) can mean
 * the old key is already dead. Those cases never say "nothing was rotated".
 */
import { EXIT_FAIL, EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";
import { hubOrigin, readStoredConfig, saveConfig } from "@crosscheck/connector-core/config/config.ts";
import type { Config } from "@crosscheck/connector-core/config/config.ts";
import { configPath, crosscheckHome } from "@crosscheck/connector-core/config/paths.ts";
import type { Env } from "@crosscheck/connector-core/config/paths.ts";
import { rotateOwnKey } from "@crosscheck/connector-core/http/keys.ts";
import { getPrivacySettings } from "@crosscheck/connector-core/http/hub.ts";
import type { HubContext, HubResult } from "@crosscheck/connector-core/http/client.ts";

import { defaultInteractiveProbe } from "./pin.ts";
import type { InteractiveProbe } from "./pin.ts";
import type { CliResult } from "./login.ts";

export const KEY_FLAG_PRINT = "--print";

export const KEY_USAGE = [
  "usage: crosscheck key rotate [--print]",
  "",
  "  Replaces your api key on the hub. The old key stops working at once —",
  "  for your agents and for any web session opened with it. The new key is",
  "  saved to your crosscheck config and checked before this says done;",
  "  running sessions pick it up by themselves.",
  "",
  "  --print  also show the new key once (for another machine, or when your",
  "           key comes from CROSSCHECK_API_KEY, which this cannot update).",
  "",
].join("\n");

const result = (stdout: string, exitCode: number): CliResult => ({ stdout: `${stdout}\n`, exitCode });

const AGENT_REFUSAL = [
  "rotating a key needs a person at a terminal, and this process has none.",
  "",
  "An agent that could run this could print a live key into its own transcript.",
  "Run `crosscheck key rotate` yourself, in a terminal.",
].join("\n");

const REQUEST_TIMEOUT_MS = 8000;

const HTTP_CONFLICT = 409;
const HTTP_UNAUTHORIZED = 401;

/** Said whenever the hub may have committed a rotation this could not read. */
const MAYBE_ROTATED =
  "If the hub received the request, your old key may already be dead: run `crosscheck doctor`,\n" +
  "and if it says the hub refuses your key, ask the hub's admin to rotate it for you.";

const ENV_KEY_RESTART =
  "Put it into CROSSCHECK_API_KEY wherever you set that variable. Agent sessions and ACP\n" +
  "proxies started with the old value keep sending it until you restart them.";

/** Where the key to rotate comes from, and the hub it belongs to. */
interface KeySource {
  readonly home: string;
  readonly stored: Config | null;
  readonly fromEnv: string | undefined;
  readonly currentKey: string;
  readonly hubUrl: string;
}

type ResolvedSource =
  | { readonly ok: true; readonly source: KeySource }
  | { readonly ok: false; readonly refusal: CliResult };

const refused = (stdout: string): ResolvedSource => ({ ok: false, refusal: result(stdout, EXIT_USAGE) });

/** The key to rotate — or why this machine must not rotate it from here. */
const resolveKeySource = async (env: Env, printKey: boolean): Promise<ResolvedSource> => {
  const home = crosscheckHome(env);
  const stored = await readStoredConfig(home);
  const fromEnv = env["CROSSCHECK_API_KEY"];
  const currentKey = fromEnv ?? stored?.apiKey;
  const hubUrl = env["CROSSCHECK_HUB_URL"] ?? stored?.hubUrl;
  if (currentKey === undefined || hubUrl === undefined) {
    return refused(
      "no api key to rotate here: crosscheck has no stored login and CROSSCHECK_API_KEY is unset.\n" +
        "Log in first with `crosscheck login`.",
    );
  }
  const isStoredKeyForOtherHub =
    fromEnv === undefined &&
    stored !== null &&
    hubOrigin(hubUrl) !== hubOrigin(stored.hubUrl);
  if (isStoredKeyForOtherHub) {
    return refused(
      `CROSSCHECK_HUB_URL points at ${hubUrl}, but your stored key belongs to ${stored.hubUrl}.\n` +
        "Rotating here would send that key to another hub. Unset CROSSCHECK_HUB_URL, or set it\n" +
        "to the hub your key belongs to, and run this again.",
    );
  }
  if (fromEnv !== undefined && !printKey) {
    return refused(
      "your key comes from CROSSCHECK_API_KEY, which this command cannot update — a rotation\n" +
        "would leave that variable holding a key that no longer works.\n" +
        `Run \`crosscheck key rotate ${KEY_FLAG_PRINT}\`, then put the printed key into CROSSCHECK_API_KEY yourself.`,
    );
  }
  return { ok: true, source: { home, stored, fromEnv, currentKey, hubUrl } };
};

/** A rotation that did not come back as a new key. Only a 401 or a 409 is certain. */
const failedRotation = (rotated: Extract<HubResult<unknown>, { ok: false }>): CliResult => {
  if (rotated.kind === "network") {
    return result(`the hub did not answer (${rotated.message}).\n${MAYBE_ROTATED}`, EXIT_UNREACHABLE);
  }
  if (rotated.kind === "http" && rotated.status === HTTP_CONFLICT) {
    return result(
      "this key was rotated by another request a moment ago; that request got the new key.\n" +
        "If you do not have it, ask the hub's admin to rotate your key.",
      EXIT_FAIL,
    );
  }
  if (rotated.kind === "http" && rotated.status === HTTP_UNAUTHORIZED) {
    return result(
      "the hub does not accept this key, so it cannot rotate it. Ask the hub's admin to\n" +
        "issue you a new one.",
      EXIT_FAIL,
    );
  }
  return result(
    `the hub's answer could not be read as a rotation (${rotated.code}: ${rotated.message}).\n${MAYBE_ROTATED}`,
    EXIT_FAIL,
  );
};

/**
 * THE OLD KEY IS ALREADY DEAD when this runs. From here on, losing the new
 * key would lock this developer out, so every failure below prints it.
 */
const reportRotated = async (
  source: KeySource,
  ctx: HubContext,
  newKey: string,
  printKey: boolean,
): Promise<CliResult> => {
  const { home, stored, fromEnv, currentKey } = source;
  const lines: string[] = ["rotated: the old key no longer works, for your agents and any web session."];
  const writesStored = stored !== null && stored.apiKey === currentKey;
  if (writesStored) {
    try {
      await saveConfig(home, { ...stored, apiKey: newKey });
    } catch (error) {
      return result(
        `${lines[0] ?? ""}\nbut the new key could not be saved to ${configPath(home)} ` +
          `(${error instanceof Error ? error.message : String(error)}). Keep it now — it is shown only here:\n  ${newKey}`,
        EXIT_FAIL,
      );
    }
    lines.push(`The new key is saved in ${configPath(home)}; running sessions pick it up by themselves.`);
  }
  const verified = await getPrivacySettings({ ...ctx, apiKey: newKey });
  lines.push(
    verified.ok
      ? "Checked: the hub accepts the new key."
      : `Could not confirm the new key with the hub yet (${verified.message}); run \`crosscheck doctor\`.`,
  );
  if (printKey || !writesStored) {
    lines.push("", "Your new key (shown once):", `  ${newKey}`);
  }
  if (fromEnv !== undefined) {
    lines.push("", ENV_KEY_RESTART);
  }
  lines.push(
    "",
    "Other machines that used the old key need the new one: log in there again with it.",
  );
  return result(lines.join("\n"), EXIT_OK);
};

export const runKey = async (
  argv: readonly string[],
  env: Env,
  _cwd: string,
  isInteractive: InteractiveProbe = defaultInteractiveProbe,
): Promise<CliResult> => {
  const [subcommand, ...rest] = argv;
  const printKey = rest.includes(KEY_FLAG_PRINT);
  const unknown = rest.filter((arg) => arg !== KEY_FLAG_PRINT);
  if (subcommand !== "rotate" || unknown.length > 0) {
    return result(KEY_USAGE, EXIT_USAGE);
  }
  if (!isInteractive()) {
    return result(AGENT_REFUSAL, EXIT_USAGE);
  }
  const resolved = await resolveKeySource(env, printKey);
  if (!resolved.ok) {
    return resolved.refusal;
  }
  const { source } = resolved;
  const ctx: HubContext = {
    hubUrl: source.hubUrl,
    apiKey: source.currentKey,
    timeoutMs: REQUEST_TIMEOUT_MS,
    home: source.home,
    repoKey: "key-rotate",
    now: () => new Date(),
  };
  const rotated = await rotateOwnKey(ctx);
  return rotated.ok ? reportRotated(source, ctx, rotated.data.apiKey, printKey) : failedRotation(rotated);
};
