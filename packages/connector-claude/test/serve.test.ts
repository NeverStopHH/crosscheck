import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const BIN_PATH = resolve(import.meta.dir, "..", "src", "bin", "crosscheck.ts");

/** Cold PGlite boot plus Hono routing, with slack for a loaded machine. */
const SERVE_READY_TIMEOUT_MS = 20_000;
/** A SIGTERM that takes longer than this is a hang, not a shutdown. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** Ephemeral-range port, random so parallel test runs cannot collide. */
const randomPort = (): number => 20_000 + Math.floor(Math.random() * 20_000);

let proc: ReturnType<typeof Bun.spawn> | undefined;

afterEach(() => {
  proc?.kill();
  proc = undefined;
});

const readUntil = async (
  stream: ReadableStream<Uint8Array>,
  marker: string,
  timeoutMs: number,
): Promise<string> => {
  const decoder = new TextDecoder();
  let seen = "";
  const reader = stream.getReader();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolveRace) => {
          setTimeout(() => resolveRace("timeout"), deadline - Date.now());
        }),
      ]);
      if (next === "timeout" || next.done) {
        break;
      }
      seen += decoder.decode(next.value, { stream: true });
      if (seen.includes(marker)) {
        return seen;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return seen;
};

describe("crosscheck serve", () => {
  test("boots the hub, answers /ui/login, and dies cleanly on SIGTERM", async () => {
    // Arrange: in-memory PGlite (no CROSSCHECK_DATA_DIR), a port nobody holds
    const port = randomPort();
    proc = Bun.spawn({
      cmd: [process.execPath, BIN_PATH, "serve"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PORT: String(port) },
    });

    // Act
    const banner = await readUntil(
      proc.stdout as ReadableStream<Uint8Array>,
      "listening",
      SERVE_READY_TIMEOUT_MS,
    );
    const response = await fetch(`http://127.0.0.1:${port}/ui/login`);
    proc.kill("SIGTERM");
    const exit = await Promise.race([
      proc.exited,
      new Promise<"hung">((resolveRace) => {
        setTimeout(() => resolveRace("hung"), SHUTDOWN_TIMEOUT_MS);
      }),
    ]);

    // Assert: the DESIGN.md §2 one-liner — port in the banner, UI reachable,
    // and SIGTERM actually ends the process instead of wedging PGlite.
    expect(banner).toContain(`listening on :${port}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("crosscheck");
    expect(exit).not.toBe("hung");
  }, SERVE_READY_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS);

  test("refuses a port something else already holds, and says which", async () => {
    // Arrange: a FOREIGN listener on the port. Bun.serve on macOS binds over
    // it with reuse semantics — without a probe the second hub prints the
    // healthy banner while the kernel splits traffic between two servers.
    const port = randomPort();
    const holder = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    });
    try {
      proc = Bun.spawn({
        cmd: [process.execPath, BIN_PATH, "serve"],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PORT: String(port) },
      });

      // Act
      const exit = await Promise.race([
        proc.exited,
        new Promise<"hung">((resolveRace) => {
          setTimeout(() => resolveRace("hung"), SERVE_READY_TIMEOUT_MS);
        }),
      ]);
      if (exit === "hung") {
        proc.kill();
      }
      const stderrText = await new Response(
        proc.stderr as ReadableStream<Uint8Array>,
      ).text();
      const stdoutText = await new Response(
        proc.stdout as ReadableStream<Uint8Array>,
      ).text();

      // Assert: loud refusal, no lying banner
      expect(exit).toBe(2);
      expect(stderrText).toContain("already in use");
      expect(stdoutText).not.toContain("listening");
    } finally {
      holder.stop();
    }
  }, SERVE_READY_TIMEOUT_MS + SHUTDOWN_TIMEOUT_MS);
});
