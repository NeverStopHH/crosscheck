/**
 * A KEY IS BOUND TO THE ORIGIN IT WAS ISSUED FOR (config/key-binding.ts).
 *
 * Unit level, no network: how origins compare, which origin a key is bound to
 * for every way a key can arrive, that CROSSCHECK_HUB_URL overrides only its
 * own key's hub, that a legacy login is bound to its own hub at first read
 * and the binding persisted, and that the pilot's real config shape — one
 * hub, the same tailnet spelling in the login and the repo — keeps reporting.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loadConfig,
  persistLegacyBinding,
  readStoredConfig,
  resolveReportableConfig,
  saveConfig,
} from "../src/config/config.ts";
import {
  foreignHubAgentLine,
  foreignHubFix,
  foreignHubOf,
  foreignHubWhy,
  resolveKeyBinding,
} from "../src/config/key-binding.ts";
import { hubOrigin, isSameOrigin } from "../src/config/origin.ts";
import { makeHome, makeRepo } from "./helpers.ts";

/** The pilot hub's address exactly as the monorepo's committed .crosscheck.json spells it. */
const PILOT_HUB = "http://macbook-pro-von-nick.tailfe410a.ts.net:7100";
/** The same machine by its tailnet IP: a different origin, never folded into the name. */
const PILOT_HUB_BY_IP = "http://100.101.102.103:7100";
const ATTACKER_HUB = "https://hub.attacker.example";
const STORED_KEY = "a".repeat(64);
const ENV_KEY = "b".repeat(64);

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
  cleanups.length = 0;
});

const homeLoggedInTo = async (label: string, hubUrl: string): Promise<string> => {
  const home = await makeHome(label);
  cleanups.push(home);
  await saveConfig(home, { version: 1, hubUrl, apiKey: STORED_KEY });
  return home;
};

const repoNaming = async (label: string, hubUrl: string): Promise<string> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  cleanups.push(repo);
  await writeFile(join(repo, ".crosscheck.json"), `${JSON.stringify({ hubUrl, protocol: "0.1" }, null, 2)}\n`, "utf8");
  return repo;
};

describe("origin normalisation", () => {
  test("scheme and host are lowercased, a default port and a trailing slash dropped", () => {
    // Arrange
    const spellings = [
      "http://hub.example:7100",
      "http://hub.example:7100/",
      "HTTP://Hub.Example:7100",
      "http://hub.example:7100/some/path?q=1",
      "  http://hub.example:7100  ",
    ];

    // Act
    const origins = spellings.map((spelling) => hubOrigin(spelling));

    // Assert
    expect(new Set(origins)).toEqual(new Set(["http://hub.example:7100"]));
    expect(hubOrigin("https://hub.example:443/")).toBe("https://hub.example");
    expect(hubOrigin("http://hub.example:80")).toBe("http://hub.example");
  });

  test("a tailnet name and its IP, http and https, host and host. are different origins", () => {
    // Act + Assert
    expect(isSameOrigin(PILOT_HUB, PILOT_HUB_BY_IP)).toBe(false);
    expect(isSameOrigin("http://hub.example", "https://hub.example")).toBe(false);
    expect(isSameOrigin("http://hub.example", "http://hub.example.")).toBe(false);
    expect(isSameOrigin("http://hub.example:7100", "http://hub.example:7101")).toBe(false);
    expect(isSameOrigin(PILOT_HUB, `${PILOT_HUB}/`)).toBe(true);
  });

  test("user info cannot borrow the trusted host: the origin is the host after the @", () => {
    // Act
    const origin = hubOrigin("http://macbook-pro-von-nick.tailfe410a.ts.net:7100@hub.attacker.example");

    // Assert
    expect(origin).toBe("http://hub.attacker.example");
    expect(isSameOrigin(PILOT_HUB, "http://macbook-pro-von-nick.tailfe410a.ts.net:7100@hub.attacker.example")).toBe(false);
  });

  test("null and junk never match anything", () => {
    // Act + Assert
    expect(isSameOrigin(null, PILOT_HUB)).toBe(false);
    expect(isSameOrigin("ftp://hub.example", "ftp://hub.example")).toBe(false);
    expect(hubOrigin("not a url")).toBeNull();
  });
});

