/**
 * Block 4's live-hub proof (§4.2 layers 2+3 combined): the REAL proxy binary
 * wrapping the scripted fake agent, against a REAL in-process hub. One
 * session flows end to end — the session registers on the hub, targets land
 * repo-relative, the failure fingerprint equals the Claude connector's for
 * the same bytes, and proxy exit ends the session (§2.2 lifecycle: child
 * exit → budgeted flush + endSession).
 *
 * The Block 3 byte-transparency proofs live in transparency.test.ts /
 * proxy-e2e.test.ts and are deliberately NOT restated here — this file only
 * ADDS the capture half on top of the same spawn plumbing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDb, createServer } from "@crosscheck/server";

import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { fingerprint } from "@crosscheck/connector-core/capture/fingerprint.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { getDiagnosis, getPresence } from "@crosscheck/connector-core/http/hub.ts";
import type { HubContext } from "@crosscheck/connector-core/http/client.ts";
import { makeRepo, writeRepoFile } from "../../connector-core/test/helpers.ts";
import {
  collectDrive,
  makeTempHome,
  spawnProxy,
} from "./fixtures/e2e-helpers.ts";
import type { DriveStep } from "./fixtures/e2e-helpers.ts";

const ADMIN_TOKEN = "acp-proxy-capture-admin";
const REPO_ID = "github.com/acme/api";
const REMOTE = "git@github.com:acme/api.git";
const TIMEOUT_MS = "4000";
const FAILURE_TEXT =
  "error TS2304: cannot find name 'limiter' at build step 7 of the pipeline";
/** The fake agent's fixed session id and the derived crosscheck identity. */
const ACP_SESSION_ID = "sess_fake_1";
const HOST_KEY = `acp-fake-agent--${ACP_SESSION_ID}`;

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let apiKey: string;
let home: string;
let repo: string;
let updatesPath: string;
const cleanups: string[] = [];

const hub = (): HubContext => ({
  hubUrl,
  apiKey,
  timeoutMs: Number(TIMEOUT_MS),
  home,
  repoKey: repoKey(hubUrl, REPO_ID),
  now: () => new Date(),
});

beforeAll(async () => {
  const db = await createDb();
  const app = createServer({ db, adminToken: ADMIN_TOKEN });
  server = Bun.serve({ port: 0, fetch: app.fetch });
  hubUrl = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Proxy Dev", email: "acp-proxy@example.com" }),
  });
  const body = (await response.json()) as { data: { apiKey: string } };
  apiKey = body.data.apiKey;

  home = await makeTempHome();
  repo = await makeRepo("proxy-capture", { remote: REMOTE });
  await writeRepoFile(repo, "src/limiter.ts", "export const a = 1;\n");
  cleanups.push(home, repo);

  // The agent's scripted §2.4 traffic: an edit tool call with a location, a
  // failed update with rawOutput, and an fs write — streamed verbatim by the
  // fake agent inside the prompt turn.
  updatesPath = join(home, "updates.ndjson");
  await writeFile(
    updatesPath,
    [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: ACP_SESSION_ID,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_1",
            kind: "edit",
            status: "in_progress",
            locations: [{ path: join(repo, "src/limiter.ts") }],
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: ACP_SESSION_ID,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_1",
            status: "failed",
            rawOutput: { stderr: FAILURE_TEXT },
          },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 90,
        method: "fs/write_text_file",
        params: {
          sessionId: ACP_SESSION_ID,
          path: join(repo, "src/written.ts"),
          content: "export const b = 2;\n",
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("the real proxy against the real hub", () => {
  test("the session registers, targets land, the fingerprint matches Claude's, exit ends the session", async () => {
    // Arrange: client script — initialize, session/new in the connected
    // repo, one prompt whose turn carries the scripted updates (3 extra
    // lines + thinking/done/result).
    const steps: readonly DriveStep[] = [
      {
        send: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n',
        untilLines: 1,
      },
      {
        send: `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: repo, mcpServers: [] },
        })}\n`,
        untilLines: 2,
      },
      {
        send: `${JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: {
            sessionId: ACP_SESSION_ID,
            prompt: [{ type: "text", text: "fix the limiter" }],
          },
        })}\n`,
        untilLines: 8,
      },
    ];
    const proc = spawnProxy(home, [], ["--updates-file", updatesPath], {
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: apiKey,
      CROSSCHECK_TIMEOUT_MS: TIMEOUT_MS,
    });

    // Act: drive the whole conversation to EOF, then wait for the proxy's
    // faithful exit (which includes the capture drain).
    await collectDrive(proc, steps);
    const exitCode = await proc.exited;

    // Assert: transparent exit
    expect(exitCode).toBe(0);

    // The work context landed on the hub with the honest title — the
    // register ran during the session (presence), and the exit drain
    // flushed the rest.
    const diagnosis = await getDiagnosis(hub(), `wc_cc_${HOST_KEY}`);
    if (!diagnosis.ok) throw new Error("diagnosis unavailable");
    expect(diagnosis.data.workContext.title).toBe("main @ api");

    // Targets: the tool-call location and the fs write, repo-relative
    const files = diagnosis.data.targets
      .filter((target) => target.kind === "file")
      .map((target) => target.value)
      .sort();
    expect(files).toEqual(["src/limiter.ts", "src/written.ts"]);

    // Fingerprint parity with the Claude connector's path over the same bytes
    const viaClaudePath = fingerprint(extractFailureText({ stderr: FAILURE_TEXT }));
    const prints = diagnosis.data.targets
      .filter((target) => target.kind === "error_fingerprint")
      .map((target) => target.value);
    expect(prints).toEqual([viaClaudePath ?? ""]);

    // §2.2 lifecycle: proxy exit ended the session — presence is empty
    const presence = await getPresence(hub(), REPO_ID);
    if (!presence.ok) throw new Error("presence unavailable");
    expect(
      presence.data.some((entry) => entry.sessionId === `cc_${HOST_KEY}`),
    ).toBe(false);
  }, 30_000);
});
