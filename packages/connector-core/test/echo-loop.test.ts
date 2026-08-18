/**
 * Echo-loop exclusion (DESIGN.md §3): a claim body that arrived in this
 * session as a teammate hint cannot be re-published as the session's own
 * independent claim. The capture path with agent-authored free text is
 * publish_claim, so the marker bites there.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { prepareMcp } from "../src/mcp/context.ts";
import type { McpContext } from "../src/mcp/context.ts";
import { run as runPublishClaim } from "../src/mcp/tools/publish-claim.ts";
import { hintBodyHash } from "../src/hints/echo.ts";
import { writeSessionState } from "../src/state/session-state.ts";
import { makeHome, makeRepo } from "./helpers.ts";
import { CANDIDATE_BODY, startHintHub } from "./fixtures/hint-hub.ts";
import type { HintHub } from "./fixtures/hint-hub.ts";

const REPO_ID = "github.com/acme/api";
const SESSION_ID = "echo-uuid";

const paths: string[] = [];
const hubs: HintHub[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
  for (const hub of hubs) {
    hub.stop();
  }
  hubs.length = 0;
});

const fixture = async (label: string): Promise<McpContext> => {
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  const hub = startHintHub();
  hubs.push(hub);
  await writeSessionState(home, {
    claudeSessionId: SESSION_ID,
    crosscheckSessionId: `cc_${SESSION_ID}`,
    workContextId: `wc_cc_${SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: repo,
    hubUrl: hub.url,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: null,
    seenTargets: [],
    deliveredHintRefs: ["clm_rejected"],
    deliveredHintHashes: [hintBodyHash(CANDIDATE_BODY)],
    tripwireAskedFiles: [],
  });
  const setup = await prepareMcp(
    {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
    },
    repo,
  );
  if (!setup.ok) {
    throw new Error(`mcp setup failed: ${setup.message}`);
  }
  return setup.ctx;
};

const textOf = (result: { content: readonly { text?: string }[] }): string =>
  result.content.map((entry) => entry.text ?? "").join("\n");

describe("publish_claim refuses to re-capture delivered hint content", () => {
  test("a verbatim echo of a hinted body is refused with a pointer to extend_diagnosis", async () => {
    // Arrange
    const ctx = await fixture("echo");

    // Act — the model repeats the hint as its "own" observation
    const result = await runPublishClaim(ctx, {
      kind: "observation",
      body: CANDIDATE_BODY,
    });

    // Assert
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("hint");
    expect(textOf(result)).toContain("extend_diagnosis");
  });

  test("a case/whitespace-mangled echo is still an echo", async () => {
    // Arrange
    const ctx = await fixture("mangled");

    // Act
    const result = await runPublishClaim(ctx, {
      kind: "observation",
      body: `  ${CANDIDATE_BODY.toUpperCase().replace(/ /g, "   ")}  `,
    });

    // Assert — the marker normalizes the way the hub's dedup normalizes
    expect(result.isError).toBe(true);
  });

  test("the session's own genuine observation still publishes", async () => {
    // Arrange
    const ctx = await fixture("genuine");

    // Act
    const result = await runPublishClaim(ctx, {
      kind: "observation",
      body: "The 500 stops when the rotated key is present in the JWKS cache",
    });

    // Assert — refusal is scoped to echoes, not a new gate on publishing
    expect(result.isError).not.toBe(true);
  });
});
