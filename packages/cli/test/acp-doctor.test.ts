/**
 * The doctor's ACP section (design §3.7), through the REAL runDoctor — which
 * is the only place the dynamic import in `checkAcp` is actually exercised.
 * The section's own unit tests live in connector-acp; these exist because
 * that package's tests would ALL still pass if the CLI never called it, and
 * the failure mode of a broken dynamic import is a single WARN nobody reads.
 *
 * "Not used here" is one PASS line and nothing else: the proxy has no install
 * artifact — it is a command a developer wraps their agent in — so there is
 * nothing true to say about this machine until one has run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { runDoctor } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const REMOTE = "git@github.com:acme/api.git";
/** A port nothing listens on: doctor must print the section regardless. */
const HUB_URL = "http://127.0.0.1:7622";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.map((path) => rm(path, { recursive: true, force: true })),
  );
  cleanups.length = 0;
});

const fixture = async (label: string) => {
  const repo = await makeRepo(label, { remote: REMOTE });
  const home = await makeHome(label);
  cleanups.push(repo, home);
  return {
    repo,
    home,
    env: {
      CROSSCHECK_HOME: home,
      CROSSCHECK_HUB_URL: HUB_URL,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_DOCTOR_NO_PROBE: "1",
    },
  };
};

/** The proxy's own evidence that it has run for this home. */
const withProxyLog = async (home: string): Promise<void> => {
  await mkdir(join(home, "logs"), { recursive: true });
  await writeFile(join(home, "logs", "acp-4242.log"), "capture\n");
};

describe("doctor's acp section", () => {
  test("no proxy has run here: one informational PASS line, nothing else", async () => {
    // Arrange
    const { repo, env } = await fixture("acp-doc-none");

    // Act
    const result = await runDoctor(env, repo);

    // Assert
    expect(result.stdout).toContain("PASS  acp proxy  not used here");
    expect(result.stdout).not.toContain("(acp)");
  });

  test("once a proxy has run, every rung and every refusal is a sentence", async () => {
    // Arrange
    const { repo, home, env } = await fixture("acp-doc-used");
    await withProxyLog(home);

    // Act
    const result = await runDoctor(env, repo);

    // Assert — the four rungs
    expect(result.stdout).toContain("PASS  intent (acp)  full —");
    expect(result.stdout).toContain("PASS  ghost (acp)  full —");
    expect(result.stdout).toContain("PASS  summarizer (acp)  reduced —");
    expect(result.stdout).toContain("PASS  conference (acp)  full —");
    // and the four refusals, which are the half that is easy to skip
    expect(result.stdout).toContain("PASS  forward-path capture (acp)");
    expect(result.stdout).toContain("PASS  pre-edit ask (acp)");
    expect(result.stdout).toContain("PASS  agent reasoning capture (acp)");
    expect(result.stdout).toContain("PASS  command and content capture (acp)");
    // the "not used" line is gone, not printed beside the rungs
    expect(result.stdout).not.toContain("acp proxy  not used here");
  });

  test("the section survives a dead hub — it describes the protocol, not the network", async () => {
    // Arrange: HUB_URL points at a port nothing listens on (see above).
    const { repo, home, env } = await fixture("acp-doc-dead-hub");
    await withProxyLog(home);

    // Act
    const result = await runDoctor(env, repo);

    // Assert — and NOT the contained-failure WARN, which would mean the
    // dynamic import broke and the whole section silently became one line.
    expect(result.stdout).toContain("PASS  summarizer (acp)  reduced —");
    expect(result.stdout).not.toContain("acp section unavailable");
  });
});
