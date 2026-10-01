/**
 * `crosscheck pilot label` end to end (1.0 spec 07 §12): the command driven
 * through `runCli`, a REAL in-process hub, a REAL repository per scenario —
 * so each scenario's report counts only its own labels — and a SCRIPTED
 * terminal standing in for the person's keys.
 *
 * What these pin:
 *   · one key per intervention, newest first, showing what was shown, when
 *     and on which channel; the label reaches the report as the word typed;
 *   · the review's example through the walk: 4 helpful and 10 noise is a
 *     precision of 4/14, whatever two per-100 rates would have said;
 *   · a reason only when the person asks for one (Shift), bounded and
 *     secret-scanned HERE, before anything leaves the machine;
 *   · skip, stop and end of input record nothing they were not told;
 *   · an agent — no terminal — is refused before anything is listed;
 *   · `crosscheck noise` stays the one-word shortcut for the `n` key.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { createDb, createServer } from "@crosscheck/server";
import { QUOTED_DATA_NOTICE } from "@crosscheck/connector-core/briefing/render.ts";
import {
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
} from "@crosscheck/connector-core/constants.ts";
import { MAX_PILOT_LABEL_REASON_CHARS, deliveryIdFor } from "@crosscheck/schema";

import { runCli } from "../src/index.ts";
import type { LabelTerminal } from "../src/cli/terminal.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "label-cli-admin";
const MS_PER_MINUTE = 60_000;
const UNREACHABLE_HUB = "http://127.0.0.1:1";
const SUMMARY_TAIL =
  "Each label counts once toward this repo's pilot figures and names nobody.";

let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let ken: Developer;
const cleanup: string[] = [];

interface Developer {
  readonly apiKey: string;
  readonly id: string;
}

interface Scenario {
  readonly repoRoot: string;
  readonly repoId: string;
  readonly reader: Developer;
  readonly sessionId: string;
  readonly kenSessionId: string;
  readonly home: string;
}

interface Script {
  readonly terminal: LabelTerminal;
  readonly transcript: () => string;
}

const send = (method: string, path: string, apiKey: string, body: unknown): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const createDeveloper = async (name: string): Promise<Developer> => {
  const response = await send("POST", "/api/developers", ADMIN_TOKEN, {
    name,
    email: `${name.toLowerCase().replaceAll(" ", "-")}@example.com`,
  });
  const body = (await response.json()) as { data: { apiKey: string; developer: { id: string } } };
  return { apiKey: body.data.apiKey, id: body.data.developer.id };
};

const envelope = (developerId: string, sessionId: string, kind: string, body: unknown): unknown => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: new Date().toISOString(),
  producer: { developerId, agentKind: "claude-code", sessionId },
  kind,
  body,
});

const registerSession = async (developer: Developer, repoId: string): Promise<string> => {
  const id = `cc_${crypto.randomUUID()}`;
  const response = await send("POST", "/api/sessions", developer.apiKey, {
    id,
    agentKind: "claude-code",
    repo: repoId,
    branch: "main",
    baseCommit: "a1b2c3d4",
    status: "implementing",
  });
  expect(response.status).toBeLessThan(300);
  return id;
};

/** Ken's work context on this scenario's repo — the prior work a pointer names. */
const kenContext = async (s: Scenario, id: string, title: string): Promise<void> => {
  const response = await send("POST", "/api/records", ken.apiKey, {
    records: [
      envelope(ken.id, s.kenSessionId, "work_context", {
        id,
        sessionId: s.kenSessionId,
        title,
        status: "implementing",
        createdAt: new Date().toISOString(),
      }),
    ],
  });
  expect(response.status).toBe(200);
};

/** A fresh repo, enrolled, with one reader and one session of theirs, and Ken working on it. */
const scenario = async (name: string): Promise<Scenario> => {
  const repoRoot = await makeRepo(`label-${name}`, { remote: `git@github.com:acme/label-${name}.git` });
  const repoId = `github.com/acme/label-${name}`;
  const home = await makeHome(`label-${name}`);
  cleanup.push(repoRoot, home);
  const reader = await createDeveloper(`Reader ${name}`);
  const sessionId = await registerSession(reader, repoId);
  const kenSessionId = await registerSession(ken, repoId);
  await send("PUT", "/api/team-settings", ADMIN_TOKEN, { repo: repoId, pilotEnrolled: true });
  return { repoRoot, repoId, reader, sessionId, kenSessionId, home };
};

