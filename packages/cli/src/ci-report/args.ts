/**
 * THE REPORTER'S BOUNDARY: its argv, and the runner's environment.
 *
 * The workflow step passes the lane on the command line (spec 05 §10 D4):
 *
 *   --junit junit.xml --job test --leg ${{ matrix.os }}
 *   --ref ${{ github.head_ref || github.ref_name }} --attempt ${{ github.run_attempt }}
 *   --run-id ${{ github.run_id }}
 *   --sha ${{ github.event.pull_request.head.sha || github.sha }}
 *
 * and the two facts that are not the lane's — which hub, which token — come
 * from repository secrets through the environment, so a fork pull request,
 * which has no secrets, has neither and reports nothing (§8.3). The workflow
 * name and the repository come from the runner's own `GITHUB_*` variables;
 * the repository is put through `normalizeRemoteUrl` so a CI row carries the
 * SAME key a session does (§3.1) — a row keyed on `Acme/API` joins nothing.
 *
 * EVERY VALUE IS CHECKED HERE, WITH THE FLAG'S NAME IN THE SENTENCE. The
 * reader of a refusal is the workflow author, and the hub's own 400 would
 * name a JSON path they never typed. The lane bounds are the WIRE's bounds,
 * imported rather than re-minted, so nothing can pass here and fail there.
 *
 * `--leg` IS OPTIONAL AND DEFAULTS TO "" — a job with no matrix is a real
 * lane, and `${{ matrix.os }}` on such a job expands to nothing, leaving
 * `--leg --ref …`. A value that is itself a flag is therefore a MISSING
 * value, never a lane field: consuming `--ref` as the leg would lose the ref
 * silently and the row would land in a lane nobody meant.
 */
import { EXIT_OK } from "@crosscheck/connector-core/constants.ts";
import { normalizeRemoteUrl } from "@crosscheck/connector-core/git/repo-identity.ts";
import {
  COMMIT_SHA_PATTERN,
  MAX_CI_LANE_FIELD_CHARS,
  MAX_EXTERNAL_RUN_ID_CHARS,
} from "@crosscheck/schema";

import { interceptHelpOrUnknownFlag } from "../cli/help.ts";

export const CI_REPORT_FLAG_JUNIT = "--junit";
export const CI_REPORT_FLAG_RERUN_JUNIT = "--rerun-junit";
export const CI_REPORT_FLAG_JOB = "--job";
export const CI_REPORT_FLAG_LEG = "--leg";
export const CI_REPORT_FLAG_REF = "--ref";
export const CI_REPORT_FLAG_ATTEMPT = "--attempt";
export const CI_REPORT_FLAG_RUN_ID = "--run-id";
export const CI_REPORT_FLAG_SHA = "--sha";

/** Where the re-run's report lands, beside the primary one (§10 D4). */
export const DEFAULT_RERUN_JUNIT_PATH = "junit-rerun.xml";

/** GitHub's own default; a self-hosted GHES instance sets the variable. */
const DEFAULT_GITHUB_SERVER_URL = "https://github.com";

export const CI_REPORT_USAGE = [
  "usage: bun run packages/cli/scripts/ci-report.ts --junit <file> --job <name>",
  "         [--leg <matrix-leg>] --ref <branch> --attempt <n> --run-id <id>",
  "         --sha <commit> [--rerun-junit <file>]",
  "",
  "  Posts what one CI job saw at one commit to the crosscheck hub: the",
  "  totals, and ONLY the non-green tests — never a message, a stack or",
  "  console output. When the suite is red it re-runs the failed files once",
  "  on the same runner and posts that as a same-job re-run, so the hub can",
  "  tell a flake from a regression.",
  "",
  "  env: CROSSCHECK_HUB_URL, CROSSCHECK_CI_TOKEN (repository secrets; absent",
  "       on a fork pull request, in which case one line is printed and the",
  "       exit code is 0), GITHUB_WORKFLOW, GITHUB_REPOSITORY, GITHUB_SERVER_URL",
  "",
  "  --sha must be the HEAD sha: on a pull_request event pass",
  "  ${{ github.event.pull_request.head.sha || github.sha }}, never github.sha",
  "  alone — the merge commit joins no developer's history.",
  "",
].join("\n");

export interface CiReportArgs {
  readonly junitPath: string;
  readonly rerunJunitPath: string;
  readonly job: string;
  readonly leg: string;
  readonly ref: string;
  readonly runAttempt: number;
  readonly externalRunId: string;
  readonly commitSha: string;
}

export type CiReportArgsResult =
  | { readonly kind: "args"; readonly args: CiReportArgs }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

const VALUE_FLAGS: readonly string[] = [
  CI_REPORT_FLAG_JUNIT,
  CI_REPORT_FLAG_RERUN_JUNIT,
  CI_REPORT_FLAG_JOB,
  CI_REPORT_FLAG_LEG,
  CI_REPORT_FLAG_REF,
  CI_REPORT_FLAG_ATTEMPT,
  CI_REPORT_FLAG_RUN_ID,
  CI_REPORT_FLAG_SHA,
];

const ATTEMPT_PATTERN = /^[1-9]\d*$/;
/** Any C0/C1 control character: a lane field is printed, and a newline forges a line. */
const CONTROL_PATTERN = /\p{Cc}/u;

const error = (message: string): CiReportArgsResult => ({
  kind: "error",
  message,
});

