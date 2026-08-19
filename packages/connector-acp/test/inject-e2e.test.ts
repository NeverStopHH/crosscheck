/**
 * Block-5 injection through the REAL binary (design §5 row 5's "done"):
 *
 *   1. THE DISABLED-PASSTHROUGH HASH PROOF: with --no-inject the proxy runs
 *      the Block-3 chunk pump and the agent receives the client's bytes
 *      HASH-IDENTICAL; with injection active but nothing to inject (the
 *      version gate undecided, an unconnected cwd) the line pump forwards
 *      the same bytes hash-identically too. Both directions of prime
 *      directive 1, measured on the spawned binary.
 *   2. THE INJECTED CONVERSATION: a connected repo against a canned hub —
 *      the session/new the AGENT receives carries exactly one appended
 *      crosscheck mcpServers entry, exactly one prompt carries the briefing
 *      block, exactly one carries the hint block, and the user's own blocks
 *      ride untouched.
 *   3. LATENCY: prompt roundtrips measured injected vs --no-inject on the
 *      same topology — the report's "injection adds how many ms" numbers,
 *      printed, with generous ceilings asserted.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";

import {
  concatBytes,
  makeTempHome,
  sha256Hex,
  spawnProxy,
  writeToSink,
} from "./fixtures/e2e-helpers.ts";
import type { PipedProc } from "./fixtures/e2e-helpers.ts";
import { startCannedHub } from "./fixtures/canned-hub.ts";
import { CANDIDATE_BODY } from "../../connector-core/test/fixtures/hint-hub.ts";
import { makeRepo } from "../../connector-core/test/helpers.ts";

const E2E_TIMEOUT_MS = 30_000;
const NEWLINE = 0x0a;
const encoder = new TextEncoder();

interface TimedStep {
  readonly send: string;
  readonly untilLines: number;
  /** Wall-clock pause BEFORE sending — lets an async prefetch land. */
  readonly pauseMs?: number;
}

interface DriveOutcome {
  /** Per-step roundtrip: send → last expected reply line, in ms. */
  readonly roundtripsMs: readonly number[];
}

/** collectDrive with timing and inter-step pauses. */
const driveTimed = async (
  proc: PipedProc,
  steps: readonly TimedStep[],
): Promise<DriveOutcome> => {
  const reader = proc.stdout.getReader();
  let newlines = 0;
  const roundtripsMs: number[] = [];
  const readUntil = async (target: number): Promise<void> => {
    while (newlines < target) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(`stdout ended at ${newlines}/${target} expected lines`);
      }
      for (const byte of value) {
        if (byte === NEWLINE) newlines += 1;
      }
    }
  };
  for (const step of steps) {
    if (step.pauseMs !== undefined) {
      await new Promise((done) => {
        setTimeout(done, step.pauseMs);
      });
    }
    const start = performance.now();
    await writeToSink(proc.stdin, step.send);
    await readUntil(step.untilLines);
    roundtripsMs.push(performance.now() - start);
  }
  proc.stdin.end();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  return { roundtripsMs };
};

const initStep: TimedStep = {
  send: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}\n',
  untilLines: 1,
};

const sessionNewStep = (cwd: string): TimedStep => ({
  send: `${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd, mcpServers: [] },
  })}\n`,
  untilLines: 2,
});

const promptStep = (
  id: number,
  text: string,
  untilLines: number,
  pauseMs?: number,
): TimedStep => ({
  send: `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId: "sess_fake_1", prompt: [{ type: "text", text }] },
  })}\n`,
  untilLines,
  ...(pauseMs === undefined ? {} : { pauseMs }),
});