describe("which origin a key is bound to", () => {
  test("a stored key is bound to its recorded origin, not to whatever hubUrl says", () => {
    // Arrange — a login whose hubUrl was hand-edited after the binding was recorded
    const stored = { hubUrl: ATTACKER_HUB, apiKey: STORED_KEY, keyOrigin: PILOT_HUB };

    // Act
    const binding = resolveKeyBinding({}, stored);

    // Assert
    expect(binding).toEqual({ apiKey: STORED_KEY, keyOrigin: PILOT_HUB, keySource: "login" });
  });

  test("a recorded origin that is junk binds the key to nothing, never to hubUrl", async () => {
    // Arrange — a hand edit left a keyOrigin that is no origin, and another
    // that is no string at all
    const home = await makeHome("junk-key-origin");
    cleanups.push(home);
    await writeFile(
      join(home, "config.json"),
      `${JSON.stringify({ version: 1, hubUrl: PILOT_HUB, apiKey: STORED_KEY, keyOrigin: "x" })}\n`,
      "utf8",
    );
    const repo = await repoNaming("junk-key-origin", PILOT_HUB);

    // Act
    const resolved = await resolveReportableConfig({ env: { CROSSCHECK_HOME: home }, repoRoot: repo });
    await writeFile(
      join(home, "config.json"),
      `${JSON.stringify({ version: 1, hubUrl: PILOT_HUB, apiKey: STORED_KEY, keyOrigin: 7100 })}\n`,
      "utf8",
    );
    const numeric = await loadConfig({ env: { CROSSCHECK_HOME: home }, repoRoot: repo });

    // Assert — refused, and doctor's sentence says why
    expect(resolved.kind).toBe("foreign_hub");
    if (resolved.kind === "foreign_hub") {
      expect(resolved.foreignHub.keyOrigin).toBeNull();
      expect(foreignHubWhy(resolved.foreignHub)).toContain("your login's recorded keyOrigin is not a hub address");
    }
    expect(numeric?.keyOrigin).toBeNull();
    expect(numeric?.apiKey).toBe(STORED_KEY);
  });

  test("a legacy stored key, with no recorded origin, is bound to its login's hub", () => {
    // Act
    const binding = resolveKeyBinding({}, { hubUrl: `${PILOT_HUB}/`, apiKey: STORED_KEY });

    // Assert
    expect(binding?.keyOrigin).toBe(PILOT_HUB);
  });

  test("an environment key is bound to the environment's hub when both are set", () => {
    // Act
    const binding = resolveKeyBinding(
      { CROSSCHECK_API_KEY: ENV_KEY, CROSSCHECK_HUB_URL: "http://127.0.0.1:7999/" },
      { hubUrl: PILOT_HUB, apiKey: STORED_KEY },
    );

    // Assert
    expect(binding).toEqual({ apiKey: ENV_KEY, keyOrigin: "http://127.0.0.1:7999", keySource: "env" });
  });

  test("an environment key without an environment hub is bound to the login's, or to nothing", () => {
    // Act
    const withLogin = resolveKeyBinding({ CROSSCHECK_API_KEY: ENV_KEY }, { hubUrl: PILOT_HUB, apiKey: STORED_KEY });
    const alone = resolveKeyBinding({ CROSSCHECK_API_KEY: ENV_KEY }, null);

    // Assert
    expect(withLogin?.keyOrigin).toBe(PILOT_HUB);
    expect(alone).toEqual({ apiKey: ENV_KEY, keyOrigin: null, keySource: "env" });
    expect(foreignHubOf(ATTACKER_HUB, "repo", alone ?? { apiKey: "", keyOrigin: null, keySource: "env" })).not.toBeNull();
  });

  test("the same hub spelled with a slash or in capitals is the key's own; an IP is not", () => {
    // Arrange
    const binding = { apiKey: STORED_KEY, keyOrigin: PILOT_HUB, keySource: "login" as const };

    // Act + Assert
    expect(foreignHubOf(`${PILOT_HUB}/`, "repo", binding)).toBeNull();
    expect(foreignHubOf("HTTP://MACBOOK-PRO-VON-NICK.TAILFE410A.TS.NET:7100", "repo", binding)).toBeNull();
    expect(foreignHubOf(PILOT_HUB_BY_IP, "repo", binding)).toEqual({
      hubOrigin: PILOT_HUB_BY_IP,
      keyOrigin: PILOT_HUB,
      hubSource: "repo",
      keySource: "login",
    });
  });
});

