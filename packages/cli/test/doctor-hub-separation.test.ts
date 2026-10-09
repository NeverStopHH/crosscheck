/**
 * Doctor's hub separation lines (cli/doctor-hub-separation.ts): agent
 * credential ≠ operator authority. The operator token FAILs when this user can
 * read it, hub state and a hub running as this user WARN, and a check that
 * cannot tell is SKIP ("not checked"), never PASS.
 *
 * Every home here is a temp dir and every probe that would touch the machine —
 * DNS, tailscale, lsof, netstat, ps — is a fake, so no test ever looks at the
 * real ~/.crosscheck-hub or the real hub's port.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Check } from "../src/cli/doctor.ts";
import { runDoctor } from "../src/cli/doctor.ts";
import {
  HUB_ENV_FILE,
  HUB_HOME_DIR,
  LAUNCH_AGENT_SEGMENTS,
  hubSeparationChecks,
} from "../src/cli/doctor-hub-separation.ts";
import type { SeparationProbes } from "../src/cli/doctor-hub-separation.ts";
import {
  lookupListeners,
  parseNetstatListenerPids,
  serveBackendPort,
} from "../src/cli/hub-separation-probes.ts";
import type { CommandOutcome, ListenerLookup, RunCommand } from "../src/cli/hub-separation-probes.ts";
import { makeRepo } from "../../connector-core/test/helpers.ts";

/** The uid this test process really has: the owner of every file it writes. */
const REAL_UID = process.getuid?.() ?? -1;
const OTHER_UID = REAL_UID + 1;
const IS_ROOT = REAL_UID === 0;
const LOCAL_HUB = "http://127.0.0.1:7100";
const SECRET_MARKER = "secret-marker-never-printed";
const TAILNET_IP = "100.101.4.7";
const MAGIC_DNS_HOST = "mac.tail1234.ts.net";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const tempHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "cx-hub-separation-"));
  paths.push(home);
  return home;
};

/** Probes that touch nothing real: no DNS, no tailscale, no lsof. */
const fakeProbes = (overrides: Partial<SeparationProbes> = {}): SeparationProbes => ({
  lookupHost: () => Promise.resolve(["203.0.113.7"]),
  localAddresses: () => new Set(["192.168.2.100", TAILNET_IP]),
  serveStatus: () => Promise.resolve(null),
  listListeners: () => Promise.resolve({ kind: "failed", why: "the test named no listener" }),
  myUid: REAL_UID,
  platform: "darwin",
  ...overrides,
});

const writeHubEnv = async (home: string, mode: number): Promise<string> => {
  const dir = join(home, HUB_HOME_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, HUB_ENV_FILE);
  await writeFile(path, `ADMIN_TOKEN=${SECRET_MARKER}\n`, "utf8");
  await chmod(path, mode);
  return path;
};

const named = (checks: readonly Check[], name: string): Check => {
  const found = checks.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`no "${name}" line in: ${checks.map((entry) => entry.name).join(", ")}`);
  }
  return found;
};

const separation = (
  env: Readonly<Record<string, string>>,
  probes: Partial<SeparationProbes> = {},
  hubUrl = LOCAL_HUB,
): Promise<readonly Check[]> => hubSeparationChecks({ env, hubUrl, probes: fakeProbes(probes) });

const listening = (lookup: ListenerLookup): Partial<SeparationProbes> => ({
  listListeners: () => Promise.resolve(lookup),
});

