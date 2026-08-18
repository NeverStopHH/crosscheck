/**
 * Block 2 connector identity (DESIGN-agent-agnostic.md §1.3): every connector
 * declares its kind, and host session keys carry a connector prefix so two
 * hosts can never mint colliding keys — while Claude Code's keys stay the RAW
 * session id (no prefix), which is what keeps every existing spool, state file
 * and cc_<uuid> byte-identical across the upgrade (identity-compat.test.ts
 * pins that half).
 *
 * The shapes are the design's own: `acp-<agentSlug>-<acpSessionId>`,
 * `cur-<conversation_id>`, agent kinds `claude-code` (default, unchanged),
 * `acp:<agentInfo.name>` with fallback `acp:unknown`, and `cursor-ide`.
 */
import { describe, expect, test } from "bun:test";

import { DEFAULT_AGENT_KIND } from "../src/constants.ts";
import { loadConfig } from "../src/config/config.ts";
import { crosscheckSessionIdFor } from "../src/state/session-state.ts";
import {
  ACP_AGENT_KIND_FALLBACK,
  CURSOR_AGENT_KIND,
  acpAgentKind,
  acpHostSessionKey,
  agentSlug,
  cursorHostSessionKey,
} from "../src/state/host-session-key.ts";
import { makeHome } from "./helpers.ts";

describe("connector host-session-key prefixes", () => {
  test("ACP keys carry the acp- prefix, the slugged agent name, and the -- delimiter", () => {
    // Act + Assert: the design's worked example, with the slug/id boundary
    // marked by `--` — a run a slug can never contain (single dashes only, no
    // edge dashes), so the key parses back to exactly one (slug, id) pair.
    const key = acpHostSessionKey("Gemini CLI", "sess_abc123");
    expect(key).toBe("acp-gemini-cli--sess_abc123");
    expect(crosscheckSessionIdFor(key)).toBe("cc_acp-gemini-cli--sess_abc123");
  });

  test("two ACP hosts can never mint the same key across the slug/id boundary", () => {
    // Arrange: without a delimiter these two collide on acp-gemini-cli-x and
    // would merge two sessions' spools, state files and cc_ ids.
    const pairs: readonly (readonly [string, string])[] = [
      ["Gemini", "cli-x"],
      ["Gemini CLI", "x"],
      ["Gemini", "-x"],
      ["Gemini", "cli--x"],
      ["Gemini CLI", "-x"],
    ];

    // Act
    const keys = pairs.map(([name, id]) => acpHostSessionKey(name, id));

    // Assert: all distinct — the delimiter makes the parse unique because a
    // slug never contains `--` and never ends with `-`.
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("Cursor keys carry the cur- prefix around the raw conversation id", () => {
    expect(cursorHostSessionKey("conv_42")).toBe("cur-conv_42");
  });

  test("agent names slug to lowercase alphanumerics with single dashes", () => {
    // Arrange + Act + Assert
    expect(agentSlug("Gemini CLI")).toBe("gemini-cli");
    expect(agentSlug("cursor-agent")).toBe("cursor-agent");
    expect(agentSlug("  Goose!! v2  ")).toBe("goose-v2");
    // Empty and all-symbol names fall to the design's unknown slug.
    expect(agentSlug("")).toBe("unknown");
    expect(agentSlug("«»``")).toBe("unknown");
  });
});

describe("agent_kind declaration", () => {
  test("ACP kinds are acp:<slugged name>, falling back to acp:unknown", () => {
    expect(acpAgentKind("Gemini CLI")).toBe("acp:gemini-cli");
    expect(acpAgentKind(undefined)).toBe(ACP_AGENT_KIND_FALLBACK);
    expect(acpAgentKind("")).toBe(ACP_AGENT_KIND_FALLBACK);
    expect(CURSOR_AGENT_KIND).toBe("cursor-ide");
  });

  test("loadConfig takes the connector's declared kind, default claude-code", async () => {
    // Arrange: a usable config from env alone, no stored file.
    const home = await makeHome("agent-kind");
    const env = {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: "https://hub.example.com",
      CROSSCHECK_API_KEY: "test-key",
    };

    // Act
    const claudeDefault = await loadConfig({ env });
    const declared = await loadConfig({ env, defaultAgentKind: "acp:gemini-cli" });
    const envWins = await loadConfig({
      env: { ...env, CROSSCHECK_AGENT_KIND: "acp:override" },
      defaultAgentKind: "acp:gemini-cli",
    });

    // Assert: DEFAULT stays claude-code; a connector's declaration fills the
    // gap; the operator env override outranks both.
    expect(claudeDefault?.agentKind).toBe(DEFAULT_AGENT_KIND);
    expect(DEFAULT_AGENT_KIND).toBe("claude-code");
    expect(declared?.agentKind).toBe("acp:gemini-cli");
    expect(envWins?.agentKind).toBe("acp:override");
  });
});
