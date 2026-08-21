/**
 * `crosscheck doctor`'s ACTIVE probe of the Tier-1 runner (trial finding
 * #14, hard-won rule 5: fail-open must never mean silently dead). For a whole
 * trial the summarizer fired 17 times and answered nothing while doctor read
 * PASS. The probe runs the REAL argv with the REAL worker env from the REAL
 * neutral cwd on a slice that must answer NONE, and prints what the binary
 * said — each of the three real failures wants a different remedy.
 *
 * NO TEST HERE TOUCHES A REAL claude BINARY OR THE NETWORK: the binary is a
 * fake behind CROSSCHECK_SUMMARIZER_CMD, and the "no claude on PATH" skip is
 * exercised with an EMPTY directory as the PATH — which is also the suite's
 * standing invariant, on a developer machine where claude IS installed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** Unreachable on purpose: the runner line is a local fact, no hub needed. */
const HUB_URL = "http://127.0.0.1:9";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-doctor-runner-"));
  paths.push(dir);
  return dir;
};

interface FakeOptions {
  readonly output?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly sleepMs?: number;
  /** Where the fake writes its own environment as JSON. */
  readonly envDump?: string;
  /** Where the fake writes its working directory. */
  readonly cwdDump?: string;
}

/** A /bin/sh wrapper around a bun script — the runner spawns it directly. */
const makeFakeSummarizer = async (options: FakeOptions): Promise<string> => {
  const dir = await tempDir();
  const script = join(dir, "fake-claude.ts");
  await writeFile(
    script,
    [
      "await Bun.stdin.text();",
      options.envDump === undefined
        ? ""
        : `await Bun.write(${JSON.stringify(options.envDump)}, JSON.stringify(process.env));`,
      options.cwdDump === undefined
        ? ""
        : `await Bun.write(${JSON.stringify(options.cwdDump)}, process.cwd());`,
      options.sleepMs === undefined ? "" : `await Bun.sleep(${String(options.sleepMs)});`,
      options.stderr === undefined
        ? ""
        : `process.stderr.write(${JSON.stringify(options.stderr)});`,
      `process.stdout.write(${JSON.stringify(options.output ?? "NONE")});`,
      options.exitCode === undefined ? "" : `process.exitCode = ${String(options.exitCode)};`,
    ].join("\n"),
    "utf8",
  );
  const wrapper = join(dir, "fake-claude.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, "utf8");
  await chmod(wrapper, 0o755);
  return wrapper;
};

interface Fixture {
  readonly repo: string;
  readonly home: string;
}

const fixture = async (): Promise<Fixture> => {
  const repo = await makeRepo("doctor-runner", { remote: "git@github.com:acme/api.git" });
  const home = await makeHome("doctor-runner");
  paths.push(repo, home);
  return { repo, home };
};

const doctorEnv = (
  home: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: HUB_URL,
  CROSSCHECK_API_KEY: "test-key",
  USER: "tester",
  ...extra,
});

const runnerLine = (stdout: string): string =>
  stdout.split("\n").find((line) => line.includes("summarizer runner")) ?? "(no summarizer runner line)";

