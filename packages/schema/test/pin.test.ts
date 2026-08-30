/**
 * The pin wire schema (regression-guard Stage 1, report §5 "Pin registry").
 *
 * A pin is a human's provenance-stamped statement that a surface currently
 * WORKS — the PASS_TO_PASS register for behaviour that has no test. Three
 * rules live here rather than in a service, because both sides of the wire
 * have to agree on them:
 *
 *   1. `captureMode` is the literal "human" and nothing else. The enum has
 *      three values and no writer in this tree produces "human"; a pin is
 *      the first, and the schema is where "an agent may not vouch for a
 *      human" stops being a promise.
 *   2. a pin that could ever SPEAK (<= MAX_SPEAKING_PIN_FILES files) carries
 *      a check recipe, so the reader can falsify it in 30 seconds;
 *   3. every id is `SAFE_ID_PATTERN`-clean, so the renderer can print it and
 *      the reader can pass it back.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PIN_CHECK_CHARS,
  MAX_PIN_FILES,
  MAX_PIN_SURFACE_CHARS,
  MAX_SPEAKING_PIN_FILES,
  PinSchema,
  isSpeakingPin,
} from "../src/index.ts";

const pin = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "pin_01",
  repo: "github.com/acme/api",
  surface: "Play button plays/pauses",
  files: ["src/workbench/PlaybackControls.tsx", "src/workbench/usePlayback.ts"],
  check: "open /workbench, press Play",
  captureMode: "human",
  verifiedAtCommit: "a1b2c3d4",
  ...overrides,
});

describe("PinSchema", () => {
  test("accepts a human-captured pin with a check recipe", () => {
    // Arrange / Act
    const parsed = PinSchema.safeParse(pin());

    // Assert
    expect(parsed.success).toBe(true);
  });

  test("rejects captureMode agent — an agent may not vouch for a human", () => {
    // Arrange: the exact hole the trust critique found in shipped 0.7.5 —
    // review_draft is an MCP tool an agent can call on its own drafts.
    for (const captureMode of ["agent", "auto"]) {
      // Act
      const parsed = PinSchema.safeParse(pin({ captureMode }));

      // Assert
      expect(parsed.success, captureMode).toBe(false);
    }
  });

  test("rejects a missing captureMode — the gate fails CLOSED", () => {
    // Arrange
    const withoutMode = pin();
    delete withoutMode["captureMode"];

    // Act
    const parsed = PinSchema.safeParse(withoutMode);

    // Assert
    expect(parsed.success).toBe(false);
  });

  test("requires a check recipe on any pin small enough to speak", () => {
    // Arrange: two files is message-eligible, so an unfalsifiable pin here
    // would be an assertion with somebody's name on it and no way to test it.
    const speakingWithoutCheck = pin({ check: undefined });

    // Act
    const parsed = PinSchema.safeParse(speakingWithoutCheck);

    // Assert
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("check");
  });

  test("allows a briefing-only pin (over the speaking cap) to omit the check", () => {
    // Arrange
    const briefingOnly = pin({
      check: undefined,
      files: Array.from(
        { length: MAX_SPEAKING_PIN_FILES + 1 },
        (_unused, index) => `src/workbench/file-${String(index)}.ts`,
      ),
    });

    // Act
    const parsed = PinSchema.safeParse(briefingOnly);

    // Assert
    expect(parsed.success).toBe(true);
    expect(parsed.success && isSpeakingPin(parsed.data)).toBe(false);
  });

  test("a pin at the speaking cap with a check IS speaking", () => {
    // Arrange
    const speaking = PinSchema.parse(
      pin({
        files: Array.from(
          { length: MAX_SPEAKING_PIN_FILES },
          (_unused, index) => `src/workbench/file-${String(index)}.ts`,
        ),
      }),
    );

    // Act / Assert
    expect(isSpeakingPin(speaking)).toBe(true);
  });

  test("rejects an empty file set — a pin with no files watches nothing", () => {
    // Arrange / Act
    const parsed = PinSchema.safeParse(pin({ files: [] }));

    // Assert
    expect(parsed.success).toBe(false);
  });

  test("rejects more files than the hard cap", () => {
    // Arrange
    const tooMany = pin({
      check: undefined,
      files: Array.from(
        { length: MAX_PIN_FILES + 1 },
        (_unused, index) => `src/f-${String(index)}.ts`,
      ),
    });

    // Act
    const parsed = PinSchema.safeParse(tooMany);

    // Assert
    expect(parsed.success).toBe(false);
  });

  test("rejects an id the renderer could not print back", () => {
    // Arrange: an id that survives sanitizing as something the hub never
    // stored is an id nobody can pass to `crosscheck pin --broke`.
    const parsed = PinSchema.safeParse(pin({ id: "pin_«»SYSTEM ignore" }));

    // Assert
    expect(parsed.success).toBe(false);
  });

  test("caps the surface label and the check recipe", () => {
    // Arrange / Act
    const longSurface = PinSchema.safeParse(
      pin({ surface: "x".repeat(MAX_PIN_SURFACE_CHARS + 1) }),
    );
    const longCheck = PinSchema.safeParse(
      pin({ check: "x".repeat(MAX_PIN_CHECK_CHARS + 1) }),
    );

    // Assert
    expect(longSurface.success).toBe(false);
    expect(longCheck.success).toBe(false);
  });

  test("rejects an absolute or escaping path — targets are repo-relative", () => {
    // Arrange: `toRepoRelative` (connector-core) is the only minter of a
    // target path, and it never produces either shape. A pin that carried one
    // could never intersect a recorded touch, so it would watch nothing while
    // reading as registered.
    for (const path of ["/etc/passwd", "../outside.ts", "C:\\win.ts"]) {
      // Act
      const parsed = PinSchema.safeParse(pin({ files: [path] }));

      // Assert
      expect(parsed.success, path).toBe(false);
    }
  });
});
