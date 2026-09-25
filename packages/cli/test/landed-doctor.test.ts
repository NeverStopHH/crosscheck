/**
 * `doctor` SAYS WHICH LANDING BRANCHES THE PRE-EDIT STOP WATCHES.
 *
 * The landed-change stop (docs/1.0/landed-changes.md) fails open by design:
 * a list git cannot use, branches origin does not have, or a clone with no
 * origin at all, and it simply never fires. That silence is indistinguishable
 * from "nothing landed" — so the one place a person looks when something
 * seems off has to name the branches in effect and every reason the stop
 * cannot see them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createDb, createServer } from "@crosscheck/server";

import { runCli } from "../src/index.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import { gitIn, makeLandingRepos } from "../../connector-core/test/fixtures/landing-repos.ts";

const ADMIN_TOKEN = "landed-doctor-admin";

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let apiKey: string;
const cleanups: string[] = [];

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: createServer({ db: await createDb(), adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Nick", email: "nick-landed-doctor@example.com" }),
  });
  apiKey = ((await response.json()) as { data: { apiKey: string } }).data.apiKey;
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

/** Doctor in Nick's clone, with `landingBranches` as given (absent when undefined). */
const doctorWith = async (
  label: string,
  landingBranches?: unknown,
  onOrigin: readonly string[] = ["staging"],
): Promise<string> => {
  const repos = await makeLandingRepos(label, onOrigin);
  const home = await makeHome(label);
  cleanups.push(repos.base, home);
  await writeFile(
    join(repos.reader, ".crosscheck.json"),
    JSON.stringify({ hubUrl, ...(landingBranches === undefined ? {} : { landingBranches }) }),
  );
  const result = await runCli(
    ["doctor"],
    { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: apiKey },
    repos.reader,
  );
  return result.stdout;
};

describe("doctor's landed-changes line", () => {
  test("names the auto-detected branches and says how to choose others", async () => {
    const stdout = await doctorWith("doctor-auto");

    expect(stdout).toContain("PASS  landed changes  main, staging (auto-detected");
    expect(stdout).toContain("landingBranches");
  });

  test("names the team's own branches as coming from .crosscheck.json", async () => {
    const stdout = await doctorWith("doctor-configured", ["staging"]);

    expect(stdout).toContain("PASS  landed changes  staging (from .crosscheck.json)");
  });

  test("warns about a list it cannot use, and says what it uses instead", async () => {
    const stdout = await doctorWith("doctor-invalid", ["-rf"]);

    expect(stdout).toContain("WARN  landed changes  landingBranches must be");
    expect(stdout).toContain("auto-detection is used instead (main, staging)");
  });

  test("warns about a named branch origin does not have", async () => {
    const stdout = await doctorWith("doctor-missing", ["staging", "release"]);

    expect(stdout).toContain("WARN  landed changes  staging (from .crosscheck.json); not on origin in this clone: release");
  });

  test("says it is switched off when the team listed no branches", async () => {
    const stdout = await doctorWith("doctor-off", []);

    expect(stdout).toContain("PASS  landed changes  switched off");
  });

  test("warns in a shallow clone, where the stop stays silent on purpose", async () => {
    // Arrange — a shallow boundary reads as touching every file, so the probe refuses it
    const repos = await makeLandingRepos("doctor-shallow");
    const home = await makeHome("doctor-shallow");
    cleanups.push(repos.base, home);
    const shallow = join(repos.base, "shallow");
    await gitIn(repos.base, ["clone", "-q", "--depth", "1", "--no-single-branch", `file://${repos.origin}`, shallow]);
    await writeFile(join(shallow, ".crosscheck.json"), JSON.stringify({ hubUrl }));

    // Act
    const { stdout } = await runCli(
      ["doctor"],
      { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: apiKey },
      shallow,
    );

    // Assert
    expect(stdout).toContain("WARN  landed changes  this is a shallow clone");
    expect(stdout).toContain("git fetch --unshallow");
  });

  test("says there is nothing to watch yet when this clone has no origin, without a warning", async () => {
    // Arrange — Mike's clone, remote removed
    const repos = await makeLandingRepos("doctor-no-origin");
    const home = await makeHome("doctor-no-origin");
    cleanups.push(repos.base, home);
    await gitIn(repos.teammate, ["remote", "remove", "origin"]);
    await writeFile(join(repos.teammate, ".crosscheck.json"), JSON.stringify({ hubUrl }));

    // Act
    const { stdout } = await runCli(
      ["doctor"],
      { CROSSCHECK_HOME: home, HOME: home, CROSSCHECK_HUB_URL: hubUrl, CROSSCHECK_API_KEY: apiKey },
      repos.teammate,
    );

    // Assert — a brand-new repo is not broken; it has nothing landed yet
    expect(stdout).toContain("PASS  landed changes  nothing to watch yet");
  });
});
