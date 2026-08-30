/**
 * THE FOREIGN-MODEL CONTRACT TEST — crosscheck's Tier-1 inference path driven
 * end to end by a model that is definitively not Claude.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. It proves the CONTRACT: that a binary
 * with its own argv, its own packaging habits and its own failure modes is
 * spawned, read, bounded, gated, booked and rendered exactly the way the
 * default backend is, and that a draft it produces carries the same forced
 * trust fields. It proves NOTHING about any vendor's model. The answers come
 * from a checked-in corpus of shapes AUTHORED for this test (corpus.ts states
 * that in full), not recorded from a product, and no network call leaves this
 * machine anywhere in this file. docs/FOREIGN-MODELS.md says the same to the
 * reader: the contract is tested, a given model's precision is not.
 *
 * NOTHING IS STUBBED BETWEEN THE TRANSCRIPT AND THE SPOOL. Each case writes a
 * real JSONL transcript, a real session-state file, spawns a real executable
 * through the real runner, and reads the real spool afterwards — the only
 * fake is the model, which is the one component crosscheck deliberately does
 * not own.
 *
 * THE BINARY IS A TRIPWIRE, NOT A STUB. It exits 2 on any claude flag, so if
 * the override ever stopped replacing the binary WHOLESALE, every case here
 * would go red at once rather than passing against something that shrugs at
 * unexpected argv. The second case proves the tripwire itself is live.
 *
 * PORTS: the one throwaway hub in this file binds 7630, inside the range this
 * task owns (7630-7639).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DERIVED_CONFIDENCE_CAP } from "@crosscheck/schema";

import {
  DEFAULT_AGENT_KIND,
  SUMMARIZER_CHILD_ENV,
  SUMMARIZER_OUTPUT_MAX_BYTES,
} from "@crosscheck/connector-core/constants.ts";
import { summarizerCwdPath } from "@crosscheck/connector-core/config/paths.ts";
import {
  formatSummarizerCost,
  isSummarizerSilentlyDead,
  isSummarizerUnreadable,
  readSummarizerCost,
} from "@crosscheck/connector-core/derive/summarizer/cost.ts";
import { recordDeliveredHintHash } from "@crosscheck/connector-core/hints/delivered-store.ts";
import { hintBodyHash } from "@crosscheck/connector-core/hints/echo.ts";
import { flushSpool } from "@crosscheck/connector-core/spool/flush.ts";
import { readSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { runSummarizeWorker } from "../src/summarizer/worker.ts";
import {
  FOREIGN_HUB_URL,
  FOREIGN_REPO_ID,
  FOREIGN_SESSION_ID,
  FOREIGN_SHAPES,
  foreignFixture,
  foreignShape,
  foreignWorkerArgs,
  makeForeignModelBinary,
  spooledClaims,
} from "./fixtures/foreign-model-harness.ts";
import type { ForeignFixture } from "./fixtures/foreign-model-harness.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  cleanups.length = 0;
});

const temp = async (label: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `cx-${label}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

interface ForeignRun {
  readonly fixture: ForeignFixture;
  /** Where the binary wrote {argv, stdin, cwd, env, pid}. */
  readonly dump: string;
  readonly elapsedMs: number;
}

interface RunOptions {
  readonly shape?: string;
  /** Extra env for the worker — the fake reads its own CX_FAKE_FOREIGN_* knobs. */
  readonly env?: Record<string, string>;
  /** Reuse a fixture to run a second turn in the same session. */
  readonly fixture?: ForeignFixture;
}

/**
 * One turn through the real worker, answered by the foreign binary. The
 * override is an executable PATH and nothing else — exactly what an operator
 * would set.
 */
