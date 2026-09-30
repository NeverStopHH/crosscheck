/**
 * THE REPORTER END TO END, against a real in-process hub (spec 05 §3.7, §8,
 * §10 D4).
 *
 * The hub is `createServer` with a CI token and NO socket: the reporter's
 * fetch is injected and handed `app.request`, so nothing here can reach a
 * port. Reads back go through `GET /api/ci-runs` with a developer key, which
 * is the same road `crosscheck status` takes — the assertions are about what
 * the hub HOLDS, not what the reporter says it sent.
 *
 * The three refusals this file pins, because each one otherwise reads as
 * good news:
 *
 *   - no token (a fork pull request has no secrets): ONE line, exit 0 — the
 *     reporter must never turn a green job red (§8.3, non-negotiable #1);
 *   - a hub that cannot be reached or refuses: one line, exit 0, and NO
 *     re-run, because a re-run row with nothing to attach to is noise;
 *   - a junit file that is missing or half-written: a `crashed` row, so the
 *     lane is seen to have RUN and to have said nothing (§2, principle 4).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT_OK, EXIT_USAGE } from "@crosscheck/connector-core/constants.ts";
import { createDb, createServer } from "@crosscheck/server";

import { runCiReport } from "../src/ci-report/run.ts";
import type { CiReportDeps, CiReportFetch } from "../src/ci-report/run.ts";
import { MEASURED_XML } from "./ci-report-junit.test.ts";

const ADMIN_TOKEN = "ci-report-admin";
const CI_TOKEN = "ci-report-token";
const HUB_URL = "http://hub.test";
const REPO = "github.com/acme/api";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "35572434868";

const GREEN_XML =
  '<testsuites name="bun test" tests="2" assertions="2" failures="0" skipped="0" time="0.25">' +
  '<testsuite name="packages/a.test.ts" file="packages/a.test.ts" hostname="runner">' +
  '<testcase name="one" classname="" time="0.1" file="packages/a.test.ts" line="3" />' +
  '<testcase name="two" classname="" time="0.15" file="packages/a.test.ts" line="7" />' +
  "</testsuite></testsuites>";

const RED_XML =
  '<testsuites name="bun test" tests="3" assertions="3" failures="1" skipped="0" time="0.3">' +
  '<testsuite name="packages/a.test.ts" file="packages/a.test.ts" hostname="runner">' +
  '<testcase name="one" classname="" time="0.1" file="packages/a.test.ts" line="3" />' +
  '<testcase name="red" classname="" time="0.1" file="packages/a.test.ts" line="7">' +
  '<failure message="expected 1 to be 2 — see src/secret-module.ts" type="AssertionError">at src/secret-module.ts:9</failure>' +
  "</testcase></testsuite>" +
  '<testsuite name="packages/b.test.ts" file="packages/b.test.ts" hostname="runner">' +
  '<testcase name="fine" classname="" time="0.1" file="packages/b.test.ts" line="3" />' +
  "</testsuite></testsuites>";

const RERUN_GREEN_XML =
  '<testsuites name="bun test" tests="2" assertions="2" failures="0" skipped="0" time="0.2">' +
  '<testsuite name="packages/a.test.ts" file="packages/a.test.ts" hostname="runner">' +
  '<testcase name="one" classname="" time="0.1" file="packages/a.test.ts" line="3" />' +
  '<testcase name="red" classname="" time="0.1" file="packages/a.test.ts" line="7" />' +
  "</testsuite></testsuites>";

const RERUN_RED_XML = RED_XML;

const ARGV: readonly string[] = [
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
  RUN_ID,
  "--sha",
  SHA,
];

interface HubRun {
  readonly id: string;
  readonly commitSha: string;
  readonly workflow: string;
  readonly job: string;
  readonly leg: string;
  readonly ref: string;
  readonly runAttempt: number;
  readonly externalRunId: string;
  readonly rerunKind: string;
  readonly rerunOf: string | null;
  readonly outcome: string;
  readonly tests: number;
  readonly failures: number;
  readonly skipped: number;
  readonly ambiguousDropped: number;
  readonly results: readonly { testId: string; status: string }[];
}

interface Hub {
  readonly fetch: CiReportFetch;
  readonly readRuns: () => Promise<readonly HubRun[]>;
}

const startHub = async (ciToken: string | null = CI_TOKEN): Promise<Hub> => {
  const db = await createDb();
  const app = createServer({ db, adminToken: ADMIN_TOKEN, ciToken });
  const developer = await app.request("/api/developers", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Reader", email: "reader@example.com" }),
  });
  const { apiKey } = ((await developer.json()) as { data: { apiKey: string } })
    .data;
  return {
    fetch: (url, init) => app.request(url, init),
    readRuns: async () => {
      const response = await app.request(
        `/api/ci-runs?repo=${encodeURIComponent(REPO)}&commit=${SHA}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      return ((await response.json()) as { data: { runs: HubRun[] } }).data
        .runs;
    },
  };
};

interface RerunCall {
  readonly cwd: string;
  readonly files: readonly string[];
  readonly outfile: string;
}

/** A fake `bun test` that writes the given XML where it was told to. */
const fakeRunTests =
  (xml: string | null, calls: RerunCall[]): CiReportDeps["runTests"] =>
  async (cwd, files, outfile) => {
    calls.push({ cwd, files, outfile });
    if (xml !== null) {
      await writeFile(join(cwd, outfile), xml);
    }
  };

