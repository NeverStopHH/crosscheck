/**
 * `--record`: the parsed-copy stream written for Block-4 development and
 * per-agent capture-quality measurement (design §6 open question 1). Same
 * fail-open bar as the logger — a broken record file costs the recording,
 * never the session.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAcpRecorder } from "../src/recorder.ts";
import type { ObservedLine } from "../src/observer.ts";

const makeDir = (): Promise<string> => mkdtemp(join(tmpdir(), "acp-recorder-"));

const line = (text: string, parsedOk: boolean, atEof = false): ObservedLine => ({
  kind: "line",
  text,
  parsedOk,
  bytes: text.length,
  atEof,
});

const OVERSIZED: ObservedLine = {
  kind: "oversized",
  text: "",
  parsedOk: false,
  bytes: 2_000_000,
  atEof: false,
};

describe("record entries", () => {
  test("writes one NDJSON entry per observed line, direction and verdict included", async () => {
    // Arrange
    const path = join(await makeDir(), "wire.ndjson");
    const recorder = createAcpRecorder(path);

    // Act
    recorder.record("c2a", line('{"jsonrpc":"2.0","id":1}', true), 1000);
    recorder.record("a2c", line("not json", false), 2000);
    await recorder.flush();

    // Assert
    const entries = (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(entries).toEqual([
      { t: 1000, dir: "c2a", line: '{"jsonrpc":"2.0","id":1}', parsed: true },
      { t: 2000, dir: "a2c", line: "not json", parsed: false },
    ]);
  });

  test("an oversized line records its byte count, never its content", async () => {
    const path = join(await makeDir(), "wire.ndjson");
    const recorder = createAcpRecorder(path);

    recorder.record("a2c", OVERSIZED, 3000);
    await recorder.flush();

    const entry = JSON.parse((await readFile(path, "utf8")).trimEnd()) as Record<
      string,
      unknown
    >;
    expect(entry).toEqual({ t: 3000, dir: "a2c", oversized: 2_000_000 });
  });

  test("a partial frame at stream end carries the eof flag", async () => {
    const path = join(await makeDir(), "wire.ndjson");
    const recorder = createAcpRecorder(path);

    recorder.record("a2c", line('{"half":', false, true), 4000);
    await recorder.flush();

    const entry = JSON.parse((await readFile(path, "utf8")).trimEnd()) as Record<
      string,
      unknown
    >;
    expect(entry["eof"]).toBe(true);
  });
});

describe("failure degrades to drop counters", () => {
  test("an unwritable record path counts drops and never throws", async () => {
    // Arrange: the record file's parent directory does not exist.
    const recorder = createAcpRecorder(
      join(await makeDir(), "missing-subdir", "wire.ndjson"),
    );

    // Act
    expect(() => {
      recorder.record("c2a", line("{}", true), 1);
      recorder.record("c2a", line("{}", true), 2);
    }).not.toThrow();
    await recorder.flush();
    recorder.record("c2a", line("{}", true), 3);
    await recorder.flush();

    // Assert: the failed write and everything after it are counted.
    expect(recorder.drops()).toBeGreaterThanOrEqual(2);
  });

  test("a stuck disk drops entries past the pending cap instead of buffering forever", async () => {
    const recorder = createAcpRecorder(join(await makeDir(), "wire.ndjson"), {
      maxPendingBytes: 120,
      append: () => new Promise<void>(() => {}),
    });

    recorder.record("c2a", line("x".repeat(50), false), 1);
    recorder.record("c2a", line("y".repeat(50), false), 2);
    recorder.record("c2a", line("z".repeat(50), false), 3);

    expect(recorder.drops()).toBeGreaterThan(0);
  });
});
