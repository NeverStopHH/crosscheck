/**
 * WHERE THE HUB LISTENS (http/listen.ts): the parse of CROSSCHECK_LISTEN, the
 * default each kind of data dir gets, and the servers that come out of it.
 *
 * The 0.10 hub called `Bun.serve({ port })`, which binds every interface: on
 * the pilot machine that was `*:7100` with the firewall off, reachable from
 * any Wi-Fi the laptop joined. A new data dir now listens on loopback only.
 * An old one keeps every interface, so that upgrading cuts off no teammate,
 * and warns (listen-boot.test.ts boots both).
 */
import { describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";

import { createDb } from "../src/db/client.ts";
import type { Db } from "../src/db/client.ts";
import {
  assertListenable,
  canListenAt,
  parseListenAddresses,
  probeAddressesFor,
  resolveListenPlan,
  serveOnPlan,
} from "../src/http/listen.ts";
import { holdsMembersFromBeforeInstall, readListenDefault } from "../src/services/hub-install.ts";
import { BOOTSTRAP_SQL_URL } from "./fixtures/bootstrap-sql.ts";

/** TEST-NET-1 (RFC 5737): never assigned to any interface. */
const ADDRESS_NO_MACHINE_HAS = "192.0.2.10";

const rerunBootstrap = async (db: Db): Promise<void> => {
  const client = (db as unknown as { readonly $client: PGlite }).$client;
  await client.exec(await Bun.file(BOOTSTRAP_SQL_URL).text());
};

const okFetch = (): Response => new Response("hub");

describe("CROSSCHECK_LISTEN", () => {
  test("unset is no list, and the data dir's default decides", () => {
    expect(parseListenAddresses(undefined)).toBeNull();
  });

  test("a comma list of addresses, bracketed IPv6 included, comes back as socket addresses", () => {
    expect(parseListenAddresses(" 127.0.0.1, [::1] ,100.101.4.7,127.0.0.1")).toEqual([
      "127.0.0.1",
      "::1",
      "100.101.4.7",
    ]);
  });

  test("a hostname is refused: where the hub listens must not depend on a DNS lookup", () => {
    expect(() => parseListenAddresses("127.0.0.1,hub.tailnet.ts.net")).toThrow(
      /CROSSCHECK_LISTEN: "hub\.tailnet\.ts\.net" is not an IP address/,
    );
  });

  test("set but empty is refused, rather than read as unset", () => {
    expect(() => parseListenAddresses(" , ")).toThrow(/CROSSCHECK_LISTEN is set but names no address/);
  });

  test("every interface stands alone: 0.0.0.0 beside a specific address is refused", () => {
    expect(() => parseListenAddresses("0.0.0.0,127.0.0.1")).toThrow(/already mean every interface/);
    expect(parseListenAddresses("0.0.0.0")).toEqual(["0.0.0.0"]);
  });

  test("every interface is judged by address, not by spelling (review L2)", () => {
    expect(() => parseListenAddresses("0:0:0:0:0:0:0:0,127.0.0.1")).toThrow(/already mean every interface/);
    expect(() => parseListenAddresses("::ffff:0.0.0.0,127.0.0.1")).toThrow(/already mean every interface/);
    expect(parseListenAddresses("0:0:0:0:0:0:0:1,[::1],FD7A::1")).toEqual(["::1", "fd7a::1"]);
  });

  test("an address no interface here has is refused by name", () => {
    expect(canListenAt(ADDRESS_NO_MACHINE_HAS)).toBe(false);
    expect(() => assertListenable(["127.0.0.1", ADDRESS_NO_MACHINE_HAS])).toThrow(
      `CROSSCHECK_LISTEN: this machine cannot listen at ${ADDRESS_NO_MACHINE_HAS}`,
    );
  });
});

describe("the listen plan", () => {
  test("a list that was set wins over any default", () => {
    const plan = resolveListenPlan({ configured: ["100.101.4.7"], listenDefault: "all_interfaces", hasIpv6Loopback: true });

    expect(plan).toEqual({ kind: "configured", addresses: ["100.101.4.7"] });
  });

  test("a new data dir listens on loopback only, ::1 included where the machine has it", () => {
    expect(resolveListenPlan({ configured: null, listenDefault: "loopback", hasIpv6Loopback: true })).toEqual({
      kind: "loopback_default",
      addresses: ["127.0.0.1", "::1"],
    });
    expect(resolveListenPlan({ configured: null, listenDefault: "loopback", hasIpv6Loopback: false })).toEqual({
      kind: "loopback_default",
      addresses: ["127.0.0.1"],
    });
  });

  test("a data dir from before the setting keeps every interface", () => {
    expect(resolveListenPlan({ configured: null, listenDefault: "all_interfaces", hasIpv6Loopback: true })).toEqual({
      kind: "legacy_all_interfaces",
      addresses: null,
    });
  });
});

describe("which data dir is which (db/bootstrap.sql hub_install)", () => {
  test("a database this release creates is recorded loopback, and stays so on every restart", async () => {
    // Arrange
    const db = await createDb();

    // Act
    const atBirth = await readListenDefault(db);
    await rerunBootstrap(db);
    const afterRestart = await readListenDefault(db);

    // Assert
    expect(atBirth).toBe("loopback");
    expect(afterRestart).toBe("loopback");
  });

  test("a database from before the setting is recorded every-interface on its first start", async () => {
    // Arrange: a hub's tables with no hub_install row, the way 0.10 left them
    const db = await createDb();
    await db.execute(sql`DROP TABLE hub_install`);

    // Act: the next start of this release
    await rerunBootstrap(db);

    // Assert
    expect(await readListenDefault(db)).toBe("all_interfaces");
  });
});

describe("where the port probe knocks (review L4)", () => {
  const LOOPBACKS = ["127.0.0.1", "::1"];
  const INTERFACES = ["192.168.1.20", "100.101.4.7", "fd7a:115c:a1e0::7"];

  test("unset: the loopbacks, which the hub listens at either way", () => {
    expect(probeAddressesFor(null, LOOPBACKS, INTERFACES)).toEqual(LOOPBACKS);
  });

  test("a specific address: that address", () => {
    expect(probeAddressesFor(["100.101.4.7"], LOOPBACKS, INTERFACES)).toEqual(["100.101.4.7"]);
  });

  test("0.0.0.0: IPv4 loopback and every IPv4 interface address", () => {
    expect(probeAddressesFor(["0.0.0.0"], LOOPBACKS, INTERFACES)).toEqual(["127.0.0.1", "192.168.1.20", "100.101.4.7"]);
  });

  test(":: (dual-stack): both loopbacks and every interface address", () => {
    expect(probeAddressesFor(["::"], LOOPBACKS, INTERFACES)).toEqual([...LOOPBACKS, ...INTERFACES]);
  });
});

describe("what the install record says beyond the default (review X11 and L5)", () => {
  test("an emptied hub_install reads as every interface, the warned-about older behaviour", async () => {
    // Arrange — the table is there and empty, as a hand-run DELETE would leave it
    const db = await createDb();
    await db.execute(sql`DELETE FROM hub_install`);

    // Act + Assert
    expect(await readListenDefault(db)).toBe("all_interfaces");
  });

  test("members created before the install record are a restore; members created after are not", async () => {
    // Arrange
    const db = await createDb();
    await db.execute(sql`INSERT INTO developers (id, name, email, api_key_hash) VALUES ('dev_new','New','new@example.com','h1')`);
    const freshHub = await holdsMembersFromBeforeInstall(db);

    // Act — a row as a dump of an older hub carries it
    await db.execute(sql`
      INSERT INTO developers (id, name, email, api_key_hash, created_at)
      VALUES ('dev_old','Old','old@example.com','h2', now() - interval '90 days')`);
    const restored = await holdsMembersFromBeforeInstall(db);

    // Assert
    expect(freshHub).toBe(false);
    expect(restored).toBe(true);
  });
});

describe("serving the plan", () => {
  test("each address gets its own server, every one on the port the first was given", async () => {
    // Arrange
    const addresses = canListenAt("::1") ? ["127.0.0.1", "::1"] : ["127.0.0.1"];

    // Act
    const servers = serveOnPlan({ kind: "configured", addresses }, 0, okFetch);
    try {
      const answers = await Promise.all(
        servers.map(async (server) => (await fetch(server.url)).text()),
      );

      // Assert: bound where told, not on every interface
      expect(servers.map((server) => server.hostname)).toEqual(addresses);
      expect(new Set(servers.map((server) => server.port)).size).toBe(1);
      expect(answers).toEqual(addresses.map(() => "hub"));
    } finally {
      for (const server of servers) {
        server.stop(true);
      }
    }
  });

  test("a second address that fails after the first bound stops the first: no half-bound hub (review X8)", async () => {
    // Arrange — the same address twice: the first binds, the second meets EADDRINUSE
    let message = "";

    // Act
    try {
      serveOnPlan({ kind: "configured", addresses: ["127.0.0.1", "127.0.0.1"] }, 0, okFetch);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const port = Number(/on port (\d+)/.exec(message)?.[1] ?? "0");
    const answered = await fetch(`http://127.0.0.1:${String(port)}/`).then(
      () => true,
      () => false,
    );

    // Assert — the error names the port that was bound, and nothing answers on it
    expect(message).toContain("could not listen at 127.0.0.1");
    expect(port).toBeGreaterThan(0);
    expect(answered).toBe(false);
  });

  test("an address that cannot be bound stops the servers already started and names it", () => {
    // Arrange: a first server holds the address the plan names twice over
    const held = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: okFetch });
    const heldPort = held.port ?? 0;
    try {
      // Act + Assert
      expect(() =>
        serveOnPlan({ kind: "configured", addresses: ["127.0.0.1"] }, heldPort, okFetch),
      ).toThrow(`could not listen at 127.0.0.1 on port ${String(heldPort)}`);
    } finally {
      held.stop(true);
    }
  });
});
