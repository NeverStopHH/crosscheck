/**
 * THE REPORTER'S BOUNDARY: its argv and the runner's environment.
 *
 * Every value here is validated before anything is read or sent, and each
 * refusal names the flag — the workflow author is the one who will read it.
 * The lane fields are bounded by the SAME constant the wire uses, so a value
 * the hub would refuse is refused here first, with a better sentence.
 */
import { describe, expect, test } from "bun:test";

import { MAX_CI_LANE_FIELD_CHARS } from "@crosscheck/schema";

import {
  CI_REPORT_USAGE,
  DEFAULT_RERUN_JUNIT_PATH,
  parseCiReportArgs,
  readCiReportEnv,
} from "../src/ci-report/args.ts";

const FULL: readonly string[] = [
  "--junit",
  "junit.xml",
  "--job",
  "test",
  "--leg",
  "ubuntu-latest",
  "--ref",
  "main",
  "--attempt",
  "1",
  "--run-id",
  "35572434868",
  "--sha",
  "a1b2c3d4e5f6a7b8",
];

/** FULL with one flag's value replaced. */
const withValue = (flag: string, value: string): string[] => {
  const index = FULL.indexOf(flag);
  return [...FULL.slice(0, index + 1), value, ...FULL.slice(index + 2)];
};

/** FULL without one flag and its value. */
const without = (flag: string): string[] => {
  const index = FULL.indexOf(flag);
  return [...FULL.slice(0, index), ...FULL.slice(index + 2)];
};

const errorOf = (argv: readonly string[]): string => {
  const parsed = parseCiReportArgs(argv);
  if (parsed.kind !== "error") {
    throw new Error("expected a usage error");
  }
  return parsed.message;
};

describe("the workflow's command line parses to the lane it names", () => {
  test("every flag lands where the wire expects it", () => {
    const parsed = parseCiReportArgs(FULL);

    expect(parsed.kind).toBe("args");
    if (parsed.kind !== "args") {
      return;
    }
    expect(parsed.args).toEqual({
      junitPath: "junit.xml",
      rerunJunitPath: DEFAULT_RERUN_JUNIT_PATH,
      job: "test",
      leg: "ubuntu-latest",
      ref: "main",
      runAttempt: 1,
      externalRunId: "35572434868",
      commitSha: "a1b2c3d4e5f6a7b8",
    });
  });

  test("--leg is optional and defaults to the empty string — a job with no matrix is a real lane", () => {
    const parsed = parseCiReportArgs(without("--leg"));

    expect(parsed.kind).toBe("args");
    if (parsed.kind === "args") {
      expect(parsed.args.leg).toBe("");
    }
  });

  test("--rerun-junit overrides where the second run's report is written", () => {
    const parsed = parseCiReportArgs([...FULL, "--rerun-junit", "out/rerun.xml"]);

    expect(parsed.kind).toBe("args");
    if (parsed.kind === "args") {
      expect(parsed.args.rerunJunitPath).toBe("out/rerun.xml");
    }
  });

  test("--help is help, not an error and not a run", () => {
    expect(parseCiReportArgs(["--help"]).kind).toBe("help");
    expect(parseCiReportArgs([...FULL, "-h"]).kind).toBe("help");
    expect(CI_REPORT_USAGE).toContain("--sha");
  });
});

describe("a value the wire would refuse is refused here, naming the flag", () => {
  test.each(["--junit", "--job", "--ref", "--attempt", "--run-id", "--sha"])(
    "%s is required",
    (flag) => {
      expect(errorOf(without(flag))).toContain(flag);
    },
  );

  test("a sha that is not hex, or too short, is refused", () => {
    expect(errorOf(withValue("--sha", "g1b2c3d4"))).toContain("--sha");
    expect(errorOf(withValue("--sha", "abc"))).toContain("--sha");
  });

  test("an attempt that is not a positive integer is refused", () => {
    expect(errorOf(withValue("--attempt", "0"))).toContain("--attempt");
    expect(errorOf(withValue("--attempt", "1.5"))).toContain("--attempt");
    expect(errorOf(withValue("--attempt", "two"))).toContain("--attempt");
  });

  test("a value that is itself a flag is a missing value, not a lane field", () => {
    // `--leg ${{ matrix.os }}` on a job with no matrix expands to `--leg --ref`,
    // and consuming `--ref` as the leg would silently lose the ref.
    const message = errorOf([...without("--leg"), "--leg", "--extra"]);

    expect(message).toContain("--leg");
  });

  test("an unknown flag is refused rather than ignored", () => {
    expect(errorOf([...FULL, "--workflow", "CI"])).toContain("--workflow");
  });

  test("a lane field over MAX_CI_LANE_FIELD_CHARS is refused", () => {
    expect(
      errorOf(withValue("--job", "j".repeat(MAX_CI_LANE_FIELD_CHARS + 1))),
    ).toContain("--job");
  });

  test("a lane field carrying a control character is refused", () => {
    expect(errorOf(withValue("--ref", "main\u0007"))).toContain("--ref");
    expect(errorOf(withValue("--job", "te\nst"))).toContain("--job");
  });

  test("an empty required value is refused", () => {
    expect(errorOf(withValue("--job", ""))).toContain("--job");
  });
});

describe("the environment: hub facts from secrets, lane facts from the runner", () => {
  const RUNNER = {
    CROSSCHECK_HUB_URL: "http://hub.example:7100/",
    CROSSCHECK_CI_TOKEN: "ci-secret",
    GITHUB_WORKFLOW: "CI",
    GITHUB_REPOSITORY: "Acme/API",
    GITHUB_SERVER_URL: "https://github.com",
  };

  test("the repo is normalized to the key a session carries", () => {
    // normalizeRemoteUrl's output, so a CI row joins a session's `repo`.
    expect(readCiReportEnv(RUNNER).repo).toBe("github.com/acme/api");
  });

  test("the workflow comes from GITHUB_WORKFLOW and the hub facts from the two secrets", () => {
    const env = readCiReportEnv(RUNNER);

    expect(env.workflow).toBe("CI");
    expect(env.token).toBe("ci-secret");
    // Trailing slashes are trimmed so the route joins cleanly.
    expect(env.hubUrl).toBe("http://hub.example:7100");
  });

  test("an EMPTY secret is an absent one — GitHub expands an unset secret to ''", () => {
    const env = readCiReportEnv({
      ...RUNNER,
      CROSSCHECK_HUB_URL: "",
      CROSSCHECK_CI_TOKEN: "",
    });

    expect(env.hubUrl).toBeNull();
    expect(env.token).toBeNull();
  });

  test("no GITHUB_SERVER_URL means github.com; no GITHUB_REPOSITORY means no repo", () => {
    expect(
      readCiReportEnv({ ...RUNNER, GITHUB_SERVER_URL: undefined }).repo,
    ).toBe("github.com/acme/api");
    expect(
      readCiReportEnv({ ...RUNNER, GITHUB_REPOSITORY: undefined }).repo,
    ).toBeNull();
  });

  test("an empty environment is all nulls, never a guess", () => {
    expect(readCiReportEnv({})).toEqual({
      hubUrl: null,
      token: null,
      workflow: null,
      repo: null,
    });
  });
});
