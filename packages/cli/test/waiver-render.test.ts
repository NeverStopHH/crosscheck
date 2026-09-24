/**
 * Where an open fence is allowed to say WHY, and where it is not (04 §5).
 *
 * Three surfaces carry a waiver and they are not the same class:
 *
 *   `pin list`  framed — granter, expiry AND reason, because the command
 *               exists to show what is watched and on whose word;
 *   `suspect`   framed — the same, inside the verdict block;
 *   `status` /  BARE — a count and an instant, and never a teammate's
 *   `doctor`    sentence, because that registration is a promise these two
 *               surfaces make about every line they print.
 *
 * THE BARE ONE IS THE TEST THAT MATTERS. A reason leaking onto `status` would
 * not look like a bug — it would look like helpfulness — and the corpus would
 * not catch it, because the corpus asserts CHARACTER classes and a sanitized
 * reason carries none of the forbidden ones. So it is asserted here by name.
 */
import { describe, expect, test } from "bun:test";

import type {
  PinEntry,
  PinRegistry,
} from "@crosscheck/connector-core/http/hub.ts";

import { renderPinList } from "../src/cli/pin-render.ts";
import { pinStatusLines } from "../src/cli/pin-observability.ts";

const NOW = new Date("2026-09-12T09:00:00.000Z");
/** FUTURE instants — an open fence points forward, unlike every other stamp. */
const EXPIRY = "2026-09-14T09:00:00.000Z";
const LATER = "2026-09-20T09:00:00.000Z";
const REASON = "Rollout is blocked; the fix lands Monday";
const REPO = "github.com/acme/api";

const pin = (over: Partial<PinEntry> = {}): PinEntry => ({
  id: "pin_11111111-2222-4333-8444-555555555555",
  repo: REPO,
  surface: "playback keeps working",
  files: [{ path: "src/player.ts", status: "present" }],
  check: "bun test packages/server/test/auth.test.ts",
  captureMode: "human",
  verifiedById: "dev_nick",
  verifiedByName: "Nick",
  verifiedAtCommit: "a1b2c3d",
  verifiedAt: "2026-09-11T09:00:00.000Z",
  brokeAt: null,
  brokeByName: null,
  speaking: true,
  missingPaths: 0,
  renamedPaths: 0,
  renamedAt: null,
  renamedByName: null,
  liveWaiver: null,
  ...over,
});

const registry = (pins: readonly PinEntry[]): PinRegistry => ({
  pins: [...pins],
  coverage: {
    pins: pins.length,
    files: pins.length,
    speaking: pins.length,
    broken: 0,
    missingPaths: 0,
    oldestVerifiedAt: "2026-09-11T09:00:00.000Z",
  },
});

const waived = (expiresAt: string, reason: string = REASON): PinEntry =>
  pin({
    liveWaiver: {
      id: "fw_11111111-2222-4333-8444-555555555555",
      pinVersion: 1,
      expiresAt,
      reason,
      grantedByName: "Nick",
    },
  });

describe("crosscheck pin list — the guard AND its exception", () => {
  test("names the granter, the deadline and the reason", () => {
    // Arrange & Act
    const rendered = renderPinList(REPO, registry([waived(EXPIRY)]), NOW);

    // Assert
    expect(rendered).toContain("WAIVED by Nick");
    expect(rendered).toContain(EXPIRY);
    expect(rendered).toContain(`«${REASON}»`);
  });

  test("the expiry counts FORWARD — an open fence has not passed", () => {
    // Arrange — `ageOf` measures now - then and says "ago", which is right for
    // every other stamp on the row and exactly wrong for this one.
    const rendered = renderPinList(REPO, registry([waived(EXPIRY)]), NOW);
    const line = rendered.split("\n").find((row) => row.includes("WAIVED by"));

    // Assert
    expect(line).toContain("in 2d");
    expect(line).not.toContain("ago");
  });

  test("the reason gets its own line — one frame per line", () => {
    // Arrange & Act
    const rendered = renderPinList(REPO, registry([waived(EXPIRY)]), NOW);

    // Assert
    for (const line of rendered.split("\n")) {
      expect(line.split("«").length).toBeLessThanOrEqual(2);
    }
  });

  test("a pin with no live waiver prints no waiver lines at all", () => {
    // Arrange & Act
    const rendered = renderPinList(REPO, registry([pin()]), NOW);

    // Assert
    expect(rendered).not.toContain("WAIVED");
    expect(rendered).not.toContain("their reason");
  });
});

describe("status and doctor stay BARE — the registration is a promise", () => {
  test("a reason NEVER reaches the bare surface", () => {
    // Arrange & Act
    const text = pinStatusLines(
      registry([waived(EXPIRY)]),
      [],
      null,
      NOW,
    ).join("\n");

    // Assert — the whole reason this surface is a separate module
    expect(text).not.toContain(REASON);
    expect(text).not.toContain("«");
    expect(text).not.toContain("Nick");
  });

  test("but the COUNT and the deadline do — silence would hide the silencer", () => {
    // Arrange — an open fence suppresses a PROTECTED_CONFLICT, so a status
    // that said nothing would report the repo as quiet BECAUSE somebody
    // silenced it.
    const text = pinStatusLines(
      registry([waived(EXPIRY)]),
      [],
      null,
      NOW,
    ).join("\n");

    // Assert
    expect(text).toContain("1 live waiver(s)");
    expect(text).toContain(EXPIRY);
    expect(text).toContain("crosscheck pin list");
  });

  test("the EARLIEST expiry is named, not the latest", () => {
    // Arrange — the next moment this answer can change on its own
    const text = pinStatusLines(
      registry([waived(LATER), waived(EXPIRY)]),
      [],
      null,
      NOW,
    ).join("\n");

    // Assert
    expect(text).toContain("2 live waiver(s)");
    expect(text).toContain(`next expires ${EXPIRY}`);
  });

  test("no open fence, no line", () => {
    // Arrange & Act
    const lines = pinStatusLines(registry([pin()]), [], null, NOW);

    // Assert
    expect(lines.join("\n")).not.toContain("live waiver");
  });
});
