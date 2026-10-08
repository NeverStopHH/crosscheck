/**
 * `crosscheck confirm` and doctor's confirmation lines (human provenance §6,
 * §9): counts and the page URL, never a draft's content; honest about a hub
 * where no passkey can confirm anything; the RP-ID policy said plainly — a
 * passkey of another address cannot confirm here, and how to enrol for this one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import type { ConfirmStatus } from "@crosscheck/connector-core/http/confirm.ts";
import { EXIT_FAIL } from "@crosscheck/connector-core/constants.ts";

import { runCli } from "../src/index.ts";
import {
  CONFIRM_NOT_SERVED_LINE,
  HUB_MACHINE_ONLY_LINE,
  NO_HTTPS_LINE,
  confirmabilityLine,
  passkeyLine,
  pendingLine,
} from "../src/cli/confirm.ts";
import { confirmChecks } from "../src/cli/doctor-confirm.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const HUB = "https://hub.example.ts.net";

const status = (overrides: Partial<ConfirmStatus> = {}): ConfirmStatus => ({
  pending: 0,
  pendingByKind: {},
  humanConfirmation: "https",
  passkeys: { total: 1, atConfiguredRp: 1 },
  rpIds: ["hub.example.ts.net"],
  ...overrides,
});

describe("the confirm lines", () => {
  test("what waits is counted by kind; nothing waiting says so", () => {
    // Assert
    expect(pendingLine(status())).toBe("nothing waits for your passkey");
    expect(pendingLine(status({ pending: 4, pendingByKind: { outcome: 3, mute: 1 } }))).toBe(
      "4 drafts wait for your passkey: 3 ratings · 1 mute",
    );
  });

  test("a hub with no secure origin, or only localhost, says no person can confirm there", () => {
    // Assert
    expect(confirmabilityLine(status({ humanConfirmation: "none" }))).toBe(NO_HTTPS_LINE);
    expect(confirmabilityLine(status({ humanConfirmation: "hub_machine_only" }))).toBe(HUB_MACHINE_ONLY_LINE);
    expect(confirmabilityLine(status())).toBeNull();
  });

  test("the RP-ID policy: passkeys of another address cannot confirm here, and the line says how to enrol for this one", () => {
    // Act
    const elsewhere = passkeyLine(status({ passkeys: { total: 2, atConfiguredRp: 0 } }), HUB);
    const none = passkeyLine(status({ passkeys: { total: 0, atConfiguredRp: 0 } }), HUB);

    // Assert
    expect(elsewhere).toBe(
      "your passkeys belong to another address than this hub's (hub.example.ts.net), so none of them can confirm here — enrol one at https://hub.example.ts.net/ui/passkeys with a code from the admin",
    );
    expect(none).toContain("you have no passkey yet: enrol one at https://hub.example.ts.net/ui/passkeys");
    expect(passkeyLine(status(), HUB)).toBeNull();
  });
});

describe("doctor's confirmation lines", () => {
  test("no secure origin, a passkey of another address, and waiting drafts are WARNs", () => {
    // Act
    const checks = confirmChecks(
      {
        ok: true,
        dateHeader: null,
        data: status({ humanConfirmation: "none", pending: 1, pendingByKind: { label: 1 }, passkeys: { total: 1, atConfiguredRp: 0 } }),
      },
      HUB,
    );

    // Assert
    expect(checks.map((check) => [check.level, check.name])).toEqual([
      ["WARN", "human confirmation"],
      ["WARN", "confirming passkey"],
      ["WARN", "drafts"],
    ]);
    expect(checks[0]?.detail).toBe(NO_HTTPS_LINE);
  });

  test("a hub that answered with an error is a WARN; one unreachable is not measured, as on every hub-read line", () => {
    // Act
    const failed = confirmChecks({ ok: false, kind: "http", status: 500, code: "internal", message: "boom" }, HUB);
    const unreachable = confirmChecks({ ok: false, kind: "network", status: 0, code: "network", message: "refused" }, HUB);

    // Assert — the reachability line already counts an outage; it is never counted twice
    expect(failed.map((check) => check.level)).toEqual(["WARN"]);
    expect(unreachable.map((check) => [check.level, check.detail])).toEqual([
      ["PASS", "not measured (the hub could not be reached)"],
    ]);
  });
});

describe("crosscheck confirm against an older hub", () => {
  let oldHub: ReturnType<typeof Bun.serve>;
  let repo: string;
  let home: string;

  beforeAll(async () => {
    oldHub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ok: false, error: { code: "not_found", message: "route not found" } }, { status: 404 }),
    });
    repo = await makeRepo("confirm-cli", { remote: "git@github.com:acme/api.git" });
    home = await makeHome("confirm-cli");
  });

  afterAll(async () => {
    oldHub.stop(true);
    await Promise.all([repo, home].map((path) => rm(path, { recursive: true, force: true })));
  });

  test("says the hub predates confirmation, and opens nothing", async () => {
    // Arrange
    const opened: string[] = [];

    // Act
    const result = await runCli(
      ["confirm"],
      { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(oldHub.port)}`, CROSSCHECK_API_KEY: "k", CROSSCHECK_TIMEOUT_MS: "2000" },
      repo,
      undefined,
      { openUrl: async (url) => { opened.push(url); return true; } },
    );

    // Assert
    expect(result.exitCode).toBe(EXIT_FAIL);
    expect(result.stdout).toBe(`${CONFIRM_NOT_SERVED_LINE}\n`);
    expect(opened).toEqual([]);
  });
});