/** Parses the agent-side stdin dump into its NDJSON lines. */
const dumpLines = async (path: string): Promise<readonly Record<string, unknown>[]> => {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

const promptBlocksOf = (
  message: Record<string, unknown>,
): readonly { type: string; text: string }[] => {
  const params = message["params"] as { prompt?: readonly { type: string; text: string }[] };
  return params.prompt ?? [];
};

describe("prime directive 1: the disabled-passthrough hash proof", () => {
  const passthroughProof = async (proxyFlags: readonly string[]): Promise<void> => {
    const home = await makeTempHome();
    const dumpPath = join(home, "agent-stdin.dump");
    const steps = [
      initStep,
      sessionNewStep("/tmp/acp-e2e"),
      promptStep(3, "hello", 5),
    ];
    const proc = spawnProxy(home, proxyFlags, ["--dump-stdin", dumpPath]);
    await driveTimed(proc, steps);
    const exit = await proc.exited;

    const sent = concatBytes(steps.map((step) => encoder.encode(step.send)));
    const received = await readFile(dumpPath);

    expect(exit).toBe(0);
    expect(sha256Hex(new Uint8Array(received))).toBe(sha256Hex(sent));
    expect(received.byteLength).toBe(sent.byteLength);
  };

  test(
    "--no-inject: the agent receives the client's bytes hash-identically",
    () => passthroughProof(["--no-inject"]),
    E2E_TIMEOUT_MS,
  );

  test(
    "injection active, nothing injectable (unconnected home): still hash-identical",
    () => passthroughProof([]),
    E2E_TIMEOUT_MS,
  );
});

describe("the injected conversation (connected repo, canned hub)", () => {
  test(
    "mcpServers entry + briefing block + hint block, user blocks untouched — and the latency report",
    async () => {
      // Arrange: a connected repo, a canned hub, and two identical
      // topologies — injected and --no-inject control.
      const hub = startCannedHub();
      try {
        const repo = await makeRepo("inj-e2e", {
          remote: "git@github.com:acme/api.git",
        });
        const conversation = (): readonly TimedStep[] => [
          initStep,
          sessionNewStep(repo),
          promptStep(3, "first question about the refresh rotation", 5),
          // The pause lets the async briefing prefetch land (design §2.5:
          // "briefing not ready → skipped … next prompt gets it").
          promptStep(4, "second question about the refresh rotation", 8, 600),
          promptStep(5, "third question about the refresh rotation", 11, 100),
        ];
        const env = {
          CROSSCHECK_HUB_URL: hub.url,
          CROSSCHECK_API_KEY: "test-key",
          CROSSCHECK_TIMEOUT_MS: "2000",
        };

        // Act: injected run.
        const homeInjected = await makeTempHome();
        const dumpInjected = join(homeInjected, "agent-stdin.dump");
        const injectedProc = spawnProxy(
          homeInjected,
          [],
          ["--dump-stdin", dumpInjected],
          env,
        );
        const injected = await driveTimed(injectedProc, conversation());
        expect(await injectedProc.exited).toBe(0);

        // Control run: same topology, --no-inject.
        const homeControl = await makeTempHome();
        const dumpControl = join(homeControl, "agent-stdin.dump");
        const controlProc = spawnProxy(
          homeControl,
          ["--no-inject"],
          ["--dump-stdin", dumpControl],
          env,
        );
        const control = await driveTimed(controlProc, conversation());
        expect(await controlProc.exited).toBe(0);

        // Assert: the wire the AGENT saw.
        const lines = await dumpLines(dumpInjected);
        const sessionNew = lines.find((line) => line["method"] === "session/new");
        const servers = (sessionNew?.["params"] as { mcpServers: readonly { name: string; args: readonly string[] }[] })
          .mcpServers;
        expect(servers).toHaveLength(1);
        expect(servers[0]?.name).toBe("crosscheck");
        expect(servers[0]?.args.at(-1)).toBe("mcp");

        const prompts = lines.filter((line) => line["method"] === "session/prompt");
        expect(prompts).toHaveLength(3);
        // Every user block rides untouched as block[0]…
        for (const prompt of prompts) {
          const blocks = promptBlocksOf(prompt);
          expect(blocks[0]?.type).toBe("text");
          expect(blocks[0]?.text).toContain("question about the refresh rotation");
        }
        // …exactly one prompt carries the briefing, exactly one the hint.
        const appended = prompts
          .map(promptBlocksOf)
          .filter((blocks) => blocks.length === 2)
          .map((blocks) => blocks[1]?.text ?? "");
        expect(appended).toHaveLength(2);
        expect(
          appended.filter((text) => text.startsWith("crosscheck facts about")),
        ).toHaveLength(1);
        expect(
          appended.filter((text) => text.includes(CANDIDATE_BODY)),
        ).toHaveLength(1);
        for (const text of appended) {
          expect(text).toContain(QUOTED_DATA_NOTICE);
        }
        // The control wire carries no appended blocks at all.
        const controlPrompts = (await dumpLines(dumpControl)).filter(
          (line) => line["method"] === "session/prompt",
        );
        for (const prompt of controlPrompts) {
          expect(promptBlocksOf(prompt)).toHaveLength(1);
        }

        // The latency report (printed on every run — the deliverable's
        // numbers; the asserts only catch an order-of-magnitude regression,
        // e.g. a blocking briefing wait sneaking onto the prompt path).
        const injectedPrompts = injected.roundtripsMs.slice(2);
        const controlPrompts2 = control.roundtripsMs.slice(2);
        console.log(
          `[inject-latency] prompt roundtrips ms — injected: ` +
            `p1=${injectedPrompts[0]?.toFixed(1)} p2(briefing)=${injectedPrompts[1]?.toFixed(1)} ` +
            `p3(hint)=${injectedPrompts[2]?.toFixed(1)} | control: ` +
            `p1=${controlPrompts2[0]?.toFixed(1)} p2=${controlPrompts2[1]?.toFixed(1)} ` +
            `p3=${controlPrompts2[2]?.toFixed(1)}`,
        );
        expect(injectedPrompts[1] ?? 0).toBeLessThan(1000);
        expect(injectedPrompts[2] ?? 0).toBeLessThan(1000);
      } finally {
        hub.stop();
      }
    },
    E2E_TIMEOUT_MS,
  );
});
