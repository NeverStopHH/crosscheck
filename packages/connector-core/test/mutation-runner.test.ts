/**
 * THE MUTATION PROOF'S READING OF BUN (scripts/mutation-check.ts
 * failedOnAssertion), against bun's own report: each way a guard can fail is
 * a real `bun test` run of fixtures/runner-outcomes.test.ts, and only an
 * assertion or a thrown error — whatever its name — reads as a catch.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { failedOnAssertion } from "../scripts/mutation-check.ts";

const FIXTURE = resolve(import.meta.dir, "fixtures", "runner-outcomes.test.ts");
/** A fixture run is a whole bun process: room for one on a loaded runner. */
const RUN_TIMEOUT_MS = 60_000;

interface Report {
  readonly exitCode: number;
  readonly output: string;
}

const reportOf = async (outcome: string): Promise<Report> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, "test", FIXTURE],
    env: { ...process.env, CX_RUNNER_OUTCOME: outcome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, output: `${stdout}\n${stderr}` };
};

const OUTCOMES: readonly (readonly [string, boolean])[] = [
  ["assertion", true],
  ["plain-error", true],
  ["type-error", true],
  ["missing-file", true],
  ["import", true],
  ["timeout", false],
  ["silent", false],
];

describe("the mutation proof reads a guard that failed", () => {
  for (const [outcome, isCatch] of OUTCOMES) {
    test(
      `${outcome}: ${isCatch ? "a catch" : "no catch"}`,
      async () => {
        // Act
        const report = await reportOf(outcome);

        // Assert
        expect(report.exitCode).not.toBe(0);
        expect(failedOnAssertion(report.output)).toBe(isCatch);
      },
      RUN_TIMEOUT_MS,
    );
  }
});