describe("CROSSCHECK_HUB_URL overrides only its own key's hub", () => {
  test("an override naming another origin than the login's is refused, with both origins named", async () => {
    // Arrange
    const home = await homeLoggedInTo("env-override-foreign", PILOT_HUB);

    // Act
    const config = await loadConfig({ env: { CROSSCHECK_HOME: home, CROSSCHECK_HUB_URL: ATTACKER_HUB } });

    // Assert
    expect(config?.foreignHub).toEqual({
      hubOrigin: ATTACKER_HUB,
      keyOrigin: PILOT_HUB,
      hubSource: "env",
      keySource: "login",
    });
    const why = foreignHubWhy(config?.foreignHub ?? (null as never));
    expect(why).toContain(ATTACKER_HUB);
    expect(why).toContain(PILOT_HUB);
    expect(why).not.toContain(STORED_KEY);
    const fix = foreignHubFix(config?.foreignHub ?? (null as never));
    expect(fix).toStartWith(`unset CROSSCHECK_HUB_URL, or set it to ${PILOT_HUB}`);
    // Up to 0.10.0 the hooks followed CROSSCHECK_HUB_URL with the stored key.
    expect(fix).toContain(`your key may already have gone to ${ATTACKER_HUB}: rotate it with \`crosscheck key rotate\``);
  });

  test("an override naming the login's origin in another spelling is accepted", async () => {
    // Arrange
    const home = await homeLoggedInTo("env-override-same", PILOT_HUB);

    // Act
    const config = await loadConfig({ env: { CROSSCHECK_HOME: home, CROSSCHECK_HUB_URL: `${PILOT_HUB}/` } });

    // Assert
    expect(config?.foreignHub).toBeNull();
    expect(config?.keyOrigin).toBe(PILOT_HUB);
  });

  test("a reporting surface refuses the foreign override instead of reporting there", async () => {
    // Arrange — even in a repo whose own config names the login's hub
    const home = await homeLoggedInTo("env-override-reportable", PILOT_HUB);
    const repo = await repoNaming("env-override-reportable", PILOT_HUB);

    // Act
    const resolved = await resolveReportableConfig({
      env: { CROSSCHECK_HOME: home, CROSSCHECK_HUB_URL: ATTACKER_HUB },
      repoRoot: repo,
    });

    // Assert
    expect(resolved.kind).toBe("foreign_hub");
  });
});

describe("a legacy login is bound at its first read", () => {
  test("the binding is the login's own hub, and it is written back", async () => {
    // Arrange — a config.json from before bindings existed
    const home = await homeLoggedInTo("legacy-binding", `${PILOT_HUB}/`);
    expect((await readStoredConfig(home))?.keyOrigin).toBeUndefined();

    // Act
    const config = await loadConfig({ env: { CROSSCHECK_HOME: home } });

    // Assert
    expect(config?.keyOrigin).toBe(PILOT_HUB);
    const written = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as Record<string, unknown>;
    expect(written["keyOrigin"]).toBe(PILOT_HUB);
    expect(written["apiKey"]).toBe(STORED_KEY);
  });

  test("the write-back never stamps the old hub onto a login that landed in between", async () => {
    // Arrange — a new-version read of a legacy login, then an OLD-version
    // `crosscheck login` (it writes no keyOrigin) to another hub and key,
    // landing before the write-back
    const home = await homeLoggedInTo("legacy-binding-race", PILOT_HUB);
    const read = await readStoredConfig(home);
    if (read === null) {
      throw new Error("the legacy login did not parse");
    }
    await saveConfig(home, { version: 1, hubUrl: PILOT_HUB_BY_IP, apiKey: ENV_KEY });

    // Act — the write-back for the login it read
    await persistLegacyBinding(home, read, PILOT_HUB);

    // Assert — the newer login stands, unbound, so its own first read binds it to ITS hub
    const after = await readStoredConfig(home);
    expect(after?.hubUrl).toBe(PILOT_HUB_BY_IP);
    expect(after?.apiKey).toBe(ENV_KEY);
    expect(after?.keyOrigin).toBeUndefined();
    expect((await loadConfig({ env: { CROSSCHECK_HOME: home } }))?.keyOrigin).toBe(PILOT_HUB_BY_IP);
  });

  test("once bound, editing hubUrl does not move the key", async () => {
    // Arrange — bound at first read, then hubUrl edited to another hub
    const home = await homeLoggedInTo("legacy-binding-edit", PILOT_HUB);
    await loadConfig({ env: { CROSSCHECK_HOME: home } });
    const bound = await readStoredConfig(home);
    await saveConfig(home, { ...(bound ?? { version: 1, apiKey: STORED_KEY }), version: 1, hubUrl: ATTACKER_HUB });

    // Act
    const config = await loadConfig({ env: { CROSSCHECK_HOME: home } });

    // Assert
    expect(config?.keyOrigin).toBe(PILOT_HUB);
    expect(config?.foreignHub?.hubSource).toBe("login");
    expect(config?.foreignHub?.hubOrigin).toBe(ATTACKER_HUB);
  });
});