const runnerEnv = (
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  CROSSCHECK_HUB_URL: HUB_URL,
  CROSSCHECK_CI_TOKEN: CI_TOKEN,
  GITHUB_WORKFLOW: "CI",
  GITHUB_REPOSITORY: "acme/api",
  GITHUB_SERVER_URL: "https://github.com",
  ...overrides,
});

let cwd = "";
let home = "";

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "cx-ci-report-"));
  home = await mkdtemp(join(tmpdir(), "cx-ci-report-home-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const withJunit = async (xml: string): Promise<void> => {
  await writeFile(join(cwd, "junit.xml"), xml);
};

const NOW = new Date("2026-07-24T09:00:00.000Z");

interface ReportOptions {
  readonly env?: Record<string, string | undefined>;
  readonly rerunXml?: string | null;
  readonly calls?: RerunCall[];
  readonly argv?: readonly string[];
}

const report = (hub: Hub | CiReportFetch, options: ReportOptions = {}) =>
  runCiReport(options.argv ?? ARGV, options.env ?? runnerEnv(), cwd, {
    fetch: typeof hub === "function" ? hub : hub.fetch,
    runTests: fakeRunTests(
      options.rerunXml === undefined ? RERUN_GREEN_XML : options.rerunXml,
      options.calls ?? [],
    ),
    now: () => NOW,
  });

describe("§8.3: no secrets is one line and exit 0 — never a red job", () => {
  test("no CROSSCHECK_CI_TOKEN: nothing is sent, nothing is re-run", async () => {
    await withJunit(RED_XML);
    const sent: string[] = [];
    const calls: RerunCall[] = [];
    const fetch: CiReportFetch = async (url) => {
      sent.push(url);
      return Response.json({ ok: true });
    };

    const result = await runCiReport(
      ARGV,
      runnerEnv({ CROSSCHECK_CI_TOKEN: "" }),
      cwd,
      { fetch, runTests: fakeRunTests(RERUN_GREEN_XML, calls), now: () => NOW },
    );

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toContain("CROSSCHECK_CI_TOKEN");
    expect(result.stdout).toContain(SHA.slice(0, 7));
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("no CROSSCHECK_HUB_URL: the same one line, exit 0", async () => {
    await withJunit(GREEN_XML);
    const sent: string[] = [];

    const result = await report(
      async (url) => {
        sent.push(url);
        return Response.json({ ok: true });
      },
      { env: runnerEnv({ CROSSCHECK_HUB_URL: undefined }) },
    );

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("CROSSCHECK_HUB_URL");
    expect(sent).toEqual([]);
  });

  test("a hub url that is not http(s) is named, exit 0", async () => {
    await withJunit(GREEN_XML);

    const result = await report(async () => Response.json({ ok: true }), {
      env: runnerEnv({ CROSSCHECK_HUB_URL: "hub.example:7100" }),
    });

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("CROSSCHECK_HUB_URL");
    expect(result.stdout).toContain("http");
  });

  test("the reporter never reads a developer's config: nothing under HOME is touched", async () => {
    await withJunit(GREEN_XML);
    const hub = await startHub();

    await report(hub, { env: runnerEnv({ HOME: home, CROSSCHECK_HOME: home }) });

    expect(await readdir(home)).toEqual([]);
  });
});

describe("a green suite is one POST and one line", () => {
  test("the hub holds the lane at the head sha with no rows, and no re-run happens", async () => {
    await withJunit(GREEN_XML);
    const hub = await startHub();
    const calls: RerunCall[] = [];

    const result = await report(hub, { calls });

    expect(result.exitCode).toBe(EXIT_OK);
    const runs = await hub.readRuns();
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run?.commitSha).toBe(SHA);
    expect(run?.workflow).toBe("CI");
    expect(run?.job).toBe("test");
    expect(run?.leg).toBe("ubuntu-latest");
    expect(run?.ref).toBe("main");
    expect(run?.runAttempt).toBe(1);
    expect(run?.externalRunId).toBe(RUN_ID);
    expect(run?.rerunKind).toBe("none");
    expect(run?.rerunOf).toBeNull();
    expect(run?.outcome).toBe("completed");
    expect(run?.tests).toBe(2);
    expect(run?.failures).toBe(0);
    expect(run?.results).toEqual([]);
    expect(calls).toEqual([]);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toContain("accepted");
    expect(result.stdout).toContain("tests 2");
  });

  test("the same attempt reported twice is a duplicate, said and exit 0", async () => {
    await withJunit(GREEN_XML);
    const hub = await startHub();
    await report(hub);

    const second = await report(hub);

    expect(second.exitCode).toBe(EXIT_OK);
    expect(second.stdout).toContain("duplicate");
    expect(await hub.readRuns()).toHaveLength(1);
  });
});

describe("D4: a red suite is re-run by file and filed as a same_job re-run", () => {
  test("only the files with a failed test are re-run, into the re-run junit path", async () => {
    await withJunit(RED_XML);
    const hub = await startHub();
    const calls: RerunCall[] = [];

    await report(hub, { calls });

    expect(calls).toEqual([
      { cwd, files: ["packages/a.test.ts"], outfile: "junit-rerun.xml" },
    ]);
  });

  test("a green re-run posts a second row naming the primary, with no rows", async () => {
    await withJunit(RED_XML);
    const hub = await startHub();

    const result = await report(hub, { rerunXml: RERUN_GREEN_XML });

    const runs = await hub.readRuns();
    expect(runs).toHaveLength(2);
    const primary = runs.find((run) => run.rerunKind === "none");
    const rerun = runs.find((run) => run.rerunKind === "same_job");
    expect(primary?.failures).toBe(1);
    expect(primary?.results.map((row) => row.testId)).toEqual([
      "packages/a.test.ts::::red",
    ]);
    expect(rerun?.rerunOf).toBe(primary?.id ?? "missing");
    expect(rerun?.outcome).toBe("completed");
    expect(rerun?.failures).toBe(0);
    expect(rerun?.results).toEqual([]);
    expect(result.stdout.trim().split("\n")).toHaveLength(2);
    expect(result.stdout).toContain("same_job");
  });

  test("a red re-run posts the still-red test on the second row", async () => {
    await withJunit(RED_XML);
    const hub = await startHub();

    await report(hub, { rerunXml: RERUN_RED_XML });

    const rerun = (await hub.readRuns()).find(
      (run) => run.rerunKind === "same_job",
    );
    expect(rerun?.results.map((row) => row.testId)).toEqual([
      "packages/a.test.ts::::red",
    ]);
  });

  test("a re-run whose report never appeared is filed as crashed, not as green", async () => {
    await withJunit(RED_XML);
    const hub = await startHub();

    await report(hub, { rerunXml: null });

    const rerun = (await hub.readRuns()).find(
      (run) => run.rerunKind === "same_job",
    );
    expect(rerun?.outcome).toBe("crashed");
    expect(rerun?.results).toEqual([]);
  });

  test("no failure message, stack or hostname ever reaches the wire", async () => {
    await withJunit(RED_XML);
    const hub = await startHub();
    const bodies: string[] = [];
    const spying: CiReportFetch = (url, init) => {
      bodies.push(String(init.body));
      return hub.fetch(url, init);
    };

    await report(spying);

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain("secret-module");
      expect(body).not.toContain("expected 1 to be 2");
      expect(body).not.toContain("runner");
    }
  });
});

describe("a hub that cannot answer costs the row, never the job — and skips the re-run", () => {
  test("unreachable: one line, exit 0, no re-run", async () => {
    await withJunit(RED_XML);
    const calls: RerunCall[] = [];

    const result = await report(
      async () => {
        throw new Error("Unable to connect");
      },
      { calls },
    );

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("unreachable");
    expect(result.stdout).toContain(SHA.slice(0, 7));
    expect(calls).toEqual([]);
  });

  test("refused (wrong token): the hub's sentence is printed, exit 0, no re-run", async () => {
    await withJunit(RED_XML);
    const hub = await startHub();
    const calls: RerunCall[] = [];

    const result = await report(hub, {
      env: runnerEnv({ CROSSCHECK_CI_TOKEN: "not-the-token" }),
      calls,
    });

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("refused");
    expect(result.stdout).toContain("401");
    expect(calls).toEqual([]);
    expect(await hub.readRuns()).toEqual([]);
  });

  test("a hub with no CI token configured answers 503, and that is printed", async () => {
    await withJunit(GREEN_XML);
    const hub = await startHub(null);

    const result = await report(hub);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("503");
  });

  test("an answer that is not the wire shape is named, not trusted — no re-run hangs off it", async () => {
    await withJunit(RED_XML);
    const calls: RerunCall[] = [];

    const result = await report(
      async () =>
        Response.json(
          {
            ok: true,
            data: { id: "<script>alert(1)</script>", status: "accepted" },
          },
          { status: 201 },
        ),
      { calls },
    );

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).not.toContain("<script>");
    expect(result.stdout).toContain("did not parse");
    expect(calls).toEqual([]);
  });
});