/** One unasked pointer at `refId`, delivered to the reader's session `minutesAgo`. */
const deliver = async (
  s: Scenario,
  refId: string,
  minutesAgo: number,
  channel: "briefing" | "prompt_hint" | "tripwire" = "prompt_hint",
): Promise<string> => {
  const id = deliveryIdFor(s.sessionId, refId, channel);
  const response = await send("POST", "/api/records", s.reader.apiKey, {
    records: [
      envelope(s.reader.id, s.sessionId, "hint_delivery", {
        id,
        sessionId: s.sessionId,
        refKind: "work_context",
        refId,
        channel,
        deliveredAt: new Date(Date.now() - minutesAgo * MS_PER_MINUTE).toISOString(),
      }),
    ],
  });
  expect(response.status).toBe(200);
  return id;
};

/** The person at the keyboard: these keys, then these lines, then nothing. */
const scripted = (keys: readonly string[], lines: readonly string[] = []): Script => {
  const written: string[] = [];
  const keyQueue = keys[Symbol.iterator]();
  const lineQueue = lines[Symbol.iterator]();
  const next = (queue: Iterator<string>): string | null => {
    const step = queue.next();
    return step.done === true ? null : step.value;
  };
  return {
    terminal: {
      write: (text) => {
        written.push(text);
      },
      readKey: () => Promise.resolve(next(keyQueue)),
      readLine: () => Promise.resolve(next(lineQueue)),
    },
    transcript: () => written.join(""),
  };
};

const env = (s: Scenario, hub: string = hubUrl): Record<string, string> => ({
  CROSSCHECK_HOME: s.home,
  HOME: s.home,
  CROSSCHECK_HUB_URL: hub,
  CROSSCHECK_API_KEY: s.reader.apiKey,
  CROSSCHECK_TIMEOUT_MS: "4000",
});

const walk = (
  s: Scenario,
  script: Script,
  options: { readonly interactive?: boolean; readonly argv?: readonly string[]; readonly hub?: string } = {},
): Promise<{ stdout: string; exitCode: number }> =>
  runCli(["pilot", "label", ...(options.argv ?? [])], env(s, options.hub), s.repoRoot, undefined, {
    isInteractive: () => options.interactive ?? true,
    terminal: script.terminal,
  });

interface ReportFigures {
  readonly helpful: number;
  readonly noise: number;
  readonly unclear: number;
  readonly precision: { readonly kind: string; readonly value?: number };
  readonly reasons: readonly { readonly label: string; readonly reason: string }[];
}

const reportOf = async (s: Scenario): Promise<ReportFigures> => {
  const response = await fetch(
    `${hubUrl}/api/pilot/report?repo=${encodeURIComponent(s.repoId)}&days=1`,
    { headers: { Authorization: `Bearer ${s.reader.apiKey}` } },
  );
  const body = (await response.json()) as { data: { precision: ReportFigures } };
  return body.data.precision;
};