const runForeign = async (options: RunOptions = {}): Promise<ForeignRun> => {
  const fixture = options.fixture ?? (await foreignFixture());
  if (options.fixture === undefined) {
    cleanups.push(fixture.cleanup);
  }
  const binary = await makeForeignModelBinary();
  cleanups.push(() => rm(binary.dir, { recursive: true, force: true }));
  const dump = join(binary.dir, "spawn.json");
  const startedAt = Date.now();
  await runSummarizeWorker(foreignWorkerArgs(fixture), {
    CROSSCHECK_HOME: fixture.home,
    CROSSCHECK_SUMMARIZER_CMD: binary.path,
    CX_FAKE_FOREIGN_SHAPE: options.shape ?? "bare-none",
    CX_FAKE_FOREIGN_DUMP: dump,
    ...options.env,
  });
  return { fixture, dump, elapsedMs: Date.now() - startedAt };
};

interface SpawnEvidence {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly pid: number;
}

const spawnEvidence = async (run: ForeignRun): Promise<SpawnEvidence> =>
  JSON.parse(await Bun.file(run.dump).text()) as SpawnEvidence;

const costOf = (fixture: ForeignFixture) =>
  readSummarizerCost(fixture.home, FOREIGN_HUB_URL, FOREIGN_REPO_ID);

/** The body the corpus says a shape produces, or "" for one that produces none. */
const bodyOf = (shapeName: string): string => {
  const expectation = foreignShape(shapeName).expect;
  return expectation.booked === "draft" ? expectation.body : "";
};

// ---------------------------------------------------------------------------

