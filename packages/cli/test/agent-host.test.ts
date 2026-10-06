/**
 * Deny-only agent-host markers (07 §13.14, round-6 MEDIUM-2).
 *
 * A host that runs its agent's commands in a pty passes the TTY gate as the
 * person. The markers such a host documents for the commands its agent runs
 * demote the word to the agent's route; nothing in the environment ever
 * promotes one. Each marker here is one the host's own docs or source name.
 */
import { describe, expect, test } from "bun:test";

import { AGENT_HOST_MARKERS, agentHostMarkerIn } from "../src/cli/agent-host.ts";

describe("agentHostMarkerIn", () => {
  test.each([
    ["CLAUDECODE", "1"],
    ["CURSOR_AGENT", "1"],
    ["GEMINI_CLI", "1"],
    ["CODEX_SANDBOX", "seatbelt"],
    ["CODEX_SANDBOX_NETWORK_DISABLED", "1"],
  ] as const)("%s=%s, as its host sets it, is an agent host's marker", (name, value) => {
    // Act
    const marker = agentHostMarkerIn({ HOME: "/home/nick", [name]: value });

    // Assert
    expect(marker).toBe(name);
  });

  test("the list is exactly the confirmed markers", () => {
    // Assert — adding one is a decision with a source, never a guess
    expect([...AGENT_HOST_MARKERS]).toEqual([
      "CLAUDECODE",
      "CURSOR_AGENT",
      "GEMINI_CLI",
      "CODEX_SANDBOX",
      "CODEX_SANDBOX_NETWORK_DISABLED",
    ]);
  });

  test("a person's own shell, with no marker, has none", () => {
    // Act
    const marker = agentHostMarkerIn({ HOME: "/home/nick", PATH: "/usr/bin", TERM: "xterm-256color" });

    // Assert
    expect(marker).toBeNull();
  });

  test("an empty marker is no marker", () => {
    // Act
    const marker = agentHostMarkerIn({ CLAUDECODE: "", CURSOR_AGENT: undefined });

    // Assert
    expect(marker).toBeNull();
  });

  test("variables a host sets in the person's own terminal too are never markers", () => {
    // Act — VS Code's, Zed's and Cursor's integrated terminals carry these for the person as well
    const marker = agentHostMarkerIn({ TERM_PROGRAM: "vscode", ZED_TERM: "true", CURSOR_TRACE_ID: "abc" });

    // Assert
    expect(marker).toBeNull();
  });
});