describe("a run with no readable report is crashed, so the lane is seen to have said nothing", () => {
  test("a missing junit file posts a crashed row, exit 0, no re-run", async () => {
    const hub = await startHub();
    const calls: RerunCall[] = [];

    const result = await report(hub, { calls });

    expect(result.exitCode).toBe(EXIT_OK);
    const [run] = await hub.readRuns();
    expect(run?.outcome).toBe("crashed");
    expect(run?.tests).toBe(0);
    expect(run?.results).toEqual([]);
    expect(result.stdout).toContain("crashed");
    expect(calls).toEqual([]);
  });

  test("a half-written junit file posts a crashed row", async () => {
    await withJunit(MEASURED_XML.slice(0, MEASURED_XML.indexOf("dup name")));
    const hub = await startHub();

    await report(hub);

    const [run] = await hub.readRuns();
    expect(run?.outcome).toBe("crashed");
  });

  test("the measured probe run posts its ambiguous count and the sha the workflow resolved", async () => {
    await withJunit(MEASURED_XML);
    const hub = await startHub();

    const result = await report(hub, { rerunXml: RERUN_GREEN_XML });

    const primary = (await hub.readRuns()).find(
      (run) => run.rerunKind === "none",
    );
    expect(primary?.commitSha).toBe(SHA);
    expect(primary?.tests).toBe(7);
    expect(primary?.failures).toBe(4);
    expect(primary?.skipped).toBe(1);
    expect(primary?.ambiguousDropped).toBe(1);
    expect(primary?.results.map((row) => row.testId).sort()).toEqual([
      "probe.test.ts::::top level red",
      "probe.test.ts::::top level skipped",
      "probe.test.ts::a > b::weird describe red",
      "probe.test.ts::outer > inner::nested red",
    ]);
    expect(result.stdout).toContain("ambiguous dropped 1");
  });
});

describe("a workflow author's mistake is a usage error, said with the usage", () => {
  test("a missing --sha is exit 64 and nothing is sent", async () => {
    await withJunit(GREEN_XML);
    const sent: string[] = [];

    const result = await report(
      async (url) => {
        sent.push(url);
        return Response.json({ ok: true });
      },
      { argv: ARGV.slice(0, -2) },
    );

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("--sha");
    expect(sent).toEqual([]);
  });

  test("outside GitHub Actions (no GITHUB_REPOSITORY) the reporter refuses: a local run is never CI (§8.2)", async () => {
    await withJunit(GREEN_XML);

    const result = await report(async () => Response.json({ ok: true }), {
      env: runnerEnv({ GITHUB_REPOSITORY: undefined }),
    });

    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("GITHUB_REPOSITORY");
  });
});
