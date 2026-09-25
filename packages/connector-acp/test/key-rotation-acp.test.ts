/**
 * A RUNNING ACP SESSION KEEPS CAPTURING THROUGH A KEY ROTATION.
 *
 * The proxy builds one hub context when an agent session registers and keeps
 * it for the whole session. `crosscheck key rotate` kills the old key at once
 * and writes the new one to the stored config — so without a way to pick it
 * up, every capture after the rotation is refused until the agent restarts,
 * and the team sees nothing of that session's work. This drives a real hub:
 * register with the old key, rotate, then edit — and the edit must arrive.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { saveConfig } from "@crosscheck/connector-core/config/config.ts";
import { getDiagnosis } from "@crosscheck/connector-core/http/hub.ts";
import { writeRepoFile } from "../../connector-core/test/helpers.ts";
import {
  bootCaptureHub,
  createHarness,
  handshake,
  toolCallUpdate,
} from "./fixtures/capture-harness.ts";
import type { CaptureHub } from "./fixtures/capture-harness.ts";

let hub: CaptureHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await bootCaptureHub("acp-rotation");
});

afterAll(async () => {
  hub.server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/** A developer of this test's own, so rotating their key disturbs nobody else. */
const newDeveloperKey = async (email: string): Promise<string> => {
  const response = await fetch(`${hub.hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: "Bearer acp-rotation-admin", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Rotating Dev", email }),
  });
  return ((await response.json()) as { data: { apiKey: string } }).data.apiKey;
};

const rotate = async (apiKey: string): Promise<string> => {
  const response = await fetch(`${hub.hubUrl}/api/keys/rotate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { apiKey: string } }).data.apiKey;
};

describe("a key rotation during a running ACP session", () => {
  test("the next capture uses the rotated key and reaches the hub", async () => {
    // Arrange — the key lives in the stored config, as `crosscheck login` leaves it
    const oldKey = await newDeveloperKey("rotating-dev@example.com");
    const h = await createHarness(hub, cleanups, "rotation", {
      env: { CROSSCHECK_API_KEY: undefined },
    });
    await saveConfig(h.home, { version: 1, hubUrl: hub.hubUrl, apiKey: oldKey });
    await writeRepoFile(h.repo, "src/limiter.ts", "export const a = 1;\n");
    const sessionId = "sess_rotation";
    handshake(h, sessionId, h.repo);
    await h.capture.settle();

    // Act — rotate, store the new key the way the CLI does, then edit
    const newKey = await rotate(oldKey);
    await saveConfig(h.home, { version: 1, hubUrl: hub.hubUrl, apiKey: newKey });
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_after_rotation",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: join(h.repo, "src/limiter.ts") }],
      }),
    );
    await h.capture.settle();

    // Assert — the edit made after the rotation is on the hub
    const diagnosis = await getDiagnosis({ ...h.hub, apiKey: newKey }, `wc_cc_acp-fake-agent--${sessionId}`);
    if (!diagnosis.ok) {
      throw new Error(`diagnosis unavailable: ${diagnosis.message}`);
    }
    expect(
      diagnosis.data.targets.filter((target) => target.kind === "file").map((target) => target.value),
    ).toContain("src/limiter.ts");
  });

  test("a key stored for another hub is never sent to this session's hub", async () => {
    // Arrange — mid-session the developer logs in to a different hub, so
    // the stored config now holds THAT hub's url and key
    const oldKey = await newDeveloperKey("relogged-dev@example.com");
    const h = await createHarness(hub, cleanups, "rotation-other-hub", {
      env: { CROSSCHECK_API_KEY: undefined },
    });
    await saveConfig(h.home, { version: 1, hubUrl: hub.hubUrl, apiKey: oldKey });
    await writeRepoFile(h.repo, "src/limiter.ts", "export const a = 1;\n");
    const sessionId = "sess_rotation_other_hub";
    handshake(h, sessionId, h.repo);
    await h.capture.settle();

    // Act — this hub refuses the old key; the stored key is filed under the
    // other hub. It is this hub's valid key here ONLY so that sending it
    // would be visible: the edit would arrive.
    const newKey = await rotate(oldKey);
    await saveConfig(h.home, { version: 1, hubUrl: "https://other-hub.example", apiKey: newKey });
    h.capture.offer(
      "a2c",
      toolCallUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call_after_other_login",
        kind: "edit",
        status: "in_progress",
        locations: [{ path: join(h.repo, "src/limiter.ts") }],
      }),
    );
    await h.capture.settle();

    // Assert — the other hub's key never reached this one
    const diagnosis = await getDiagnosis({ ...h.hub, apiKey: newKey }, `wc_cc_acp-fake-agent--${sessionId}`);
    const files = diagnosis.ok
      ? diagnosis.data.targets.filter((target) => target.kind === "file").map((target) => target.value)
      : [];
    expect(files).not.toContain("src/limiter.ts");
  });
});
