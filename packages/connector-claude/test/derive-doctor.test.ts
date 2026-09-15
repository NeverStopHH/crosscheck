/**
 * THE REFERENCE ROW, on the only surface that describes THIS machine.
 *
 * Every connector declares what it can infer (capabilities.ts), and doctor
 * renders that declaration per host so "is anything being derived for me" has
 * an answer. Cursor and ACP were rendered from the day their manifests
 * existed. Claude Code's — the manifest every other connector's rungs are
 * READ AGAINST — was declared, exported, pinned by the registry meta-test,
 * and never printed anywhere.
 *
 * The effect was a parity table with a hole exactly where the reference
 * belongs: a developer on Claude Code saw no rung lines at all, while a
 * teammate on Cursor saw four rungs and five refusals.
 */
import { describe, expect, test } from "bun:test";

import { CLAUDE_CAPABILITY_MANIFEST } from "../src/capabilities.ts";
import { claudeDoctorChecks } from "../src/doctor.ts";

interface Line {
  readonly name: string;
  readonly level: string;
  readonly detail: string;
}

const named = (checks: readonly Line[], name: string): Line | undefined =>
  checks.find((entry) => entry.name === name);

describe("the Claude derive section", () => {
  test("every declared rung is printed with its rung word and its sentence", () => {
    // Act
    const checks = claudeDoctorChecks();

    // Assert — nothing declared may be missing, and nothing may be a code
    for (const capability of CLAUDE_CAPABILITY_MANIFEST.capabilities) {
      const line = named(checks, `${capability.name} (claude-code)`);
      expect(line, capability.name).toBeDefined();
      expect(line?.level).toBe("PASS");
      expect(line?.detail).toContain(capability.rung);
      expect(line?.detail).toContain(capability.sentence);
    }
  });

  test("every declared refusal is printed, and nothing is invented", () => {
    const checks = claudeDoctorChecks();

    // Claude Code was for a long time the host nothing was refused on, and
    // this assertion existed to make whoever added the first refusal render it
    // here too. The causal order added it: this host runs the ONLY Stop-time
    // git lane, and that lane cannot see work committed during the turn or
    // untracked new files — a blind spot that has to travel beside the
    // positions it produces, because an `observed` position is an upper bound
    // partly for that reason.
    expect(CLAUDE_CAPABILITY_MANIFEST.refusals.length).toBeGreaterThan(0);
    for (const refusal of CLAUDE_CAPABILITY_MANIFEST.refusals) {
      const line = named(checks, `${refusal.name} (claude-code)`);
      expect(line, refusal.name).toBeDefined();
      expect(line?.level).toBe("PASS");
      expect(line?.detail).toContain(refusal.sentence);
    }
    expect(checks).toHaveLength(
      CLAUDE_CAPABILITY_MANIFEST.capabilities.length +
        CLAUDE_CAPABILITY_MANIFEST.refusals.length,
    );
  });

  test("the rungs are the ones the other connectors are read against", () => {
    const checks = claudeDoctorChecks();
    expect(checks.map((entry) => entry.name)).toEqual([
      "intent (claude-code)",
      "ghost (claude-code)",
      "summarizer (claude-code)",
      "conference (claude-code)",
      "event_seq (claude-code)",
      "intent timing events (claude-code)",
      "git lane blind spots (claude-code)",
    ]);
  });
});
