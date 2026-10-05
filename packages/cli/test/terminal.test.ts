/**
 * The one conversation this CLI holds with a person (1.0 spec 07 §12):
 * `crosscheck pilot label` reads ONE KEY per intervention, and a line only
 * when the person asked to add a reason.
 *
 * Driven through a fake input stream, because the walk's own tests use a
 * scripted terminal and never touch these reads. What these pin is what a
 * real terminal would show going wrong: a terminal left in raw mode after
 * the walk (no echo, no line editing — the shell looks broken), Ctrl-C in
 * raw mode arriving as a byte nobody treats as "stop", and a listener left
 * behind that swallows the next read's input.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { terminalFrom } from "../src/cli/terminal.ts";

/**
 * A stdin stand-in that records the raw-mode switches it was asked for and,
 * like a real stream, HOLDS what arrives while it is paused until the next
 * resume — a reader that pauses between reads loses nothing.
 */
class FakeInput extends EventEmitter {
  readonly modes: boolean[] = [];
  private flowing = false;
  private held: (readonly [string, unknown])[] = [];

  setRawMode(mode: boolean): this {
    this.modes.push(mode);
    return this;
  }

  /** What the person typed (or the stream did), delivered now or on the next resume. */
  send(event: "data" | "end", chunk?: unknown): void {
    if (this.flowing) {
      this.emit(event, chunk);
    } else {
      this.held = [...this.held, [event, chunk]];
    }
  }

  resume(): this {
    this.flowing = true;
    while (this.flowing && this.held.length > 0) {
      const [[event, chunk], ...rest] = this.held as [readonly [string, unknown], ...(readonly [string, unknown])[]];
      this.held = rest;
      this.emit(event, chunk);
    }
    return this;
  }

  pause(): this {
    this.flowing = false;
    return this;
  }
}

const silent = (): void => {};

describe("terminalFrom — one key", () => {
  test("a key is read in raw mode, and the terminal is put back after", async () => {
    // Arrange
    const input = new FakeInput();
    const terminal = terminalFrom(input, silent);

    // Act
    input.send("data", Buffer.from("h"));
    const key = await terminal.readKey();

    // Assert
    expect(key).toBe("h");
    expect(input.modes).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
  });

  test("Ctrl-C and Ctrl-D stop the walk — raw mode delivers them as bytes, not signals", async () => {
    // Arrange
    const input = new FakeInput();
    const terminal = terminalFrom(input, silent);

    // Act — one read after the other, as the walk does
    input.send("data", "\u0003");
    const interrupt = await terminal.readKey();
    input.send("data", "\u0004");
    const endOfFile = await terminal.readKey();

    // Assert
    expect(interrupt).toBeNull();
    expect(endOfFile).toBeNull();
    expect(input.modes).toEqual([true, false, true, false]);
  });

  test("a closed input stops the walk, and the terminal is still put back", async () => {
    // Arrange
    const input = new FakeInput();
    const terminal = terminalFrom(input, silent);

    // Act
    input.send("end");
    const key = await terminal.readKey();

    // Assert
    expect(key).toBeNull();
    expect(input.modes).toEqual([true, false]);
  });

  test("a key outside ASCII is one key, not half of one", async () => {
    // Arrange
    const input = new FakeInput();
    const terminal = terminalFrom(input, silent);

    // Act
    input.send("data", Buffer.from("é"));
    const key = await terminal.readKey();

    // Assert
    expect(key).toBe("é");
  });
});

describe("terminalFrom — one line", () => {
  test("a line is read as typed, without its line ending, never in raw mode", async () => {
    // Arrange — cooked mode: the terminal echoes and edits the line itself
    const input = new FakeInput();
    const terminal = terminalFrom(input, silent);

    // Act — the line arrives in two pieces, as a slow paste can
    input.send("data", "pointed at ");
    input.send("data", "a closed PR\r\n");
    const line = await terminal.readLine();

    // Assert
    expect(line).toBe("pointed at a closed PR");
    expect(input.modes).toEqual([]);
    expect(input.listenerCount("data")).toBe(0);
  });

  test("input that ends before the line does is a stop, not half a sentence", async () => {
    // Arrange
    const input = new FakeInput();
    const terminal = terminalFrom(input, silent);

    // Act
    input.send("data", "half a sen");
    input.send("end");
    const line = await terminal.readLine();

    // Assert
    expect(line).toBeNull();
  });
});

describe("terminalFrom — output", () => {
  test("what the walk says is written as it goes", () => {
    // Arrange
    const written: string[] = [];
    const terminal = terminalFrom(new FakeInput(), (text) => {
      written.push(text);
    });

    // Act
    terminal.write("[1/3] ");

    // Assert
    expect(written).toEqual(["[1/3] "]);
  });
});