describe("the pilot-shaped config keeps working", () => {
  test("a legacy tailnet login and the monorepo's committed .crosscheck.json report", async () => {
    // Arrange — the login and the repo exactly as the pilot spells them
    const home = await homeLoggedInTo("pilot-shape", PILOT_HUB);
    const repo = await repoNaming("pilot-shape", PILOT_HUB);

    // Act
    const resolved = await resolveReportableConfig({ env: { CROSSCHECK_HOME: home }, repoRoot: repo });

    // Assert
    expect(resolved.kind).toBe("reportable");
    if (resolved.kind === "reportable") {
      expect(resolved.config.hubUrl).toBe(PILOT_HUB);
      expect(resolved.config.keyOrigin).toBe(PILOT_HUB);
      expect(resolved.config.apiKey).toBe(STORED_KEY);
    }
  });

  test("a login typed with a trailing slash or capitals still reports to the same hub", async () => {
    // Arrange
    const home = await homeLoggedInTo("pilot-spelling", "HTTP://Macbook-Pro-Von-Nick.tailfe410a.ts.net:7100/");
    const repo = await repoNaming("pilot-spelling", PILOT_HUB);

    // Act
    const resolved = await resolveReportableConfig({ env: { CROSSCHECK_HOME: home }, repoRoot: repo });

    // Assert
    expect(resolved.kind).toBe("reportable");
  });

  test("a login by IP against the repo's tailnet name is refused with the fix, not reported", async () => {
    // Arrange — the one pilot drift that must WARN rather than silently send
    const home = await homeLoggedInTo("pilot-ip", PILOT_HUB_BY_IP);
    const repo = await repoNaming("pilot-ip", PILOT_HUB);

    // Act
    const resolved = await resolveReportableConfig({ env: { CROSSCHECK_HOME: home }, repoRoot: repo });

    // Assert
    expect(resolved.kind).toBe("foreign_hub");
    if (resolved.kind === "foreign_hub") {
      const fix = foreignHubFix(resolved.foreignHub);
      // The safe edit is the repo's; the repo's hub is never handed out as a
      // login target — the person confirms it out of band first.
      expect(fix).toContain(`"hubUrl" in .crosscheck.json to ${PILOT_HUB_BY_IP}`);
      expect(fix).not.toContain(`crosscheck login ${PILOT_HUB}`);
      expect(fix).toContain("confirm it with whoever runs the hub before you log in there yourself");
      // The agent's line names the key's hub, never the one the repo chose,
      // and sends the agent to its person rather than to a login.
      const agentLine = foreignHubAgentLine(resolved.foreignHub);
      expect(agentLine).toContain(PILOT_HUB_BY_IP);
      expect(agentLine).not.toContain(PILOT_HUB);
      expect(agentLine).toContain("Do not run `crosscheck login` or edit crosscheck's config yourself.");
    }
  });

  test("a repo naming the key's host over plain http is told never to log in over http", () => {
    // Arrange
    const binding = { apiKey: STORED_KEY, keyOrigin: "https://hub.example", keySource: "login" as const };
    const foreign = foreignHubOf("http://hub.example", "repo", binding);

    // Act
    const fix = foreign === null ? "" : foreignHubFix(foreign);

    // Assert
    expect(fix).toContain('change "hubUrl" in .crosscheck.json to https://hub.example');
    expect(fix).toContain("never log in over http");
    expect(fix).not.toContain("crosscheck login http://hub.example");
  });
});