beforeAll(async () => {
  const db = await createDb();
  server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  ken = await createDeveloper("Ken Label");
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe("crosscheck pilot label — the walk", () => {
  test("one key per intervention, newest first, showing what was shown, when and on which channel", async () => {
    // Arrange — three unasked pointers, one per channel a person can be reached on
    const s = await scenario("walk");
    await kenContext(s, "wc_walk_filters", "Widen the filter row");
    await kenContext(s, "wc_walk_playback", "Fix playback");
    await deliver(s, "wc_walk_filters", 30, "briefing");
    await deliver(s, "wc_walk_playback", 10, "prompt_hint");
    await deliver(s, "wc_walk_filters", 2, "tripwire");
    const script = scripted(["h", "n", "u"]);

    // Act
    const result = await walk(s, script);

    // Assert — what the person saw, in order
    const seen = script.transcript();
    expect(result.exitCode).toBe(EXIT_OK);
    expect(seen).toContain("3 interventions reached you on this repo in the last 24 hours and are not labelled yet");
    expect(seen).toContain("one key each: h helpful · n noise · u unclear · s skip · q stop — Shift (H, N, U) adds a one-sentence reason");
    expect(seen).toContain(QUOTED_DATA_NOTICE);
    expect(seen).toContain("[1/3] tripwire ask before an edit · 2m ago · pointed at wc_walk_filters «Widen the filter row»");
    expect(seen).toContain("[2/3] mid-prompt hint · 10m ago · pointed at wc_walk_playback «Fix playback»");
    expect(seen).toContain("[3/3] session briefing · 30m ago · pointed at wc_walk_filters «Widen the filter row»");
    expect(seen.indexOf("[1/3]")).toBeLessThan(seen.indexOf("[2/3]"));
    expect(seen).toContain("  recorded: helpful\n");
    expect(seen).toContain("  recorded: noise\n");
    expect(seen).toContain("  recorded: unclear\n");
    // nothing asked for a sentence: a lowercase key is the whole gesture
    expect(seen).not.toContain("reason, one sentence");
    expect(result.stdout).toBe(
      `labelled 3 of 3 — helpful 1 · noise 1 · unclear 1 · skipped 0. ${SUMMARY_TAIL}\n`,
    );
    // …and the report counts each as the word typed
    expect(await reportOf(s)).toMatchObject({ helpful: 1, noise: 1, unclear: 1 });
  });

  test("the review's example through the walk: 4 helpful and 10 noise is precision 4/14", async () => {
    // Arrange — fourteen interventions a person labelled; two per-100 rates
    // could both look fine here, and the precision is 29%
    const s = await scenario("review");
    for (let index = 0; index < 14; index += 1) {
      await deliver(s, `wc_review_${String(index)}`, 14 - index);
    }
    const keys = [...Array.from({ length: 4 }, () => "h"), ...Array.from({ length: 10 }, () => "n")];

    // Act
    const result = await walk(s, scripted(keys));

    // Assert
    expect(result.stdout).toContain("labelled 14 of 14 — helpful 4 · noise 10 · unclear 0");
    expect((await reportOf(s)).precision).toEqual({ kind: "measured", value: 4 / 14 });
  });

  test("s skips: nothing is recorded, and the same intervention is offered again next time", async () => {
    // Arrange
    const s = await scenario("skip");
    await deliver(s, "wc_skip_a", 5);

    // Act
    const first = scripted(["s"]);
    const result = await walk(s, first);
    const again = scripted([]);
    await walk(s, again);

    // Assert
    expect(first.transcript()).toContain("  skipped — it is offered again next time\n");
    expect(result.stdout).toContain("labelled 0 of 1 — helpful 0 · noise 0 · unclear 0 · skipped 1");
    expect(again.transcript()).toContain("[1/1]");
    expect(await reportOf(s)).toMatchObject({ helpful: 0, noise: 0, unclear: 0 });
  });

  test("a stray key is asked again, never taken as a decision", async () => {
    // Arrange
    const s = await scenario("stray");
    await deliver(s, "wc_stray_a", 5);
    const script = scripted(["x", " ", "n"]);

    // Act
    await walk(s, script);

    // Assert
    expect(script.transcript().split("press h, n, u, s or q — Shift adds a reason")).toHaveLength(3);
    expect(await reportOf(s)).toMatchObject({ noise: 1, helpful: 0, unclear: 0 });
  });

  test("q stops the walk: what was labelled stays, the rest is not reached and waits", async () => {
    // Arrange
    const s = await scenario("stop");
    await deliver(s, "wc_stop_a", 3);
    await deliver(s, "wc_stop_b", 2);
    await deliver(s, "wc_stop_c", 1);

    // Act
    const result = await walk(s, scripted(["h", "q"]));
    const after = scripted([]);
    await walk(s, after);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toBe(
      `labelled 1 of 3 — helpful 1 · noise 0 · unclear 0 · skipped 0 · stopped with 2 not reached. ${SUMMARY_TAIL}\n`,
    );
    expect(after.transcript()).toContain("2 interventions reached you");
  });

  test("end of input stops like q, and records nothing it was not told", async () => {
    // Arrange — Ctrl-D, or a closed stdin
    const s = await scenario("eof");
    await deliver(s, "wc_eof_a", 3);

    // Act
    const result = await walk(s, scripted([]));

    // Assert
    expect(result.stdout).toContain("labelled 0 of 1 — helpful 0 · noise 0 · unclear 0 · skipped 0 · stopped with 1 not reached");
    expect(await reportOf(s)).toMatchObject({ helpful: 0, noise: 0, unclear: 0 });
  });

  test("past the bound the walk takes the newest twenty, and says the rest are waiting", async () => {
    // Arrange — one more than a sitting walks (PILOT_LABEL_MAX_CANDIDATES)
    const s = await scenario("bound");
    for (let index = 0; index < 21; index += 1) {
      await deliver(s, `wc_bound_${String(index)}`, 21 - index);
    }
    const script = scripted([]);

    // Act — the person stops at once
    const result = await walk(s, script);

    // Assert — the cut is said at the top and at the end, never silent
    expect(script.transcript()).toContain(
      "20+ interventions reached you on this repo in the last 24 hours and are not labelled yet — this run walks the newest 20, the rest wait for the next",
    );
    expect(result.stdout).toContain("stopped with 20 not reached");
    expect(result.stdout).toContain("more are waiting past these — run crosscheck pilot label again");
  });

  test("an intervention labelled elsewhere meanwhile says so, and the first label stands", async () => {
    // Arrange — the person typed `crosscheck noise` in another terminal
    // while this walk waited on the key
    const s = await scenario("race");
    const id = await deliver(s, "wc_race_a", 3);
    const script = scripted([]);
    const racing: LabelTerminal = {
      ...script.terminal,
      readKey: async () => {
        await send("POST", "/api/pilot-marks", s.reader.apiKey, {
          repo: s.repoId,
          refKind: "hint_delivery",
          refId: id,
          mark: "noise",
          presence: "controlling_terminal",
        });
        return "h";
      },
    };

    // Act
    await walk(s, { ...script, terminal: racing });

    // Assert
    expect(script.transcript()).toContain("  already labelled — a label counts once, and a second one changes nothing\n");
    expect(await reportOf(s)).toMatchObject({ helpful: 0, noise: 1 });
  });
});

describe("crosscheck pilot label — a reason, only when asked for", () => {
  test("Shift adds a reason: it is stored, and the report quotes it beside its label", async () => {
    // Arrange
    const s = await scenario("reason");
    await deliver(s, "wc_reason_a", 4);
    const script = scripted(["N"], ["pointed at a PR that closed last week"]);

    // Act
    await walk(s, script);

    // Assert
    expect(script.transcript()).toContain("  reason, one sentence (Enter for none) › ");
    expect(script.transcript()).toContain("  recorded: noise, with your reason\n");
    expect((await reportOf(s)).reasons).toEqual([
      { label: "noise", reason: "pointed at a PR that closed last week" },
    ]);
  });

  test("Enter at the reason prompt records the label without one", async () => {
    // Arrange
    const s = await scenario("enter");
    await deliver(s, "wc_enter_a", 4);

    // Act
    await walk(s, scripted(["H"], [""]));

    // Assert
    const figures = await reportOf(s);
    expect(figures.helpful).toBe(1);
    expect(figures.reasons).toEqual([]);
  });

  test("a reason that looks like a secret never leaves this machine; the person is asked again", async () => {
    // Arrange — the hub scans too, but a token that reached the hub has
    // already crossed the network and sits in its request log
    const s = await scenario("secret");
    await deliver(s, "wc_secret_a", 4);
    const script = scripted(["H"], ["it printed ghp_abcdefghijklmnopqrstuvwxyz0123 in the hint", ""]);

    // Act
    await walk(s, script);

    // Assert — said, not sent; the label itself still counts
    expect(script.transcript()).toContain(
      "  that looks like it holds a secret (a key, a token, a password), so it was not sent — type it again without it, or press Enter for none\n",
    );
    const figures = await reportOf(s);
    expect(figures.helpful).toBe(1);
    expect(JSON.stringify(figures)).not.toContain("ghp_");
  });

  test("a reason past one sentence is refused at the terminal and asked again", async () => {
    // Arrange
    const s = await scenario("long");
    await deliver(s, "wc_long_a", 4);
    const tooLong = "x".repeat(MAX_PILOT_LABEL_REASON_CHARS + 1);
    const script = scripted(["U"], [tooLong, "could not tell which file it meant"]);

    // Act
    await walk(s, script);

    // Assert
    expect(script.transcript()).toContain(
      `  a reason is one sentence of at most ${String(MAX_PILOT_LABEL_REASON_CHARS)} characters, and that one has ${String(MAX_PILOT_LABEL_REASON_CHARS + 1)} — type it shorter, or press Enter for none\n`,
    );
    expect((await reportOf(s)).reasons).toEqual([
      { label: "unclear", reason: "could not tell which file it meant" },
    ]);
  });
});

describe("crosscheck pilot label — who may walk, and what is said", () => {
  test("an agent with no terminal cannot label: refused before anything is listed or recorded", async () => {
    // Arrange — the call came through a tool, not a person
    const s = await scenario("agent");
    await deliver(s, "wc_agent_a", 4);
    const script = scripted(["h"]);

    // Act
    const result = await walk(s, script, { interactive: false });

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("needs a person at a terminal");
    expect(script.transcript()).toBe("");
    expect(await reportOf(s)).toMatchObject({ helpful: 0, noise: 0, unclear: 0 });
  });

  test("an intervention older than a day is not offered — a label is a memory, not a guess", async () => {
    // Arrange — twenty-five hours ago, one hour past the walk's window
    const s = await scenario("stale");
    await deliver(s, "wc_stale_a", 25 * 60);

    // Act
    const result = await walk(s, scripted(["h"]));

    // Assert
    expect(result.stdout).toContain("there is nothing to label");
    expect(await reportOf(s)).toMatchObject({ helpful: 0 });
  });

  test("nothing left to label is said, not silent", async () => {
    // Arrange
    const s = await scenario("empty");

    // Act
    const result = await walk(s, scripted([]));

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toBe(
      "nothing reached you on this repo in the last 24 hours that you have not labelled — there is nothing to label\n",
    );
  });

  test("a repo nobody enrolled is told, not walked", async () => {
    // Arrange
    const s = await scenario("unenrolled");
    await send("PUT", "/api/team-settings", ADMIN_TOKEN, { repo: s.repoId, pilotEnrolled: false });

    // Act
    const result = await walk(s, scripted([]));

    // Assert
    expect(result.stdout).toContain("not in the pilot");
  });

  test("an unreachable hub is said, and nothing is recorded", async () => {
    // Arrange
    const s = await scenario("offline");

    // Act
    const result = await walk(s, scripted(["h"]), { hub: UNREACHABLE_HUB });

    // Assert
    expect(result.exitCode).toBe(EXIT_UNREACHABLE);
    expect(result.stdout).toContain("hub unreachable");
  });

  test("an argument the walk does not take is a usage error, and nothing is asked", async () => {
    // Arrange
    const s = await scenario("usage");
    await deliver(s, "wc_usage_a", 4);
    const script = scripted(["h"]);

    // Act
    const result = await walk(s, script, { argv: ["wc_usage_a"] });

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("crosscheck pilot label");
    expect(script.transcript()).toBe("");
  });
});

describe("crosscheck noise — the one-word shortcut for the n key", () => {
  test("it labels noise, the report counts it so, and the walk does not offer it again", async () => {
    // Arrange
    const s = await scenario("shortcut");
    const id = await deliver(s, "wc_shortcut_a", 4);

    // Act
    const marked = await runCli(["noise", id], env(s), s.repoRoot, undefined, {
      isInteractive: () => true,
    });
    const after = await walk(s, scripted([]));

    // Assert
    expect(marked.stdout).toContain(`recorded: ${id} is noise`);
    expect(await reportOf(s)).toMatchObject({ noise: 1, helpful: 0 });
    expect(after.stdout).toContain("there is nothing to label");
  });
});
