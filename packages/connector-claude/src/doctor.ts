/**
 * WHAT CROSSCHECK INFERS INSIDE CLAUDE CODE, printed as sentences.
 *
 * The reference host's row in the parity table, and for a long time the one
 * row missing from doctor: the manifest was declared, exported and pinned by
 * the registry meta-test, but nothing rendered it, so `crosscheck doctor` on
 * a Claude Code machine printed no rung lines at all while a Cursor machine
 * printed four rungs and five refusals. "What does my host derive" has to be
 * answerable on every host or the table is decoration.
 *
 * NO COUNTS ON THESE LINES, deliberately, and this is the one place the
 * Claude section differs from its Cursor and ACP twins. Claude Code already
 * has three dedicated cost lines in `doctor` (`summarizer cost`, `intent
 * cost`, `ghost cost`) that carry the booked fires and failures; repeating
 * them here would print every number twice and give a reader two places to
 * reconcile. These lines answer the PLATFORM question — what this host lets
 * crosscheck infer at all — and the cost lines answer what happened.
 */
import { CLAUDE_CAPABILITY_MANIFEST } from "./capabilities.ts";

export interface ClaudeCheck {
  readonly level: "PASS" | "WARN" | "FAIL";
  readonly name: string;
  readonly detail: string;
}

const check = (
  level: ClaudeCheck["level"],
  name: string,
  detail: string,
): ClaudeCheck => ({ level, name, detail });

/**
 * One line per declared capability and one per declared refusal — the same
 * shape the Cursor and ACP sections render, so the three rows of the parity
 * table read alike.
 *
 * Takes no arguments: unlike the other two, nothing here depends on this
 * machine's state. A rung is a property of the HOST, and every Claude Code
 * rung is full by construction (the hooks carry what the workers need), so
 * these sentences are the same on every Claude machine.
 *
 * VERIFY: bun -e 'const {claudeDoctorChecks:c}=await import("./packages/connector-claude/src/doctor.ts");console.log(c().length, c().map(l=>l.name).join(","), new Set(c().map(l=>l.level)).size)'
 * PRINTS: 4 intent (claude-code),ghost (claude-code),summarizer (claude-code),conference (claude-code) 1
 */
export const claudeDoctorChecks = (): readonly ClaudeCheck[] => [
  ...CLAUDE_CAPABILITY_MANIFEST.capabilities.map((capability) =>
    check(
      "PASS",
      `${capability.name} (claude-code)`,
      `${capability.rung} — ${capability.sentence}`,
    ),
  ),
  // Empty today: Claude Code is the host nothing is refused on. Rendered
  // anyway so that adding a refusal to the manifest prints it here without a
  // second edit — a decision nobody can find is a bug (rule 4).
  ...CLAUDE_CAPABILITY_MANIFEST.refusals.map((refusal) =>
    check("PASS", `${refusal.name} (claude-code)`, refusal.sentence),
  ),
];