describe("operator token", () => {
  test("a hub.env other users can read FAILs, naming the path and never its contents", async () => {
    // Arrange
    const home = await tempHome();
    const path = await writeHubEnv(home, 0o644);

    // Act
    const token = named(await separation({ HOME: home }), "operator token");

    // Assert
    expect(token.level).toBe("FAIL");
    expect(token.detail).toContain(`the operator token in ${path} is readable by your user, so your agents can read it`);
    expect(token.detail).toContain('move the hub under its own user (see docs/OPERATIONS.md, "Running the hub under its own user")');
    expect(token.detail).not.toContain(SECRET_MARKER);
  });

  test("a 600 hub.env owned by me still FAILs: readable by me is what matters", async () => {
    // Arrange
    const home = await tempHome();
    const path = await writeHubEnv(home, 0o600);

    // Act
    const token = named(await separation({ HOME: home }), "operator token");

    // Assert
    expect(token.level).toBe("FAIL");
    expect(token.detail).toContain(`${path} is readable by your user`);
  });

  test.skipIf(IS_ROOT)("a hub.env this user can neither read, write nor chmod PASSes", async () => {
    // Arrange: mode 000, and the probes say the file belongs to someone else
    const home = await tempHome();
    const path = await writeHubEnv(home, 0o000);

    // Act
    const token = named(await separation({ HOME: home }, { myUid: OTHER_UID }), "operator token");

    // Assert
    expect(token.level).toBe("PASS");
    expect(token.detail).toBe(`${path} is not readable by your user`);
  });

  test.skipIf(IS_ROOT)("a 000 hub.env that is mine FAILs: my agents can chmod it back", async () => {
    // Arrange
    const home = await tempHome();
    await writeHubEnv(home, 0o000);

    // Act
    const token = named(await separation({ HOME: home }), "operator token");

    // Assert
    expect(token.level).toBe("FAIL");
    expect(token.detail).toContain("belongs to your user, so your agents can make it readable");
  });

  test("ADMIN_TOKEN in this shell's environment FAILs without printing it", async () => {
    // Arrange
    const home = await tempHome();

    // Act
    const token = named(await separation({ HOME: home, ADMIN_TOKEN: SECRET_MARKER }), "operator token");

    // Assert
    expect(token.level).toBe("FAIL");
    expect(token.detail).toContain("ADMIN_TOKEN is set in this shell's environment");
    expect(token.detail).not.toContain(SECRET_MARKER);
  });

  test("no hub home PASSes; no HOME at all is SKIP, never a look at the real home", async () => {
    // Arrange
    const home = await tempHome();

    // Act
    const withHome = await separation({ HOME: home });
    const withoutHome = await separation({});

    // Assert
    expect(named(withHome, "operator token")).toEqual({
      level: "PASS",
      name: "operator token",
      detail: `no hub.env in ${join(home, HUB_HOME_DIR)}`,
    });
    expect(named(withoutHome, "operator token").level).toBe("SKIP");
    expect(named(withoutHome, "hub state").level).toBe("SKIP");
    expect(named(withoutHome, "hub LaunchAgent").level).toBe("SKIP");
  });
});

describe("hub state", () => {
  test("a data dir and trial-keys.txt of mine WARN, by path, and hub.env is the token line's alone", async () => {
    // Arrange
    const home = await tempHome();
    const hubHome = join(home, HUB_HOME_DIR);
    await writeHubEnv(home, 0o600);
    await mkdir(join(hubHome, "data"), { mode: 0o700 });
    await writeFile(join(hubHome, "trial-keys.txt"), `${SECRET_MARKER}\n`, { mode: 0o600 });

    // Act
    const state = named(await separation({ HOME: home }), "hub state");

    // Assert
    expect(state.level).toBe("WARN");
    expect(state.detail).toContain(join(hubHome, "data"));
    expect(state.detail).toContain(join(hubHome, "trial-keys.txt"));
    expect(state.detail).toContain("are readable or writable by your user");
    expect(state.detail).not.toContain(HUB_ENV_FILE);
    expect(state.detail).not.toContain(SECRET_MARKER);
  });

  test("the data dir this environment names, and its state dir, are checked too", async () => {
    // Arrange
    const home = await tempHome();
    const elsewhere = await tempHome();
    const dataDir = join(elsewhere, "data");
    await mkdir(`${dataDir}.state`, { mode: 0o700 });

    // Act
    const state = named(await separation({ HOME: home, CROSSCHECK_DATA_DIR: dataDir }), "hub state");

    // Assert
    expect(state.level).toBe("WARN");
    expect(state.detail).toContain(`${dataDir}.state is readable or writable by your user`);
  });

  test("a home with nothing of the hub's in it PASSes", async () => {
    // Arrange
    const home = await tempHome();

    // Act
    const state = named(await separation({ HOME: home }), "hub state");

    // Assert
    expect(state).toEqual({ level: "PASS", name: "hub state", detail: `no hub state in ${join(home, HUB_HOME_DIR)}` });
  });
});

