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
 * PRINTS: 7 intent (claude-code),ghost (claude-code),summarizer (claude-code),conference (claude-code),event_seq (claude-code),intent timing events (claude-code),git lane blind spots (claude-code) 1
 */
export const claudeDoctorChecks = (): readonly ClaudeCheck[] => [
  ...CLAUDE_CAPABILITY_MANIFEST.capabilities.map((capability) =>
    check(
      "PASS",
      `${capability.name} (claude-code)`,
      `${capability.rung} — ${capability.sentence}`,
    ),
  ),
  // Rendered from the manifest, so a refusal added there prints here without
  // a second edit — a decision nobody can find is a bug. WHICH ones are live
  // is named by the directive above and deliberately not counted here, because
  // counting them here is how this block went stale: a refusal reached the
  // manifest, rendered correctly, and left a hand-written total above it that
  // said six while the function returned seven. They arrive by two routes. One
  // is carried by reference from core because the fact is about the MODEL and
  // holds on every host, so the three manifests cannot drift apart while it is
  // true. The other is this host's alone: it runs the only Stop-time git lane,
  // so this is the only section that has to say what that lane cannot see.
  ...CLAUDE_CAPABILITY_MANIFEST.refusals.map((refusal) =>
    check("PASS", `${refusal.name} (claude-code)`, refusal.sentence),
  ),
];
