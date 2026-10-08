/**
 * THE BOOTED HUB LISTENS WHERE ITS DATA DIR SAYS (http/listen.ts), proved on
 * the real entry point as a child process: a random port (never the pilot's
 * 7100), a temp data dir, no embedder.
 *
 *   - a new data dir with CROSSCHECK_LISTEN unset listens on loopback only;
 *   - a data dir from before the setting keeps every interface, and the boot
 *     says so with the fix;
 *   - an address that is not an IP, or that no interface here has, stops the
 *     boot BEFORE PGlite writes a byte: the data dir stays empty.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sql } from "drizzle-orm";

import { closeDb, createDb } from "../src/db/client.ts";
import { canListenAt, interfaceAddresses } from "../src/http/listen.ts";

/** An IPv4 address of this machine's own LAN or tailnet interface, if it has one. */
const LAN_ADDRESS = interfaceAddresses().find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address) && canListenAt(address));

const SERVER_ENTRY = resolve(import.meta.dir, "..", "src", "index.ts");
/** Cold PGlite boot of a data dir, with slack for a loaded machine. */
const BOOT_TIMEOUT_MS = 30_000;
/** A SIGTERM that takes longer than this is a hang, not a shutdown. */
const SHUTDOWN_TIMEOUT_MS = 5_000;
const BANNER = "crosscheck server listening on";

/** Ephemeral-range port, random so parallel runs cannot collide (never the hub's 7100). */
const randomPort = (): number => 20_000 + Math.floor(Math.random() * 20_000);

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const freshDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "crosscheck-listen-"));
  tempDirs.push(dir);
  return dir;
};

/** The hub's env minus anything that could pick a real embedder or a listen list. */
const hubEnv = (
  port: number,
  dataDir: string,
  extra: Record<string, string> = {},
): Record<string, string | undefined> => {
  const {
    OPENAI_API_KEY: _openai,
    CROSSCHECK_OLLAMA_URL: _ollama,
    CROSSCHECK_LISTEN: _listen,
    CROSSCHECK_TRUSTED_PROXIES: _proxies,
    ...rest
  } = process.env;
  return { ...rest, PORT: String(port), CROSSCHECK_DATA_DIR: dataDir, CROSSCHECK_EMBEDDER: "none", ...extra };
};

interface BootResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number | "killed";
}