describe("the override reaches the spawn, and reaches it WHOLESALE", () => {
  test("the binary is handed no arguments at all, and the slice on stdin", async () => {
    // Act
    const run = await runForeign({ shape: "bare-none" });

    // Assert: an override owns its whole argv. Nothing is spliced on — not
    // `-p`, not the prompt, not a lean flag — because a wrapper that received
    // Claude's flags could not be a wrapper for anything else.
    const evidence = await spawnEvidence(run);
    expect(evidence.argv).toEqual([]);
    // The slice, and only the slice. The instruction reaches the default
    // backend as part of its argv, so a wholesale override is responsible for
    // its own prompt — the one asymmetry docs/FOREIGN-MODELS.md has to spell
    // out, because nothing in the spawn hints at it.
    expect(evidence.stdin).toContain("why does bun test fail");
    expect(evidence.stdin).toContain("lease being renewed");
  });

  test("a claude flag is a hard refusal, so the tripwire is live", async () => {
    // Arrange: the fake refuses claude's flags with exit 2. That guarantee is
    // what makes every other case in this file meaningful, so it is proven
    // here rather than assumed — a stub that silently ignored extra argv
    // would let argument splicing land green.
    const binary = await makeForeignModelBinary();
    cleanups.push(() => rm(binary.dir, { recursive: true, force: true }));

    // Act
    const proc = Bun.spawn({
      cmd: [binary.path, "-p", "some prompt"],
      stdin: new Blob([""]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    // Assert
    expect(exitCode).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("refusing -p");
  });

  test("the spawn is neutral, marked, and carries no hub key", async () => {
    // Act
    const run = await runForeign({
      shape: "bare-none",
      env: {
        CROSSCHECK_API_KEY: "cx_live_must_not_travel",
        CLAUDE_CODE_SESSION_ID: "parent-session-must-not-travel",
        ANTHROPIC_BASE_URL: "https://example.invalid/v1",
      },
    });

    // Assert: the same hygiene the default backend gets, applied by the
    // runner on EVERY spawn rather than by the Claude connector.
    const evidence = await spawnEvidence(run);
    // Neutral cwd: no repo CLAUDE.md, AGENTS.md or tooling config rides in.
    // Through realpath because macOS hands a process the resolved
    // /private/var path for a /var/folders temp dir, and the difference is
    // the platform's symlink, not the runner's choice.
    expect(evidence.cwd).toBe(
      await realpath(summarizerCwdPath(run.fixture.home)),
    );
    // The hub key stops here: a third-party binary has no use for it, and
    // the contract gives it nothing to do with it.
    expect(evidence.env["CROSSCHECK_API_KEY"]).toBeUndefined();
    // The child marker, so a crosscheck hook reached from inside the model
    // exits silently instead of firing a second summarizer.
    expect(evidence.env[SUMMARIZER_CHILD_ENV]).toBeDefined();
    // Parent-session markers are stripped; base-URL auth is NOT, because
    // pointing the default backend at another endpoint is one of the
    // documented ways to run a foreign model.
    expect(evidence.env["CLAUDE_CODE_SESSION_ID"]).toBeUndefined();
    expect(evidence.env["ANTHROPIC_BASE_URL"]).toBe("https://example.invalid/v1");
  });
});

describe("every recorded answer shape is booked the way the corpus says", () => {
  for (const shape of FOREIGN_SHAPES) {
    test(`${shape.name}: ${shape.why}`, async () => {
      // Act
      const run = await runForeign({ shape: shape.name });
      const fixture = run.fixture;

      // Assert
      const state = await readSessionState(fixture.home, FOREIGN_SESSION_ID);
      const claims = await spooledClaims(fixture);
      // The binary ran and exited 0 in every case here, so NONE of them is a
      // runner failure — the distinction the whole cost line stands on.
      expect(state?.summarizerFailCount).toBe(0);
      if (shape.expect.booked === "none") {
        expect(state?.summarizerNoneCount).toBe(1);
        expect(claims).toHaveLength(0);
        return;
      }
      if (shape.expect.booked === "unreadable") {
        expect(state?.summarizerUnreadableCount).toBe(1);
        expect(state?.summarizerLastUnreadable).toContain(
          shape.expect.why === "empty" ? "printed nothing" : "unreadable",
        );
        expect(claims).toHaveLength(0);
        return;
      }
      if (shape.expect.booked === "rejected") {
        expect(state?.summarizerRejectCount).toBe(1);
        expect(state?.summarizerLastRejection).toContain(shape.expect.reason);
        // The reason never quotes the body — the point of booking a refusal
        // by class. The machinery that refused to STORE a credential-shaped
        // body must not print it into a terminal either.
        expect(state?.summarizerLastRejection).not.toContain("AKIA");
        expect(claims).toHaveLength(0);
        return;
      }
      expect(claims).toHaveLength(1);
      expect(claims[0]?.body.body).toBe(shape.expect.body);
      expect(claims[0]?.body.confidence).toBe(shape.expect.confidence);
      expect(state?.summarizerDraftCount).toBe(1);
    });
  }
});

describe("a derived draft stays derived, whatever the model claims", () => {
  test("the model's own trust fields are ignored and the cap is forced", async () => {
    // Arrange & Act: the model fills in status, provenance, captureMode,
    // evidence and a confidence of 0.95 — every field it was never offered.
    const run = await runForeign({ shape: "trust-fields-asserted" });

    // Assert: none of it survives. These are stamped by the shared gate
    // pipeline, not chosen by the model and not chosen by the connector.
    const claim = (await spooledClaims(run.fixture))[0];
    expect(claim?.body.status).toBe("proposed");
    expect(claim?.body.provenance).toBe("derived");
    expect(claim?.body.captureMode).toBe("auto");
    expect(claim?.body.evidenceRefs).toEqual([]);
    expect(claim?.body.confidence).toBe(DERIVED_CONFIDENCE_CAP);
    // The producer is the HOST, never the model: a foreign backend does not
    // change which agent the developer was working in.
    expect(claim?.producer.agentKind).toBe(DEFAULT_AGENT_KIND);
  });

  test("what the hub receives is derived and capped, not just what disk holds", async () => {
    // Arrange: a real throwaway hub inside this task's own port range, so the
    // proof runs to the wire rather than stopping at the spool file.
    interface HubRecord {
      readonly body?: {
        readonly provenance?: string;
        readonly status?: string;
        readonly confidence?: number;
      };
    }
    const received: HubRecord[] = [];
    const server = Bun.serve({
      port: 7630,
      fetch: async (request) => {
        const body = (await request.json()) as { records: readonly HubRecord[] };
        received.push(...body.records);
        return Response.json({
          ok: true,
          data: {
            accepted: body.records.length,
            duplicates: 0,
            ignored: 0,
            rejected: 0,
          },
        });
      },
    });
    cleanups.push(async () => {
      await server.stop(true);
    });

    // Act: a foreign model answers with confidence 0.9, and the next flush
    // ships whatever the worker put on the spool.
    const run = await runForeign({ shape: "fenced-json" });
    const outcome = await flushSpool(
      {
        hubUrl: `http://127.0.0.1:${String(server.port)}`,
        apiKey: "test-key",
        timeoutMs: 20_000,
        home: run.fixture.home,
        repoKey: run.fixture.key,
        now: () => new Date(),
      },
      { sessionId: `cc_${FOREIGN_SESSION_ID}`, developerId: "dev_self" },
      20_000,
    );

    // Assert: the record that crossed the wire says derived, at the cap.
    expect(outcome.outcome).toBe("flushed");
    const claims = received.filter(
      (record) => record.body?.provenance !== undefined,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.body?.provenance).toBe("derived");
    expect(claims[0]?.body?.status).toBe("proposed");
    expect(claims[0]?.body?.confidence).toBe(DERIVED_CONFIDENCE_CAP);
  });
});

describe("a model that keeps talking cannot flood the read", () => {
  /** Four times the runner's bound, so the cut is unambiguous. */
  const FLOOD_BYTES = SUMMARIZER_OUTPUT_MAX_BYTES * 4;
  /** Generous: this asserts the read is BOUNDED, not how fast the disk is. */
  const BOUNDED_CEILING_MS = 20_000;

  test("an answer followed by 64 KiB of chatter still lands, once", async () => {
    // Act
    const run = await runForeign({
      shape: "preamble-json",
      env: { CX_FAKE_FOREIGN_FLOOD_BYTES: String(FLOOD_BYTES) },
    });

    // Assert: the answer came first and survived; the flood was cut at the
    // runner's bound and changed nothing.
    const claims = await spooledClaims(run.fixture);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.body.body).toBe(bodyOf("preamble-json"));
    expect(run.elapsedMs).toBeLessThan(BOUNDED_CEILING_MS);
  });

  test("64 KiB of pure noise is booked unreadable, not read to the end", async () => {
    // Act
    const run = await runForeign({
      shape: "prose-only",
      env: { CX_FAKE_FOREIGN_FLOOD_BYTES: String(FLOOD_BYTES) },
    });

    // Assert: one bounded outcome, no draft, no hang.
    const state = await readSessionState(run.fixture.home, FOREIGN_SESSION_ID);
    expect(state?.summarizerUnreadableCount).toBe(1);
    expect(await spooledClaims(run.fixture)).toHaveLength(0);
    expect(run.elapsedMs).toBeLessThan(BOUNDED_CEILING_MS);
  });
});

describe("a foreign answer is echo-checked exactly as Claude's is", () => {
  test("a body a teammate hint already delivered is refused, not re-filed", async () => {
    // Arrange: the SAME shape that lands a draft in the corpus table above,
    // run against a session where that exact body already arrived as a hint.
    // Nothing about the model changed; only the session facts did.
    const fixture = await foreignFixture();
    cleanups.push(fixture.cleanup);
    await recordDeliveredHintHash(
      fixture.home,
      fixture.key,
      hintBodyHash(bodyOf("preamble-json")),
    );

    // Act
    await runForeign({ shape: "preamble-json", fixture });

    // Assert: the echo guard runs on the foreign path too — a teammate's own
    // sentence must never come back as this session's independent finding.
    expect(await spooledClaims(fixture)).toHaveLength(0);
    const state = await readSessionState(fixture.home, FOREIGN_SESSION_ID);
    expect(state?.summarizerRejectCount).toBe(1);
    expect(state?.summarizerLastRejection).toContain("hint");
    expect(state?.summarizerDraftCount).toBe(0);
  });
});

describe("a foreign model that fails, fails SAFELY and VISIBLY", () => {
  /** Short enough that the deadline is what ends the call. */
  const SHORT_DEADLINE_MS = 400;
  /** Far past the deadline, so only the kill can end the process. */
  const HANG_MS = 30_000;
  /** The deadline plus the runner's SIGKILL grace, plus room for a busy box. */
  const REAPED_BY_MS = 8000;
  const REAP_POLL_MS = 50;

  test("a hung wrapper is a booked timeout, and the process is reaped", async () => {
    // Act
    const run = await runForeign({
      shape: "bare-none",
      env: {
        CX_FAKE_FOREIGN_SLEEP_MS: String(HANG_MS),
        CROSSCHECK_SUMMARIZER_TIMEOUT_MS: String(SHORT_DEADLINE_MS),
      },
    });

    // Assert 1: the deadline bounded the CALL — the worker did not wait out
    // the 30 s hang.
    expect(run.elapsedMs).toBeLessThan(HANG_MS / 2);

    // Assert 2: booked as a runner failure with its reason, and VISIBLE on
    // the line `crosscheck status` and `doctor` both print.
    const state = await readSessionState(run.fixture.home, FOREIGN_SESSION_ID);
    expect(state?.summarizerFailCount).toBe(1);
    expect(state?.summarizerLastFailure).toContain("timed out");
    expect(formatSummarizerCost(await costOf(run.fixture))).toContain("1 failed");
    expect(await spooledClaims(run.fixture)).toHaveLength(0);

    // Assert 3: the escalation actually reaped the process rather than
    // leaving it holding the pipe. The pid is the fake's own, written to the
    // dump before it slept.
    const { pid } = await spawnEvidence(run);
    const deadline = Date.now() + REAPED_BY_MS;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(REAP_POLL_MS);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  test("a wrapper that exits non-zero says so on the cost line", async () => {
    // Arrange & Act: the shape an unauthenticated wrapper has — it runs, it
    // fails, and it prints its complaint.
    const run = await runForeign({
      shape: "prose-only",
      env: { CX_FAKE_FOREIGN_EXIT: "1" },
    });

    // Assert: a runner failure, not an unreadable answer — the binary never
    // completed, so the remedy is the binary and not the model's format.
    const state = await readSessionState(run.fixture.home, FOREIGN_SESSION_ID);
    expect(state?.summarizerFailCount).toBe(1);
    expect(state?.summarizerLastFailure).toContain("exit 1");
    expect(state?.summarizerUnreadableCount).toBe(0);
    expect(formatSummarizerCost(await costOf(run.fixture))).toContain("1 failed");
  });

  test("a missing wrapper is booked, never a crash and never a silence", async () => {
    // Arrange: the commonest operator mistake — a path that is not there.
    const fixture = await foreignFixture();
    cleanups.push(fixture.cleanup);
    const dir = await temp("foreign-missing");

    // Act
    const exitCode = await runSummarizeWorker(foreignWorkerArgs(fixture), {
      CROSSCHECK_HOME: fixture.home,
      CROSSCHECK_SUMMARIZER_CMD: join(dir, "not-installed"),
    });

    // Assert: fail open (the worker still exits 0) and fail LOUD on the
    // surface a human reads.
    expect(exitCode).toBe(0);
    const state = await readSessionState(fixture.home, FOREIGN_SESSION_ID);
    expect(state?.summarizerFailCount).toBe(1);
    expect(formatSummarizerCost(await costOf(fixture))).toContain("failed");
  });

  test("printing nothing and printing nonsense get DIFFERENT booked reasons", async () => {
    // Arrange & Act: two runs, two remedies. A wrapper that exits 0 silently
    // is an auth or plumbing problem; one that talks is a format problem, and
    // sending either reader to the other's fix wastes the trip.
    const silent = await runForeign({ shape: "empty" });
    const chatty = await runForeign({ shape: "prose-only" });

    // Assert
    const silentState = await readSessionState(
      silent.fixture.home,
      FOREIGN_SESSION_ID,
    );
    const chattyState = await readSessionState(
      chatty.fixture.home,
      FOREIGN_SESSION_ID,
    );
    expect(silentState?.summarizerLastUnreadable).toContain("printed nothing");
    expect(chattyState?.summarizerLastUnreadable).toContain(
      "neither claim JSON nor NONE",
    );
    expect(silentState?.summarizerLastUnreadable).not.toBe(
      chattyState?.summarizerLastUnreadable,
    );
    // Both are printed WITH their reason, not summed into one number.
    expect(formatSummarizerCost(await costOf(silent.fixture))).toContain(
      "1 unreadable",
    );
  });

  test("a model nobody can read WARNs about the model, not about the runner", async () => {
    // Arrange: two unreadable answers in one session and nothing kept — the
    // signature of a wrapper pointed at a model whose output habits do not
    // fit the contract.
    const fixture = await foreignFixture();
    cleanups.push(fixture.cleanup);
    await runForeign({ shape: "prose-only", fixture });
    await runForeign({ shape: "truncated-json", fixture });

    // Assert: doctor's unreadable WARN fires, and the SILENTLY-DEAD one does
    // not. The binary ran and exited 0 both times, so the runner probe would
    // PASS and sending the reader there would send them to a healthy binary.
    const cost = await costOf(fixture);
    expect(cost.unreadable).toBe(2);
    expect(isSummarizerUnreadable(cost)).toBe(true);
    expect(isSummarizerSilentlyDead(cost)).toBe(false);
  });
});

/**
 * The wrapper docs/FOREIGN-MODELS.md tells an operator to write, run through
 * the SAME real worker as everything above, against a local stand-in for a
 * provider's endpoint on 7632.
 *
 * WHAT THIS PROVES: that the documented lane works — an argument-free shell
 * script that reads stdin, calls an HTTP endpoint, and prints one answer is
 * enough to make crosscheck derive from a foreign model, and the packaging a
 * chat model puts around that answer survives the trip.
 *
 * WHAT IT DOES NOT PROVE: anything about a provider. The stub answers a
 * response SHAPE, not a vendor's implementation, and its "model" never reads
 * the slice. No request leaves this machine.
 *
 * Skipped, loudly, where `jq` is absent — the wrapper needs it to encode a
 * slice safely, and a doc example that hand-rolled JSON escaping in shell
 * would corrupt the first turn containing a quotation mark.
 */
const HAS_JQ = Bun.which("jq") !== null;

describe("the wrapper the docs tell an operator to write actually works", () => {
  test.skipIf(!HAS_JQ)(
    "an argv-free shell script over HTTP derives a capped, derived draft",
    async () => {
      // Arrange: a local stand-in for an OpenAI-compatible endpoint that
      // answers the way a chat model does — a pleasantry, a fence, and a
      // closing offer with a brace in it, all three at once.
      interface ChatRequest {
        readonly model: string;
        readonly messages: readonly { readonly role: string; readonly content: string }[];
      }
      const seen: { auth: string | null; request: ChatRequest }[] = [];
      const server = Bun.serve({
        port: 7632,
        fetch: async (request) => {
          const parsed = (await request.json()) as ChatRequest;
          seen.push({ auth: request.headers.get("authorization"), request: parsed });
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: `Sure! Here is the JSON:\n\`\`\`json\n${foreignShape("fenced-json").stdout.split("\n")[1] ?? ""}\n\`\`\`\nWant the {full} breakdown?`,
                },
              },
            ],
          });
        },
      });
      cleanups.push(async () => {
        await server.stop(true);
      });
      const fixture = await foreignFixture();
      cleanups.push(fixture.cleanup);

      // Act: the checked-in example, spawned exactly as an operator's
      // CROSSCHECK_SUMMARIZER_CMD would be.
      await runSummarizeWorker(foreignWorkerArgs(fixture), {
        CROSSCHECK_HOME: fixture.home,
        CROSSCHECK_SUMMARIZER_CMD: join(
          import.meta.dir,
          "../../../docs/examples/foreign-model-wrapper.sh",
        ),
        CX_MODEL_URL: `http://127.0.0.1:${String(server.port)}/v1/chat/completions`,
        CX_MODEL_KEY: "test-key-that-is-not-a-real-one",
        CX_MODEL_NAME: "example-model-id",
        PATH: process.env["PATH"] ?? "",
      });

      // Assert 1: the wrapper sent what the doc says it sends — the key, the
      // model id, the summarizer's instruction, and the slice unmangled.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.auth).toBe("Bearer test-key-that-is-not-a-real-one");
      expect(seen[0]?.request.model).toBe("example-model-id");
      const system = seen[0]?.request.messages.find((m) => m.role === "system");
      const user = seen[0]?.request.messages.find((m) => m.role === "user");
      expect(system?.content).toContain("passive capture assistant");
      expect(user?.content).toContain("why does bun test fail");

      // Assert 2: and what came back is a derived draft at the cap — through
      // the same three tolerances the corpus covers, in one answer.
      const claims = await spooledClaims(fixture);
      expect(claims).toHaveLength(1);
      expect(claims[0]?.body.body).toBe(bodyOf("fenced-json"));
      expect(claims[0]?.body.confidence).toBe(DERIVED_CONFIDENCE_CAP);
      expect(claims[0]?.body.provenance).toBe("derived");
      expect(claims[0]?.body.captureMode).toBe("auto");
    },
  );

  test("the example takes no arguments, so the contract cannot rot in it", async () => {
    // The doc's whole claim is that a wrapper is spawned argument-free. An
    // example that quietly started reading $1 would teach the opposite, and
    // would keep working locally for whoever wrote it.
    const source = await Bun.file(
      join(import.meta.dir, "../../../docs/examples/foreign-model-wrapper.sh"),
    ).text();
    expect(source).not.toMatch(/\$\{?[1-9]/);
    expect(source).not.toContain('"$@"');
    // It reads the slice from stdin and says so.
    expect(source).toContain("$(cat)");
    // And it carries the instruction, because an override is given none.
    expect(source).toContain("passive capture assistant");
  });
});