describe("crosscheck doctor — summarizer runner probe", () => {
  test("a runner that answers NONE is PASS, timed, and ran with the worker env from the neutral cwd", async () => {
    // Arrange: the fake records what it was given
    const { repo, home } = await fixture();
    const dir = await tempDir();
    const envDump = join(dir, "env.json");
    const cwdDump = join(dir, "cwd.txt");
    const fake = await makeFakeSummarizer({ output: "NONE", envDump, cwdDump });

    // Act
    const result = await runCli(
      ["doctor"],
      doctorEnv(home, { CROSSCHECK_SUMMARIZER_CMD: fake }),
      repo,
    );

    // Assert: the line
    const line = runnerLine(result.stdout);
    expect(line).toContain("PASS  summarizer runner");
    expect(line).toContain("answered NONE in");
    // …the env: USER forwarded (the finding's variable) and the child marker set
    const seen = JSON.parse(await Bun.file(envDump).text()) as Record<string, string>;
    expect(seen["USER"]).toBe("tester");
    expect(seen["CROSSCHECK_SUMMARIZER_CHILD"]).toBe("1");
    expect(seen["CROSSCHECK_HOME"]).toBe(home);
    // …and the cwd: the neutral directory, not the repo doctor ran in
    // (realpath on both sides: the child reports the resolved path, macOS
    // /var → /private/var, while the fixture path is the symlink)
    expect(await realpath(await Bun.file(cwdDump).text())).toBe(
      await realpath(join(home, "summarizer-cwd")),
    );
  });

  test("an answer that is not NONE is still PASS — the runner works; precision is the model's", async () => {
    const { repo, home } = await fixture();
    const fake = await makeFakeSummarizer({
      output: '{"kind":"observation","body":"the suite is green","confidence":0.2}',
    });

    const result = await runCli(["doctor"], doctorEnv(home, { CROSSCHECK_SUMMARIZER_CMD: fake }), repo);

    const line = runnerLine(result.stdout);
    expect(line).toContain("PASS  summarizer runner");
    expect(line).toContain("not NONE");
  });

  test('"Not logged in" on stdout with exit 1 is FAIL, names it, and points at the login', async () => {
    const { repo, home } = await fixture();
    const fake = await makeFakeSummarizer({
      output: "Not logged in · Please run /login\n",
      exitCode: 1,
    });

    const result = await runCli(["doctor"], doctorEnv(home, { CROSSCHECK_SUMMARIZER_CMD: fake }), repo);

    const line = runnerLine(result.stdout);
    expect(line).toContain("FAIL  summarizer runner");
    expect(line).toContain("exit 1: Not logged in Please run /login");
    expect(line).toContain("log in");
  });

  test("an unknown flag on STDERR with exit 1 is FAIL, names it, and says upgrade", async () => {
    // Arrange: an older CLI — stdout empty, the complaint on stderr, which
    // the worker never reads but doctor does (a human is watching)
    const { repo, home } = await fixture();
    const fake = await makeFakeSummarizer({
      output: "",
      stderr: "error: unknown option '--tools'\n",
      exitCode: 1,
    });

    const result = await runCli(["doctor"], doctorEnv(home, { CROSSCHECK_SUMMARIZER_CMD: fake }), repo);

    const line = runnerLine(result.stdout);
    expect(line).toContain("FAIL  summarizer runner");
    expect(line).toContain("unknown option '--tools'");
    expect(line).toContain("upgrade Claude Code");
  });

  test("a run past the deadline is FAIL, names the deadline, and points at the timeout knob", async () => {
    const { repo, home } = await fixture();
    const fake = await makeFakeSummarizer({ sleepMs: 30_000, output: "late" });

    const result = await runCli(
      ["doctor"],
      doctorEnv(home, {
        CROSSCHECK_SUMMARIZER_CMD: fake,
        CROSSCHECK_SUMMARIZER_TIMEOUT_MS: "1000",
      }),
      repo,
    );

    const line = runnerLine(result.stdout);
    expect(line).toContain("FAIL  summarizer runner");
    expect(line).toContain("timed out after 1 s");
    expect(line).toContain("CROSSCHECK_SUMMARIZER_TIMEOUT_MS");
  }, 15_000);

  test("exit 0 with empty stdout is FAIL — the binary ran and said nothing", async () => {
    const { repo, home } = await fixture();
    const fake = await makeFakeSummarizer({ output: "" });

    const result = await runCli(["doctor"], doctorEnv(home, { CROSSCHECK_SUMMARIZER_CMD: fake }), repo);

    const line = runnerLine(result.stdout);
    expect(line).toContain("FAIL  summarizer runner");
    expect(line).toContain("empty stdout");
  });

  test("CROSSCHECK_DOCTOR_NO_PROBE=1 skips the probe and never runs the binary", async () => {
    const { repo, home } = await fixture();
    const dir = await tempDir();
    const cwdDump = join(dir, "ran.txt");
    const fake = await makeFakeSummarizer({ output: "NONE", cwdDump });

    const result = await runCli(
      ["doctor"],
      doctorEnv(home, { CROSSCHECK_SUMMARIZER_CMD: fake, CROSSCHECK_DOCTOR_NO_PROBE: "1" }),
      repo,
    );

    const line = runnerLine(result.stdout);
    expect(line).toContain("PASS  summarizer runner");
    expect(line).toContain("skipped");
    expect(line).toContain("CROSSCHECK_DOCTOR_NO_PROBE=1");
    expect(await Bun.file(cwdDump).exists()).toBe(false);
  });

  test("no override and no claude on PATH: a skipped line that says so (and no Haiku call)", async () => {
    // Arrange: a PATH with nothing on it — a stranger's laptop, or CI
    const { repo, home } = await fixture();
    const emptyPath = await tempDir();

    // Act
    const result = await runCli(["doctor"], doctorEnv(home, { PATH: emptyPath }), repo);

    // Assert
    const line = runnerLine(result.stdout);
    expect(line).toContain("PASS  summarizer runner");
    expect(line).toContain("skipped");
    expect(line).toContain("no claude binary on PATH");
  });
});
