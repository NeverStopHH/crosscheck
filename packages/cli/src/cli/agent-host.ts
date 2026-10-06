/**
 * DENY-ONLY AGENT-HOST MARKERS (1.0 spec 07 §13.14, round-6 MEDIUM-2).
 *
 * The TTY gate asks whether this command's input is a terminal. A host that
 * runs its agent's commands in a pty — Cursor's agent terminal, Gemini CLI's
 * interactive shell — answers yes, so the agent passed as the person. Such a
 * host sets a variable of its own on the commands its agent runs; finding one
 * DEMOTES the word to the agent's route. Nothing here ever promotes a word:
 * an environment is something any agent can write, so it may take the
 * person's door away and can never open it.
 *
 * Only markers a host's own docs or source name, for the commands ITS AGENT
 * runs. A variable the host also sets in the person's own terminal
 * (TERM_PROGRAM, ZED_TERM, CURSOR_TRACE_ID) is no marker: it would take every
 * person's door away inside that editor.
 */

type Env = Readonly<Record<string, string | undefined>>;

export const AGENT_HOST_MARKERS = [
  // Claude Code, CLI and IDE extensions: every command its tools and `!` run carry CLAUDECODE=1
  // (measured 2026-08-30, connector-core model/runner.ts; seen in this repo's own agent shells).
  "CLAUDECODE",
  // Cursor, IDE agent and CLI: the agent's terminal sets it (cursor.com/docs/agent/tools/terminal;
  // the CLI's CURSOR_AGENT=1 confirmed by Cursor staff, forum.cursor.com/t/132427).
  "CURSOR_AGENT",
  // Gemini CLI: run_shell_command sets GEMINI_CLI=1, its node-pty mode included (docs/tools/shell.md).
  "GEMINI_CLI",
  // Codex: a command it spawns under its sandbox ("seatbelt" on macOS), and a shell tool call with the
  // network restricted (codex-rs/core/src/spawn.rs). Neither under danger-full-access.
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
] as const;

export type AgentHostMarker = (typeof AGENT_HOST_MARKERS)[number];

/** The first agent-host marker this environment carries, or null: a person's own shell has none. */
export const agentHostMarkerIn = (env: Env): AgentHostMarker | null =>
  AGENT_HOST_MARKERS.find((name) => (env[name] ?? "") !== "") ?? null;

/** Whose hands are on a person-only gesture, and — when a marker took the door away — which. */
export interface PersonGate {
  /** A person at a terminal with no agent-host marker: the only answer that opens a person-only door. */
  readonly isPerson: boolean;
  /** The marker that demoted this command, or null (no marker; then the terminal probe decided). */
  readonly marker: AgentHostMarker | null;
}

/**
 * THE ONE PERSON GATE (07 §13.14, round-6 follow-up). Every person-only gesture — followed / overrode,
 * noise, helpful, the label walk, pin, pin --ok, pin --broke, key rotate — asks this, never the probe
 * alone, so a new gesture cannot forget the markers. A marker answers "no person" whatever the probe
 * says; with none, the probe decides. Nothing here can answer "person" that the probe did not.
 */
export const personGate = (env: Env, isInteractive: () => boolean): PersonGate => {
  const marker = agentHostMarkerIn(env);
  return marker === null ? { isPerson: isInteractive(), marker } : { isPerson: false, marker };
};

/** Said first when a marker refused a person-only gesture; nothing when no marker did. */
export const agentHostRefusalLine = (gate: PersonGate): string =>
  gate.marker === null
    ? ""
    : `this command ran inside an agent's tool (${gate.marker} is set), so its terminal is the agent's, not yours\n`;