describe("the fake model is a real executable with a contract of its own", () => {
  test("its own argv is documented, and crosscheck uses none of it", async () => {
    // Arrange: --shape/--dump/--help are a WORKING foreign argv contract that
    // crosscheck never touches. The asymmetry is the point: the wrapper's
    // interface is the wrapper's business, and the only thing crosscheck
    // requires is slice on stdin, one answer on stdout, exit 0.
    const binary = await makeForeignModelBinary();
    cleanups.push(() => rm(binary.dir, { recursive: true, force: true }));
    const out = join(binary.dir, "answer.json");

    // Act: run it the way its OWN docs say, with no crosscheck anywhere.
    const proc = Bun.spawn({
      cmd: [binary.path, "--shape", "fenced-json", "--dump", out],
      stdin: new Blob(["user: a slice\nassistant: a conclusion"]),
      stdout: "pipe",
      stderr: "inherit",
    });
    const stdout = await new Response(proc.stdout).text();

    // Assert: it answers from the same corpus the cases above read, so the
    // strings in this file and the bytes on that pipe cannot drift.
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe(foreignShape("fenced-json").stdout);
    expect(JSON.parse(await Bun.file(out).text())).toMatchObject({
      argv: ["--shape", "fenced-json", "--dump", out],
    });
  });

  test("it is not on PATH and is not named claude", async () => {
    // Arrange: the operator lane is an executable PATH, so the fixture must
    // not accidentally be resolving something on PATH — least of all a real
    // claude, which would make every case above a test of the wrong binary.
    const binary = await makeForeignModelBinary();
    cleanups.push(() => rm(binary.dir, { recursive: true, force: true }));
    const script = join(binary.dir, "check.sh");
    await writeFile(
      script,
      "#!/bin/sh\ncommand -v ox-fake || echo NOT-ON-PATH\n",
      "utf8",
    );
    await chmod(script, 0o755);
    const proc = Bun.spawn({ cmd: [script], stdout: "pipe", stderr: "ignore" });

    // Assert
    expect((await new Response(proc.stdout).text()).trim()).toBe("NOT-ON-PATH");
    expect(binary.path.endsWith("/ox-fake")).toBe(true);
    expect(binary.path).not.toContain("claude");
  });
});
