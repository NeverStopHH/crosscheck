/**
 * The detached summarizer worker (DESIGN.md §3 Tier 1): tolerant output
 * parsing, the client-side derived-confidence clamp, echo-loop exclusion,
 * secret-scan-before-spool, and the hard timeout on the external binary.
 *
 * NO TEST HERE TOUCHES A REAL claude BINARY OR THE NETWORK: the runner is an
 * executable path injected via CROSSCHECK_SUMMARIZER_CMD, faked by a shell
 * wrapper around a bun script written per test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DERIVED_CONFIDENCE_CAP } from "@crosscheck/schema";

import { SUMMARIZER_DEFAULT_CONFIDENCE } from "@crosscheck/connector-core/constants.ts";
import { parseSummarizerOutput } from "../src/summarizer/parse.ts";
import { resolveSummarizerArgv, runSummarizer } from "../src/summarizer/runner.ts";
import { runSummarizeWorker } from "../src/summarizer/worker.ts";
import { recordDeliveredHintHash } from "@crosscheck/connector-core/hints/delivered-store.ts";
import { hintBodyHash } from "@crosscheck/connector-core/hints/echo.ts";
import { readSpoolLines, repoKey } from "../src/index.ts";
import {
  readSessionState,
  writeSessionState,
} from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-summarizer-"));
  paths.push(dir);
  return dir;
};

interface FakeOptions {
  readonly output?: string;
  readonly sleepMs?: number;
  readonly stdinDump?: string;
}

/**
 * An executable the runner can spawn directly: a /bin/sh wrapper around a bun
 * script, because a .ts file alone has no portable shebang for THIS bun.
 */
const makeFakeSummarizer = async (options: FakeOptions): Promise<string> => {
  const dir = await tempDir();
  const script = join(dir, "fake-summarizer.ts");
  await writeFile(
    script,
    [
      "const stdin = await Bun.stdin.text();",
      options.stdinDump === undefined
        ? ""
        : `await Bun.write(${JSON.stringify(options.stdinDump)}, stdin);`,
      options.sleepMs === undefined
        ? ""
        : `await Bun.sleep(${String(options.sleepMs)});`,
      `process.stdout.write(${JSON.stringify(options.output ?? "NONE")});`,
    ].join("\n"),
    "utf8",
  );
  const wrapper = join(dir, "fake-summarizer.sh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,
    "utf8",
  );
  await chmod(wrapper, 0o755);
  return wrapper;
};

const draftJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: "hypothesis",
    body: "The stale cursor id is reused after the spool file is recreated",
    confidence: 0.4,
    ...overrides,
  });

describe("parseSummarizerOutput (tolerant parse)", () => {
  test("the literal NONE, in any spacing or case, is null", () => {
    expect(parseSummarizerOutput("NONE")).toBeNull();
    expect(parseSummarizerOutput("  none\n")).toBeNull();
    expect(parseSummarizerOutput("None.")).toBeNull();
  });

  test("claim JSON wrapped in prose or fences still parses", () => {
    const wrapped = `Here is the claim:\n\`\`\`json\n${draftJson()}\n\`\`\`\n`;
    const parsed = parseSummarizerOutput(wrapped);
    expect(parsed?.kind).toBe("hypothesis");
    expect(parsed?.body).toContain("stale cursor");
  });

  test("anything else is discarded silently", () => {
    expect(parseSummarizerOutput("")).toBeNull();
    expect(parseSummarizerOutput("I think the bug is in the cursor")).toBeNull();
    expect(parseSummarizerOutput("{broken json")).toBeNull();
    expect(parseSummarizerOutput(draftJson({ kind: "novel_kind" }))).toBeNull();
    expect(parseSummarizerOutput(draftJson({ body: "" }))).toBeNull();
    expect(parseSummarizerOutput(draftJson({ body: "x".repeat(401) }))).toBeNull();
  });

  test("confidence is clamped to the derived cap CLIENT-SIDE", () => {
    // The hub enforces the cap too (@crosscheck/schema ClaimSchema); an honest
    // connector never even sends more (DESIGN.md §3).
    const overconfident = parseSummarizerOutput(draftJson({ confidence: 0.95 }));
    expect(overconfident?.confidence).toBe(DERIVED_CONFIDENCE_CAP);
  });

  test("a missing confidence gets the modest default, not the cap", () => {
    const parsed = parseSummarizerOutput(
      `{"kind":"observation","body":"Retry loop swallows the timeout error"}`,
    );
    expect(parsed?.confidence).toBe(SUMMARIZER_DEFAULT_CONFIDENCE);
  });
});

