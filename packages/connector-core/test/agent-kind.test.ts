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
  MAX_ACP_SESSION_ID_CHARS,
  MAX_AGENT_SLUG_CHARS,
  acpAgentKind,
  acpHostSessionKey,
  agentSlug,
  cursorHostSessionKey,
  safeAcpSessionId,
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

  test("a hostile multi-kilobyte agent name slugs to a bounded, delimiter-safe prefix", () => {
    // "a a a …" slugs to "a-a-a-…", and the cap lands mid-pattern — the
    // second edge strip must remove the cut's trailing dash so the `--`
    // delimiter's uniqueness argument (slug never ends with `-`) holds.
    const slug = agentSlug("a ".repeat(200));
    expect(slug.length).toBeLessThanOrEqual(MAX_AGENT_SLUG_CHARS);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.startsWith("a-a-a")).toBe(true);
  });
});

describe("safeAcpSessionId — agent-controlled ids, shaped before keys, logs and filenames", () => {
  test("ordinary ids pass through untouched", () => {
    expect(safeAcpSessionId("sess_abc123")).toBe("sess_abc123");
    expect(safeAcpSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  test("control, format and separator characters are removed — a newline cannot mint a log line", () => {
    // \n is Cc (the log-forging vector), ESC is Cc (terminal escapes), the
    // space is Zs and the zero-width space is Cf — all gone, nothing spaced.
    expect(safeAcpSessionId("sess\n_evil\u001b[31m id\u200b")).toBe(
      "sess_evil[31mid",
    );
  });

  test("an overlong id folds to a deterministic sha256 key that cannot overflow a filename", () => {
    const long = "x".repeat(MAX_ACP_SESSION_ID_CHARS + 100);
    const shaped = safeAcpSessionId(long);
    expect(shaped).toMatch(/^sha256-[0-9a-f]{64}$/);
    // Deterministic (replays land on the same key), distinct per raw id,
    // and idempotent (the digest re-shapes to itself).
    expect(safeAcpSessionId(long)).toBe(shaped ?? "");
    expect(safeAcpSessionId(`${long}y`)).not.toBe(shaped);
    expect(safeAcpSessionId(shaped ?? "")).toBe(shaped);
  });

  test("an id with nothing printable left is null — capture skips, never a degenerate key", () => {
    expect(safeAcpSessionId("\n\t \u200b")).toBeNull();
  });

  test("shaping is idempotent — a shaped id re-shapes to itself", () => {
    const shaped = safeAcpSessionId("sess evil\nid");
    expect(shaped).not.toBeNull();
    expect(safeAcpSessionId(shaped ?? "")).toBe(shaped);
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