/** Flag → value, or the first flag whose value is missing or is a flag. */
const collectValues = (
  argv: readonly string[],
): ReadonlyMap<string, string> | string => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return `${flag} needs a value`;
    }
    values.set(flag, value);
  }
  return values;
};

const checkText = (
  flag: string,
  value: string | undefined,
  maxChars: number,
  required: boolean,
): string | null => {
  if (value === undefined) {
    return required ? `${flag} is required` : null;
  }
  if (required && value.length === 0) {
    return `${flag} must not be empty`;
  }
  if (value.length > maxChars) {
    return `${flag} is longer than ${String(maxChars)} characters`;
  }
  if (CONTROL_PATTERN.test(value)) {
    return `${flag} contains a control character`;
  }
  return null;
};

const firstProblem = (values: ReadonlyMap<string, string>): string | null => {
  const lane = MAX_CI_LANE_FIELD_CHARS;
  const get = (flag: string): string | undefined => values.get(flag);
  const checks: readonly (string | null)[] = [
    checkText(CI_REPORT_FLAG_JUNIT, get(CI_REPORT_FLAG_JUNIT), lane, true),
    checkText(CI_REPORT_FLAG_RERUN_JUNIT, get(CI_REPORT_FLAG_RERUN_JUNIT), lane, false),
    checkText(CI_REPORT_FLAG_JOB, get(CI_REPORT_FLAG_JOB), lane, true),
    checkText(CI_REPORT_FLAG_LEG, get(CI_REPORT_FLAG_LEG), lane, false),
    checkText(CI_REPORT_FLAG_REF, get(CI_REPORT_FLAG_REF), lane, true),
    checkText(CI_REPORT_FLAG_RUN_ID, get(CI_REPORT_FLAG_RUN_ID), MAX_EXTERNAL_RUN_ID_CHARS, true),
    checkText(CI_REPORT_FLAG_ATTEMPT, get(CI_REPORT_FLAG_ATTEMPT), lane, true),
    checkText(CI_REPORT_FLAG_SHA, get(CI_REPORT_FLAG_SHA), lane, true),
  ];
  const textProblem = checks.find((problem) => problem !== null);
  if (textProblem !== undefined) {
    return textProblem;
  }
  if (!ATTEMPT_PATTERN.test(get(CI_REPORT_FLAG_ATTEMPT) ?? "")) {
    return `${CI_REPORT_FLAG_ATTEMPT} must be a positive integer (GITHUB_RUN_ATTEMPT)`;
  }
  if (!COMMIT_SHA_PATTERN.test(get(CI_REPORT_FLAG_SHA) ?? "")) {
    return `${CI_REPORT_FLAG_SHA} must be a hex commit sha of 7 to 64 characters`;
  }
  return null;
};

export const parseCiReportArgs = (
  argv: readonly string[],
): CiReportArgsResult => {
  // The shared gate first: --help anywhere wins, an unlisted flag is refused
  // by name — the one table every user-facing command already answers to.
  const intercepted = interceptHelpOrUnknownFlag("ci-report", argv, {
    usage: CI_REPORT_USAGE,
    valueFlags: VALUE_FLAGS,
  });
  if (intercepted !== null) {
    return intercepted.exitCode === EXIT_OK
      ? { kind: "help" }
      : error(intercepted.stdout.split("\n")[0] ?? "unknown flag");
  }
  const values = collectValues(argv);
  if (typeof values === "string") {
    return error(values);
  }
  const problem = firstProblem(values);
  if (problem !== null) {
    return error(problem);
  }
  return {
    kind: "args",
    args: {
      junitPath: values.get(CI_REPORT_FLAG_JUNIT) ?? "",
      rerunJunitPath:
        values.get(CI_REPORT_FLAG_RERUN_JUNIT) ?? DEFAULT_RERUN_JUNIT_PATH,
      job: values.get(CI_REPORT_FLAG_JOB) ?? "",
      leg: values.get(CI_REPORT_FLAG_LEG) ?? "",
      ref: values.get(CI_REPORT_FLAG_REF) ?? "",
      runAttempt: Number(values.get(CI_REPORT_FLAG_ATTEMPT)),
      externalRunId: values.get(CI_REPORT_FLAG_RUN_ID) ?? "",
      commitSha: values.get(CI_REPORT_FLAG_SHA) ?? "",
    },
  };
};

export interface CiReportEnv {
  /** Trailing slashes trimmed; `null` when unset or empty. NOT yet known to be a URL. */
  readonly hubUrl: string | null;
  readonly token: string | null;
  readonly workflow: string | null;
  /** `normalizeRemoteUrl` of the runner's repository, or `null` off a runner. */
  readonly repo: string | null;
}

/** GitHub expands an UNSET secret to the empty string, so empty is absent. */
const nonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

export const readCiReportEnv = (
  env: Readonly<Record<string, string | undefined>>,
): CiReportEnv => {
  const slug = nonEmpty(env["GITHUB_REPOSITORY"]);
  const server =
    nonEmpty(env["GITHUB_SERVER_URL"]) ?? DEFAULT_GITHUB_SERVER_URL;
  return {
    hubUrl: nonEmpty(env["CROSSCHECK_HUB_URL"])?.replace(/\/+$/, "") ?? null,
    token: nonEmpty(env["CROSSCHECK_CI_TOKEN"]),
    workflow: nonEmpty(env["GITHUB_WORKFLOW"]),
    repo: slug === null ? null : normalizeRemoteUrl(`${server}/${slug}`),
  };
};