describe("runSummarizer (injectable runner, hard timeout)", () => {
  test("the slice arrives on stdin and stdout comes back", async () => {
    const dir = await tempDir();
    const dump = join(dir, "stdin-dump.txt");
    const fake = await makeFakeSummarizer({ output: "NONE", stdinDump: dump });

    const output = await runSummarizer([fake], "the slice text", 5000, {});

    expect(output).toBe("NONE");
    expect(await Bun.file(dump).text()).toBe("the slice text");
  });

  test("a hung runner is killed at the timeout and yields null", async () => {
    const fake = await makeFakeSummarizer({ sleepMs: 30_000, output: "late" });

    const startedAt = Date.now();
    const output = await runSummarizer([fake], "slice", 300, {});
    const elapsed = Date.now() - startedAt;

    expect(output).toBeNull();
    expect(elapsed).toBeLessThan(5000);
  });

  test("a missing binary is null, never a throw", async () => {
    expect(await runSummarizer(["/nonexistent/claude"], "slice", 1000, {})).toBeNull();
  });

  /** Longer than any plausible CI wobble, far past the ceiling below. */
  const DESCENDANT_LIFETIME_S = 6;
  const DESCENDANT_TIMEOUT_MS = 500;
  /** The deadline bounds the call; the descendant's lifetime must not. */
  const BOUNDED_CEILING_MS = 3000;
  /** Below this the wrapper cannot have run — the deadline made the null. */
  const DEADLINE_FLOOR_MS = 200;

  test("a descendant holding stdout cannot hold the call past the deadline", async () => {
    // Arrange: a summarizer whose background child inherits the stdout pipe
    // and outlives it — the wrapper/tee shape git/git.ts documents ("THE
    // DEADLINE BOUNDS THE CALL, NOT THE CHILD"). Killing the direct child
    // does nothing here: it exits instantly on its own.
    const dir = await tempDir();
    const wrapper = join(dir, "hung-summarizer.sh");
    await writeFile(
      wrapper,
      `#!/bin/sh\n/bin/sleep ${String(DESCENDANT_LIFETIME_S)} &\nexit 0\n`,
      "utf8",
    );
    await chmod(wrapper, 0o755);

    // Act
    const startedAt = Date.now();
    const output = await runSummarizer([wrapper], "slice", DESCENDANT_TIMEOUT_MS, {});
    const elapsed = Date.now() - startedAt;

    // Assert: null at the deadline — not after the descendant's 6 s lifetime.
    // The floor proves the wrapper genuinely ran and the DEADLINE produced
    // the null, not an instant exec failure.
    expect(output).toBeNull();
    expect(elapsed).toBeLessThan(BOUNDED_CEILING_MS);
    expect(elapsed).toBeGreaterThan(DEADLINE_FLOOR_MS);
  });

  test("without an override the argv is headless claude -p on a haiku-class model", () => {
    const argv = resolveSummarizerArgv({});
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("-p");
    expect(argv.join(" ")).toContain("haiku");
  });

  test("CROSSCHECK_SUMMARIZER_CMD overrides the binary wholesale", () => {
    const argv = resolveSummarizerArgv({
      CROSSCHECK_SUMMARIZER_CMD: "/tmp/fake",
    });
    expect(argv).toEqual(["/tmp/fake"]);
  });
});

const SESSION_ID = "worker-session-uuid";
const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:1";

const transcriptLine = (type: string, blocks: unknown[]): string =>
  `${JSON.stringify({ type, message: { role: type, content: blocks } })}\n`;

interface WorkerFixture {
  readonly home: string;
  readonly transcript: string;
  readonly sliceEnd: number;
  readonly key: string;
}