describe("hub process", () => {
  test("a hub listening as my uid WARNs", async () => {
    // Arrange
    const home = await tempHome();
    const mine = listening({ kind: "found", listeners: [{ uid: REAL_UID, user: "dev", command: "bun" }] });

    // Act
    const hubProcess = named(await separation({ HOME: home }, mine), "hub process");

    // Assert
    expect(hubProcess.level).toBe("WARN");
    expect(hubProcess.detail).toContain(`the hub runs as your user (bun, dev, uid ${String(REAL_UID)}, on :7100)`);
  });

  test("a hub listening as another uid PASSes", async () => {
    // Arrange
    const home = await tempHome();
    const theirs = listening({ kind: "found", listeners: [{ uid: OTHER_UID, user: "crosscheck-hub", command: "bun" }] });

    // Act
    const hubProcess = named(await separation({ HOME: home }, theirs), "hub process");

    // Assert
    expect(hubProcess).toEqual({
      level: "PASS",
      name: "hub process",
      detail: `the hub on :7100 runs as another user (bun, crosscheck-hub, uid ${String(OTHER_UID)}), not as yours`,
    });
  });

  test("an lsof that timed out is not checked, never PASS", async () => {
    // Arrange
    const home = await tempHome();
    const timedOut = listening({ kind: "failed", why: "lsof did not answer within 1.5 s" });

    // Act
    const hubProcess = named(await separation({ HOME: home }, timedOut), "hub process");

    // Assert
    expect(hubProcess).toEqual({
      level: "SKIP",
      name: "hub process",
      detail: "not checked: lsof did not answer within 1.5 s",
    });
  });

  test("a front that is not the hub's bun is not checked, whoever runs it", async () => {
    // Arrange
    const home = await tempHome();
    const proxy = listening({ kind: "found", listeners: [{ uid: 0, user: "root", command: "caddy" }] });

    // Act
    const hubProcess = named(await separation({ HOME: home }, proxy), "hub process");

    // Assert
    expect(hubProcess.level).toBe("SKIP");
    expect(hubProcess.detail).toContain("not checked: caddy, root, uid 0 listens on :7100, not the hub's bun");
  });

  test("a remote hub is skipped, and no listener lookup runs", async () => {
    // Arrange
    const home = await tempHome();
    const lookups: number[] = [];
    const probes: Partial<SeparationProbes> = {
      lookupHost: () => Promise.resolve(["203.0.113.7"]),
      listListeners: (port) => {
        lookups.push(port);
        return Promise.resolve({ kind: "found", listeners: [{ uid: OTHER_UID, user: "x", command: "bun" }] });
      },
    };

    // Act
    const hubProcess = named(await separation({ HOME: home }, probes, "https://hub.example.com"), "hub process");

    // Assert
    expect(hubProcess).toEqual({
      level: "SKIP",
      name: "hub process",
      detail: "not checked here: the hub runs elsewhere (hub.example.com)",
    });
    expect(lookups).toEqual([]);
  });

  test("a hub name that does not resolve is not checked", async () => {
    // Arrange
    const home = await tempHome();

    // Act
    const hubProcess = named(
      await separation({ HOME: home }, { lookupHost: () => Promise.resolve(null) }, "http://hub.invalid:7100"),
      "hub process",
    );

    // Assert
    expect(hubProcess.level).toBe("SKIP");
    expect(hubProcess.detail).toContain("hub.invalid did not resolve");
  });

  test("this machine's tailnet IP is a local hub, judged on its own port", async () => {
    // Arrange
    const home = await tempHome();
    const lookups: number[] = [];
    const probes: Partial<SeparationProbes> = {
      listListeners: (port) => {
        lookups.push(port);
        return Promise.resolve({ kind: "found", listeners: [{ uid: REAL_UID, user: "dev", command: "bun" }] });
      },
    };

    // Act
    const hubProcess = named(await separation({ HOME: home }, probes, `http://${TAILNET_IP}:7100`), "hub process");

    // Assert
    expect(hubProcess.level).toBe("WARN");
    expect(lookups).toEqual([7100]);
  });

  test("an https front on this machine is traced through tailscale serve to the loopback port", async () => {
    // Arrange
    const home = await tempHome();
    const lookups: number[] = [];
    const serve = JSON.stringify({
      TCP: { "443": { HTTPS: true } },
      Web: { [`${MAGIC_DNS_HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7100" } } } },
    });
    const probes: Partial<SeparationProbes> = {
      lookupHost: () => Promise.resolve([TAILNET_IP]),
      serveStatus: () => Promise.resolve(serve),
      listListeners: (port) => {
        lookups.push(port);
        return Promise.resolve({ kind: "found", listeners: [{ uid: OTHER_UID, user: "crosscheck-hub", command: "bun" }] });
      },
    };

    // Act
    const hubProcess = named(await separation({ HOME: home }, probes, `https://${MAGIC_DNS_HOST}`), "hub process");

    // Assert
    expect(lookups).toEqual([7100]);
    expect(hubProcess.level).toBe("PASS");
    expect(hubProcess.detail).toContain("the hub on :7100 behind tailscale serve runs as another user");
  });

  test("an https hub on this machine that no serve mapping explains is not checked", async () => {
    // Arrange
    const home = await tempHome();

    // Act
    const hubProcess = named(
      await separation({ HOME: home }, { lookupHost: () => Promise.resolve([TAILNET_IP]) }, `https://${MAGIC_DNS_HOST}`),
      "hub process",
    );

    // Assert
    expect(hubProcess.level).toBe("SKIP");
    expect(hubProcess.detail).toContain("no `tailscale serve` mapping names the port behind it");
  });
});

describe("hub LaunchAgent", () => {
  test("a user LaunchAgent for the hub WARNs: it runs as me", async () => {
    // Arrange
    const home = await tempHome();
    const path = join(home, ...LAUNCH_AGENT_SEGMENTS);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(path, "<plist/>\n", "utf8");

    // Act
    const agent = named(await separation({ HOME: home }), "hub LaunchAgent");

    // Assert
    expect(agent.level).toBe("WARN");
    expect(agent.detail).toContain(`${path} starts the hub as your user`);
  });

  test("none PASSes, and off macOS there is no line at all", async () => {
    // Arrange
    const home = await tempHome();

    // Act
    const mac = await separation({ HOME: home });
    const linux = await separation({ HOME: home }, { platform: "linux" });

    // Assert
    expect(named(mac, "hub LaunchAgent").level).toBe("PASS");
    expect(linux.map((entry) => entry.name)).toEqual(["operator token", "hub state", "hub process"]);
  });
});

describe("the default listener lookup", () => {
  const NETSTAT = [
    "Active Internet connections (including servers)",
    "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options",
    "tcp4       0      0  127.0.0.1.7100         *.*                    LISTEN                 0            0  131072  131072        bun:4242   00100 00000006 0000000004940422 00000000 00000800      1      0 000000",
    "tcp6       0      0  ::1.7100               *.*                    LISTEN                 0            0  131072  131072        bun:4242   00100 00000006 0000000004940423 00000000 00000800      1      0 000000",
    "tcp46      0      0  *.61091                *.*                    LISTEN                 0            0  131072  131072    Sky Go Helper:632    00100 00000006 000000000479727d 00000000 00080800      1      0 000000",
  ].join("\n");

  /** A runner that answers each tool by name and records what was asked. */
  const runner =
    (answers: Readonly<Record<string, CommandOutcome>>, asked: string[]): RunCommand =>
    (cmd) => {
      const tool = cmd[0] ?? "";
      asked.push(tool);
      return Promise.resolve(answers[tool] ?? { ok: false, timedOut: false });
    };

  test("lsof naming my process is enough: netstat is never asked", async () => {
    // Arrange
    const asked: string[] = [];
    const run = runner({ lsof: { ok: true, stdout: "p4242\ncbun\nu501\nLdev\nf12\n" } }, asked);

    // Act
    const lookup = await lookupListeners(7100, run, "darwin");

    // Assert
    expect(lookup).toEqual({ kind: "found", listeners: [{ uid: 501, user: "dev", command: "bun" }] });
    expect(asked).toEqual(["lsof"]);
  });

  test("on macOS a listener lsof cannot see is found through netstat and ps", async () => {
    // Arrange
    const asked: string[] = [];
    const run = runner(
      {
        lsof: { ok: false, timedOut: false },
        netstat: { ok: true, stdout: NETSTAT },
        ps: { ok: true, stdout: "  502 crosscheck-hub bun\n" },
      },
      asked,
    );

    // Act
    const lookup = await lookupListeners(7100, run, "darwin");

    // Assert
    expect(lookup).toEqual({ kind: "found", listeners: [{ uid: 502, user: "crosscheck-hub", command: "bun" }] });
    expect(asked).toEqual(["lsof", "netstat", "ps"]);
  });

  test("on macOS lsof and netstat both timing out is failed", async () => {
    // Arrange
    const run = runner({ lsof: { ok: false, timedOut: true }, netstat: { ok: false, timedOut: true } }, []);

    // Act
    const lookup = await lookupListeners(7100, run, "darwin");

    // Assert
    expect(lookup).toEqual({ kind: "failed", why: "netstat did not answer within 2 s" });
  });

  test("off macOS, lsof seeing nothing of mine is failed, never none", async () => {
    // Arrange
    const run = runner({ lsof: { ok: false, timedOut: false } }, []);

    // Act
    const lookup = await lookupListeners(7100, run, "linux");

    // Assert
    expect(lookup.kind).toBe("failed");
  });

  test("a timed-out lsof off macOS says so", async () => {
    // Arrange
    const run = runner({ lsof: { ok: false, timedOut: true } }, []);

    // Act + Assert
    expect(await lookupListeners(7100, run, "linux")).toEqual({
      kind: "failed",
      why: "lsof did not answer within 1.5 s",
    });
  });

  test("netstat's pids per port, a name with spaces, and a row with no pid", () => {
    // Act + Assert
    expect(parseNetstatListenerPids(NETSTAT, 7100)).toEqual([4242]);
    expect(parseNetstatListenerPids(NETSTAT, 61091)).toEqual([632]);
    expect(parseNetstatListenerPids(NETSTAT, 9)).toEqual([]);
    expect(
      parseNetstatListenerPids("tcp4  0  0  127.0.0.1.7100  *.*  LISTEN  0  0  131072  131072  4242  0", 7100),
    ).toBeNull();
  });

  test("tailscale serve's mapping names a loopback port, and nothing else", () => {
    // Arrange
    const status = (proxy: string): string =>
      JSON.stringify({ Web: { [`${MAGIC_DNS_HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } } });

    // Act + Assert
    expect(serveBackendPort(status("http://127.0.0.1:7100"), MAGIC_DNS_HOST, 443)).toBe(7100);
    expect(serveBackendPort(status("http://localhost:7200"), MAGIC_DNS_HOST, 443)).toBe(7200);
    expect(serveBackendPort(status("7300"), MAGIC_DNS_HOST, 443)).toBe(7300);
    expect(serveBackendPort(status("http://192.168.2.9:7100"), MAGIC_DNS_HOST, 443)).toBeNull();
    expect(serveBackendPort(status("http://127.0.0.1:7100"), "other.tail1234.ts.net", 443)).toBeNull();
    expect(serveBackendPort("not json", MAGIC_DNS_HOST, 443)).toBeNull();
  });
});

describe("doctor prints the lines", () => {
  test("the token FAIL reaches doctor's report, and a check that could not tell is counted as not checked", async () => {
    // Arrange
    const home = await tempHome();
    const repo = await makeRepo("hub-separation", { remote: "git@github.com:acme/api.git" });
    paths.push(repo);
    await writeHubEnv(home, 0o600);
    const env = {
      CROSSCHECK_HOME: join(home, ".crosscheck"),
      HOME: home,
      CROSSCHECK_HUB_URL: "http://127.0.0.1:9",
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_DOCTOR_NO_PROBE: "1",
    };

    // Act
    const result = await runDoctor(env, repo, () => Promise.resolve(null), undefined, fakeProbes());

    // Assert
    const lines = result.stdout.split("\n");
    expect(lines.some((entry) => entry.startsWith("FAIL  operator token  the operator token in "))).toBe(true);
    expect(lines).toContain("SKIP  hub process  not checked: the test named no listener");
    expect(result.stdout).not.toContain(SECRET_MARKER);
    expect(lines.find((entry) => / pass, \d+ warn, \d+ fail/.test(entry))).toMatch(/, 1 not checked$/);
  });
});
