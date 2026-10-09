/**
 * EVERY WAY A GUARD CAN FAIL, for test/mutation-runner.test.ts: one per value
 * of CX_RUNNER_OUTCOME, and nothing at all without it — in the ordinary suite
 * every test here is skipped.
 */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const OUTCOME = process.env["CX_RUNNER_OUTCOME"];
const NEVER_MS = 50;

if (OUTCOME === "import") {
  throw new TypeError("thrown while the file loads");
}
if (OUTCOME === "silent") {
  process.exit(1);
}

test.if(OUTCOME === "assertion")("an assertion fails", () => {
  expect(1).toBe(2);
});

test.if(OUTCOME === "plain-error")("an Error is thrown", () => {
  throw new Error("plain");
});

test.if(OUTCOME === "type-error")("a TypeError is thrown", () => {
  const value = undefined as unknown as { readonly map: () => void };
  value.map();
});

test.if(OUTCOME === "missing-file")("a file that is not there is read", async () => {
  await readFile("/nonexistent/cx-runner-outcome");
});

test.if(OUTCOME === "timeout")(
  "a test times out",
  () => new Promise<void>(() => undefined),
  NEVER_MS,
);