const workerFixture = async (
  stateOverrides: Record<string, unknown> = {},
): Promise<WorkerFixture> => {
  const home = await makeHome("summarize-worker");
  paths.push(home);
  const dir = await tempDir();
  const transcript = join(dir, "transcript.jsonl");
  const content =
    transcriptLine("user", [{ type: "text", text: "why does bun test fail" }]) +
    transcriptLine("assistant", [
      { type: "text", text: "The root cause is the stale cursor id" },
    ]);
  await writeFile(transcript, content, "utf8");
  await writeSessionState(home, {
    hostSessionKey: SESSION_ID,
    crosscheckSessionId: `cc_${SESSION_ID}`,
    workContextId: `wc_cc_${SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: dir,
    hubUrl: HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    ...stateOverrides,
  });
  return {
    home,
    transcript,
    sliceEnd: Buffer.byteLength(content),
    key: repoKey(HUB_URL, REPO_ID),
  };
};

const workerArgs = (fixture: WorkerFixture): readonly string[] => [
  "--transcript",
  fixture.transcript,
  "--session",
  SESSION_ID,
  "--slice-start",
  "0",
  "--slice-end",
  String(fixture.sliceEnd),
];

interface SpooledClaim {
  readonly kind: string;
  readonly producer: { readonly sessionId: string };
  readonly body: {
    readonly body: string;
    readonly status: string;
    readonly confidence: number;
    readonly captureMode: string;
    readonly provenance: string;
    readonly workContextId: string;
  };
}

const spooledClaims = async (
  fixture: WorkerFixture,
): Promise<readonly SpooledClaim[]> =>
  (await readSpoolLines(fixture.home, fixture.key))
    .map((line) => JSON.parse(line) as SpooledClaim)
    .filter((record) => record.kind === "claim");

describe("runSummarizeWorker (end to end, faked binary)", () => {
  test("a valid draft is spooled with auto/derived/capped semantics", async () => {
    // Arrange
    const fixture = await workerFixture();
    const fake = await makeFakeSummarizer({
      output: draftJson({ confidence: 0.9 }),
    });

    // Act
    const exitCode = await runSummarizeWorker(workerArgs(fixture), {
      CROSSCHECK_HOME: fixture.home,
      CROSSCHECK_SUMMARIZER_CMD: fake,
    });

    // Assert — draft semantics are non-negotiable (DESIGN.md §3)
    expect(exitCode).toBe(0);
    const claims = await spooledClaims(fixture);
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    expect(claim?.body.captureMode).toBe("auto");
    expect(claim?.body.provenance).toBe("derived");
    expect(claim?.body.status).toBe("proposed");
    expect(claim?.body.confidence).toBeLessThanOrEqual(DERIVED_CONFIDENCE_CAP);
    expect(claim?.body.workContextId).toBe(`wc_cc_${SESSION_ID}`);
    expect(claim?.producer.sessionId).toBe(`cc_${SESSION_ID}`);
  });

  test("NONE spools nothing and is counted as a NONE outcome", async () => {
    const fixture = await workerFixture();
    const fake = await makeFakeSummarizer({ output: "NONE" });

    await runSummarizeWorker(workerArgs(fixture), {
      CROSSCHECK_HOME: fixture.home,
      CROSSCHECK_SUMMARIZER_CMD: fake,
    });

    expect(await spooledClaims(fixture)).toHaveLength(0);
    // The trial's signal-to-noise instrument: fires minus NONEs minus drafts
    // is the drop-or-failure remainder, so each outcome must be booked.
    const state = await readSessionState(fixture.home, SESSION_ID);
    expect(state?.summarizerNoneCount).toBe(1);
    expect(state?.summarizerDraftCount).toBe(0);
  });

  test("a spooled draft is counted as a draft outcome", async () => {
    const fixture = await workerFixture();
    const fake = await makeFakeSummarizer({ output: draftJson() });

    await runSummarizeWorker(workerArgs(fixture), {
      CROSSCHECK_HOME: fixture.home,
      CROSSCHECK_SUMMARIZER_CMD: fake,
    });

    expect(await spooledClaims(fixture)).toHaveLength(1);
    const state = await readSessionState(fixture.home, SESSION_ID);
    expect(state?.summarizerDraftCount).toBe(1);
    expect(state?.summarizerNoneCount).toBe(0);
  });

  test("echo-loop exclusion: a delivered hint's body is never re-captured", async () => {
    // Arrange: the exact body a teammate hint delivered this session
    const echoedBody = "The refresh 500s trace back to the rotated signing key";
    const fixture = await workerFixture({
      deliveredHintHashes: [hintBodyHash(echoedBody)],
    });
    const fake = await makeFakeSummarizer({
      output: draftJson({ body: echoedBody }),
    });

    // Act: the summarizer tries to mint the teammate's finding as this
    // session's own independent observation
    await runSummarizeWorker(workerArgs(fixture), {
      CROSSCHECK_HOME: fixture.home,
      CROSSCHECK_SUMMARIZER_CMD: fake,
    });

    // Assert: refused (DESIGN.md §3, judge-mandated) — and counted as
    // NEITHER outcome: a dropped draft is not a NONE (the model answered)
    // and not a produced draft (nothing spooled); it stays visible as the
    // fires-minus-outcomes remainder.
    expect(await spooledClaims(fixture)).toHaveLength(0);
    const state = await readSessionState(fixture.home, SESSION_ID);
    expect(state?.summarizerNoneCount).toBe(0);
    expect(state?.summarizerDraftCount).toBe(0);
  });

  test("a hint delivered in an EARLIER session is still excluded", async () => {
    // Arrange: the session state carries NO delivered hashes — the hint
    // arrived in a previous session, whose state died at SessionEnd. Only
    // the per-repo store remembers it (DESIGN.md §3 carries no session
    // qualifier on the echo-loop exclusion).
    const echoedBody = "The refresh 500s trace back to the rotated signing key";
    const fixture = await workerFixture();
    await recordDeliveredHintHash(
      fixture.home,
      fixture.key,
      hintBodyHash(echoedBody),
    );
    const fake = await makeFakeSummarizer({
      output: draftJson({ body: echoedBody }),
    });

    // Act
    await runSummarizeWorker(workerArgs(fixture), {
      CROSSCHECK_HOME: fixture.home,
      CROSSCHECK_SUMMARIZER_CMD: fake,
    });

    // Assert: yesterday's hint cannot be laundered into today's own draft
    expect(await spooledClaims(fixture)).toHaveLength(0);
  });

  test("a body that trips the secret scan is dropped, never redacted", async () => {
    const fixture = await workerFixture();
    const fake = await makeFakeSummarizer({
      output: draftJson({
        body: "The key AKIAABCDEFGHIJKLMNOP leaks from the config loader",
      }),
    });

    await runSummarizeWorker(workerArgs(fixture), {
      CROSSCHECK_HOME: fixture.home,
      CROSSCHECK_SUMMARIZER_CMD: fake,
    });

    expect(await spooledClaims(fixture)).toHaveLength(0);
  });

  test("no session state means no attribution and no capture", async () => {
    const fixture = await workerFixture();
    const fake = await makeFakeSummarizer({ output: draftJson() });

    const exitCode = await runSummarizeWorker(
      [
        "--transcript",
        fixture.transcript,
        "--session",
        "unknown-session",
        "--slice-start",
        "0",
        "--slice-end",
        String(fixture.sliceEnd),
      ],
      { CROSSCHECK_HOME: fixture.home, CROSSCHECK_SUMMARIZER_CMD: fake },
    );

    expect(exitCode).toBe(0);
    expect(await spooledClaims(fixture)).toHaveLength(0);
  });

  test("malformed args exit 0 and touch nothing (fail open)", async () => {
    const fixture = await workerFixture();
    const exitCode = await runSummarizeWorker(["--slice-start", "NaN"], {
      CROSSCHECK_HOME: fixture.home,
    });
    expect(exitCode).toBe(0);
    expect(await spooledClaims(fixture)).toHaveLength(0);
  });
});
