/**
 * `crosscheck key rotate`, end to end against a real hub.
 *
 * A rotation kills the old key at once, so the command is only correct if it
 * leaves the machine WORKING: the new key saved where the connectors read it
 * and proven against the hub. And it must refuse the two cases where it
 * cannot leave the machine working — a key that lives in CROSSCHECK_API_KEY,
 * which it cannot update, and an agent with no person at the terminal, which
 * must never see a live key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import { readStoredConfig, saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { EXIT_FAIL, EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";

import { runCli } from "../src/index.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "key-rotate-admin";

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
const cleanups: string[] = [];

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

let counter = 0;
const newDeveloper = async (): Promise<string> => {
  counter += 1;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Dev ${String(counter)}`, email: `dev${String(counter)}@example.com` }),
  });
  return ((await response.json()) as { data: { apiKey: string } }).data.apiKey;
};

const works = async (apiKey: string): Promise<boolean> =>
  (await fetch(`${hubUrl}/api/settings`, { headers: { Authorization: `Bearer ${apiKey}` } })).status === 200;

const home = async (label: string): Promise<string> => {
  const path = await makeHome(label);
  cleanups.push(path);
  return path;
};

/** A server that counts what it is sent — another hub, or a proxy. */
const recordingHub = (answer: () => Response = () => Response.json({ ok: true })) => {
  let count = 0;
  const recorder = Bun.serve({
    port: 0,
    fetch: () => {
      count += 1;
      return answer();
    },
  });
  const url = `http://127.0.0.1:${String(recorder.port)}`;
  let isStopped = false;
  const stop = (): void => {
    if (!isStopped) {
      isStopped = true;
      void recorder.stop(true);
    }
  };
  stoppers.push(stop);
  return { url, requests: () => count, stop };
};

const stoppers: (() => void)[] = [];
afterAll(() => {
  stoppers.forEach((stop) => stop());
});

const rotate = (env: Record<string, string>, argv: readonly string[] = [], interactive = true) =>
  runCli(["key", "rotate", ...argv], env, process.cwd(), undefined, { isInteractive: () => interactive });

describe("crosscheck key rotate", () => {
  test("replaces the stored key, and the machine keeps working", async () => {
    // Arrange — a login as `crosscheck login` stores it
    const oldKey = await newDeveloper();
    const dir = await home("key-rotate-stored");
    await saveConfig(dir, { version: 1, hubUrl, apiKey: oldKey, developerName: "Dev" });

    // Act
    const out = await rotate({ CROSSCHECK_HOME: dir, HOME: dir });

    // Assert — saved, proven, the old key dead, the rest of the config intact
    expect(out.exitCode).toBe(EXIT_OK);
    expect(out.stdout).toContain("the old key no longer works");
    expect(out.stdout).toContain("Checked: the hub accepts the new key.");
    const stored = await readStoredConfig(dir);
    expect(stored?.apiKey).not.toBe(oldKey);
    expect(stored?.developerName).toBe("Dev");
    expect(await works(stored?.apiKey ?? "")).toBe(true);
    expect(await works(oldKey)).toBe(false);
    // Not printed unless asked: the key is in a 0600 file, not a scrollback
    expect(out.stdout).not.toContain(stored?.apiKey ?? "<none>");
  });

  test("refuses a key that lives in CROSSCHECK_API_KEY, and rotates nothing", async () => {
    // Arrange
    const envKey = await newDeveloper();
    const dir = await home("key-rotate-env");

    // Act
    const out = await rotate({ CROSSCHECK_HOME: dir, HOME: dir, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: envKey });

    // Assert — the variable would otherwise hold a dead key
    expect(out.exitCode).toBe(EXIT_USAGE);
    expect(out.stdout).toContain("CROSSCHECK_API_KEY");
    expect(await works(envKey)).toBe(true);
  });

  test("with --print, rotates an environment key and shows the new one once", async () => {
    // Arrange
    const envKey = await newDeveloper();
    const dir = await home("key-rotate-print");

    // Act
    const out = await rotate(
      { CROSSCHECK_HOME: dir, HOME: dir, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: envKey },
      ["--print"],
    );

    // Assert — and says that processes holding the old value must restart:
    // they read the variable once, at their start, and nothing re-reads it
    expect(out.exitCode).toBe(EXIT_OK);
    const printed = /\n {2}([0-9a-f]{64})\n/.exec(out.stdout)?.[1] ?? "";
    expect(await works(printed)).toBe(true);
    expect(await works(envKey)).toBe(false);
    expect(out.stdout).toContain("until you restart them");
  });

  test("refuses to send the stored key to a different hub named in CROSSCHECK_HUB_URL", async () => {
    // Arrange — the key belongs to one hub, the environment points at another
    const oldKey = await newDeveloper();
    const dir = await home("key-rotate-other-hub");
    await saveConfig(dir, { version: 1, hubUrl, apiKey: oldKey });
    const otherHub = recordingHub();

    // Act
    const out = await rotate({ CROSSCHECK_HOME: dir, HOME: dir, CROSSCHECK_HUB_URL: otherHub.url });

    // Assert — nothing reached the other hub, nothing rotated, nothing saved
    expect(out.exitCode).toBe(EXIT_USAGE);
    expect(out.stdout).toContain("CROSSCHECK_HUB_URL");
    expect(otherHub.requests()).toBe(0);
    expect((await readStoredConfig(dir))?.apiKey).toBe(oldKey);
    expect(await works(oldKey)).toBe(true);
  });

  test("an answer it cannot read never claims that nothing was rotated", async () => {
    // Arrange — a proxy in front of the hub mangles the reply; the hub may
    // well have committed the rotation behind it
    const dir = await home("key-rotate-mangled");
    const proxy = recordingHub(() => new Response("<html>bad gateway</html>", { status: 200 }));
    await saveConfig(dir, { version: 1, hubUrl: proxy.url, apiKey: "a".repeat(64) });

    // Act
    const out = await rotate({ CROSSCHECK_HOME: dir, HOME: dir });

    // Assert
    expect(out.exitCode).toBe(EXIT_FAIL);
    expect(out.stdout).toContain("your old key may already be dead");
    expect(out.stdout).not.toContain("nothing was rotated");
  });

  test("a hub that does not answer never claims that nothing was rotated", async () => {
    // Arrange — the answer can be lost after the hub committed (a timeout)
    const dir = await home("key-rotate-silent");
    const gone = recordingHub();
    gone.stop();
    await saveConfig(dir, { version: 1, hubUrl: gone.url, apiKey: "b".repeat(64) });

    // Act
    const out = await rotate({ CROSSCHECK_HOME: dir, HOME: dir });

    // Assert
    expect(out.exitCode).toBe(EXIT_UNREACHABLE);
    expect(out.stdout).toContain("your old key may already be dead");
    expect(out.stdout).not.toContain("nothing was rotated");
  });

  test("an agent with no person at the terminal is refused, and nothing rotates", async () => {
    // Arrange
    const oldKey = await newDeveloper();
    const dir = await home("key-rotate-agent");
    await saveConfig(dir, { version: 1, hubUrl, apiKey: oldKey });

    // Act
    const out = await rotate({ CROSSCHECK_HOME: dir, HOME: dir }, [], false);

    // Assert
    expect(out.exitCode).toBe(EXIT_USAGE);
    expect(out.stdout).toContain("needs a person at a terminal");
    expect((await readStoredConfig(dir))?.apiKey).toBe(oldKey);
    expect(await works(oldKey)).toBe(true);
  });
});