/** Boot until the banner, run `whileUp`, then stop it; or until it exits on its own. */
const boot = async (
  env: Record<string, string | undefined>,
  whileUp: () => Promise<void> = async () => {},
): Promise<BootResult> => {
  const child = Bun.spawn({
    cmd: [process.execPath, SERVER_ENTRY],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const stdoutText = (async () => {
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    let seen = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        return seen;
      }
      seen += decoder.decode(next.value, { stream: true });
      if (seen.includes(BANNER) && seen.slice(seen.indexOf(BANNER)).includes("\n")) {
        reader.releaseLock();
        return seen;
      }
    }
  })();
  const outcome = await Promise.race([
    stdoutText.then((text) => ({ text })),
    child.exited.then((code) => ({ code })),
    new Promise<"timeout">((resolveRace) => setTimeout(() => resolveRace("timeout"), BOOT_TIMEOUT_MS)),
  ]);
  let exit: number | "killed" = "killed";
  if (typeof outcome === "object" && "code" in outcome) {
    exit = outcome.code;
  } else if (typeof outcome === "object" && !outcome.text.includes(BANNER)) {
    // Stdout closed without a banner: the process is ending on its own.
    exit = await child.exited;
  } else {
    if (typeof outcome === "object") {
      await whileUp();
    }
    child.kill("SIGTERM");
    const ended = await Promise.race([
      child.exited,
      new Promise<"hung">((resolveRace) => setTimeout(() => resolveRace("hung"), SHUTDOWN_TIMEOUT_MS)),
    ]);
    if (ended === "hung") {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
  const stdout = typeof outcome === "object" && "text" in outcome ? outcome.text : await stdoutText.catch(() => "");
  const stderr = await new Response(child.stderr).text();
  return { stdout, stderr, exit };
};

/** This test's own admin token, for the one developer the transport probe needs. */
const BOOT_ADMIN_TOKEN = "listen-boot-admin-token";

/** GET /api/hub-status's transport block from the booted hub, as a fresh developer reads it. */
const hubStatusTransport = async (port: number): Promise<unknown> => {
  const base = `http://127.0.0.1:${String(port)}`;
  const created = await fetch(`${base}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BOOT_ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Probe", email: "probe@example.com" }),
  });
  const apiKey = ((await created.json()) as { data: { apiKey: string } }).data.apiKey;
  const status = await fetch(`${base}/api/hub-status`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return ((await status.json()) as { data: { transport: unknown } }).data.transport;
};

describe("where a booted hub listens", () => {
  test(
    "a new data dir with CROSSCHECK_LISTEN unset listens on loopback only, without a warning",
    async () => {
      // Arrange
      const dataDir = await freshDir();
      const port = randomPort();

      // Act
      const result = await boot(hubEnv(port, dataDir));

      // Assert
      expect(result.stdout).toContain(`${BANNER} :${String(port)} (127.0.0.1`);
      expect(result.stdout).not.toContain("every interface");
      expect(result.stderr).not.toContain("WARN listening on EVERY");
    },
    BOOT_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 3,
  );

  test(
    "a data dir from before the setting keeps every interface, and the boot warns with the fix",
    async () => {
      // Arrange: a hub's tables with no hub_install row, the way 0.10 left them
      const dataDir = await freshDir();
      const seeded = await createDb({ dataDir });
      await seeded.execute(sql`DROP TABLE hub_install`);
      await closeDb(seeded);
      const port = randomPort();
      let transport: unknown = null;

      // Act — and while it is up, ask it what doctor asks
      const result = await boot(hubEnv(port, dataDir, { ADMIN_TOKEN: BOOT_ADMIN_TOKEN }), async () => {
        transport = await hubStatusTransport(port);
      });

      // Assert
      expect(result.stdout).toContain(`${BANNER} :${String(port)} (every interface)`);
      expect(result.stderr).toContain(`WARN listening on EVERY network interface (:${String(port)})`);
      expect(result.stderr).toContain("CROSSCHECK_LISTEN=127.0.0.1,<this machine's tailnet IP>");
      expect(transport).toMatchObject({ listensOnEveryInterface: true });
    },
    BOOT_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 3,
  );

  test(
    "a listen list that was set wins on an old data dir too",
    async () => {
      // Arrange
      const dataDir = await freshDir();
      const seeded = await createDb({ dataDir });
      await seeded.execute(sql`DROP TABLE hub_install`);
      await closeDb(seeded);
      const port = randomPort();

      // Act
      const result = await boot(hubEnv(port, dataDir, { CROSSCHECK_LISTEN: "127.0.0.1" }));

      // Assert
      expect(result.stdout).toContain(`${BANNER} :${String(port)} (127.0.0.1)`);
      expect(result.stderr).not.toContain("WARN listening on EVERY");
    },
    BOOT_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 3,
  );

  test(
    "a localhost passkey origin beside an https one boots with a warning naming the list to set",
    async () => {
      // Arrange
      const dataDir = await freshDir();
      const port = randomPort();

      // Act
      const result = await boot(
        hubEnv(port, dataDir, {
          CROSSCHECK_WEBAUTHN_ORIGINS: `http://localhost:${String(port)},https://hub.example.ts.net`,
        }),
      );

      // Assert
      expect(result.stdout).toContain(BANNER);
      expect(result.stderr).toContain("WARN CROSSCHECK_WEBAUTHN_ORIGINS lists a localhost origin beside an https one");
      expect(result.stderr).toContain("Drop it: CROSSCHECK_WEBAUTHN_ORIGINS=https://hub.example.ts.net,");
    },
    BOOT_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 3,
  );

  test.skipIf(!canListenAt("::1"))(
    "a foreign listener on [::1] at the port stops the boot before the data dir is touched (review X9)",
    async () => {
      // Arrange — browsers try ::1 first for localhost; this would answer them
      const dataDir = await freshDir();
      const port = randomPort();
      const foreign = Bun.listen({ hostname: "::1", port, socket: { data: () => {} } });
      try {
        // Act
        const result = await boot(hubEnv(port, dataDir));

        // Assert
        expect(result.exit).not.toBe(0);
        expect(result.exit).not.toBe("killed");
        expect(result.stderr).toContain(`port ${String(port)} is already in use`);
        expect(await readdir(dataDir)).toEqual([]);
      } finally {
        foreign.stop(true);
      }
    },
    BOOT_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 3,
  );

  test.skipIf(LAN_ADDRESS === undefined)(
    "on every interface, a foreign listener on the machine's own address stops the boot (review L4)",
    async () => {
      // Arrange — an old data dir, and something already on this machine's LAN address at the port
      const dataDir = await freshDir();
      const seeded = await createDb({ dataDir });
      await seeded.execute(sql`DROP TABLE hub_install`);
      await closeDb(seeded);
      const port = randomPort();
      const foreign = Bun.listen({ hostname: LAN_ADDRESS ?? "", port, socket: { data: () => {} } });
      try {
        // Act
        const result = await boot(hubEnv(port, dataDir));

        // Assert — refused, not split with the foreign listener
        expect(result.exit).not.toBe(0);
        expect(result.exit).not.toBe("killed");
        expect(result.stderr).toContain(`port ${String(port)} is already in use`);
        expect(result.stdout).not.toContain(BANNER);
      } finally {
        foreign.stop(true);
      }
    },
    BOOT_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 3,
  );

  test(
    "an address that is not an IP stops the boot before the data dir is touched",
    async () => {
      // Arrange
      const dataDir = await freshDir();

      // Act
      const result = await boot(hubEnv(randomPort(), dataDir, { CROSSCHECK_LISTEN: "hub.local" }));

      // Assert
      expect(result.exit).not.toBe(0);
      expect(result.exit).not.toBe("killed");
      expect(result.stderr).toContain('CROSSCHECK_LISTEN: "hub.local" is not an IP address');
      expect(result.stdout).not.toContain(BANNER);
      expect(await readdir(dataDir)).toEqual([]);
    },
    BOOT_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 3,
  );

  test(
    "an address no interface here has stops the boot before the data dir is touched",
    async () => {
      // Arrange: TEST-NET-1 (RFC 5737), never assigned to any interface
      const dataDir = await freshDir();

      // Act
      const result = await boot(hubEnv(randomPort(), dataDir, { CROSSCHECK_LISTEN: "127.0.0.1,192.0.2.10" }));

      // Assert
      expect(result.exit).not.toBe(0);
      expect(result.exit).not.toBe("killed");
      expect(result.stderr).toContain("CROSSCHECK_LISTEN: this machine cannot listen at 192.0.2.10");
      expect(await readdir(dataDir)).toEqual([]);
    },
    BOOT_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS * 3,
  );
});
