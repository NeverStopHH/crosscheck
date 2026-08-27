/**
 * `crosscheck conference` end to end (VISION.md §2): a real hub over PGlite, a
 * real git repo, a fake model behind CROSSCHECK_SUMMARIZER_CMD, and the CLI
 * entry point a human actually types.
 *
 * The command's own module carried no test at all — the hub half, the report
 * renderer and the prompt each had one, and the 480 lines that decide WHAT IS
 * SENT, WHAT IS SPENT, WHERE A DRAFT LANDS and WHAT IS COUNTED had none. Every
 * assertion here is about that seam, and the ones that can pass for the wrong
 * reason carry the contrast that rules it out.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";
import {
  CONFERENCE_DERIVED_CONFIDENCE,
  CONFERENCE_MAX_INPUT_CHARS,
  EXIT_FAIL,
  EXIT_USAGE,
} from "@crosscheck/connector-core/constants.ts";
import { DERIVED_CONFIDENCE_CAP } from "@crosscheck/schema";
import { readConferenceCost } from "@crosscheck/connector-core/state/conference-cost.ts";
import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { formatDraftLine } from "@crosscheck/connector-core/briefing/render.ts";

import { runCli } from "../src/index.ts";
import { runConference } from "../src/cli/conference.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const ADMIN_TOKEN = "conference-cli-admin";
const REPO_ID = "github.com/acme/api";
const BIG_REPO_ID = "github.com/acme/big";

const ALICE_SESSION = "cc_conf_alice";
const KEN_SESSION = "cc_conf_ken";
const ALICE_CONTEXT = "wc_conf_alice";
const KEN_CONTEXT = "wc_conf_ken";

const ALICE_INTENT = "Stop the importer dropping rotated keys";
const KEN_INTENT = "Work out why refresh returns 500 after rotation";
const KEN_DECLARED = "The refresh path reads the key id before the rotation lands";
const KEN_DRAFT = "A machine guess nobody has vouched for about the cache";
const SHARED_FILE = "src/auth/refresh.ts";
// TWO of them, because GHOST_MIN_SHARED_TARGETS is 2: one shared file is a
// coincidence and the conference's duplicated-work rule is the ghost check's,
// floor and all.
const SHARED_FILE_TWO = "src/auth/key-store.ts";

const SENTENCE = "Both are looking at the same stale key id read on the refresh path";

let db: Db;
let server: ReturnType<typeof Bun.serve>;
let hubUrl: string;
let home: string;
let repo: string;
let bigRepo: string;
let aliceKey: string;
let aliceId: string;
let kenKey: string;
let kenId: string;

const temps: string[] = [];

const tempDir = async (label: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `cx-conf-${label}-`));
  temps.push(dir);
  return dir;
};

interface FakeOptions {
  readonly output?: string;
  readonly stdinDump?: string;
  readonly invokedMarker?: string;
  readonly exitCode?: number;
}

/** An executable the runner can spawn: a /bin/sh wrapper around a bun script. */
const makeFakeModel = async (options: FakeOptions): Promise<string> => {
  const dir = await tempDir("model");
  const script = join(dir, "fake-model.ts");
  await writeFile(
    script,
    [
      "const stdin = await Bun.stdin.text();",
      options.stdinDump === undefined
        ? ""
        : `await Bun.write(${JSON.stringify(options.stdinDump)}, stdin);`,
      options.invokedMarker === undefined
        ? ""
        : `await Bun.write(${JSON.stringify(options.invokedMarker)}, "1");`,
      `process.stdout.write(${JSON.stringify(options.output ?? "NONE")});`,
      options.exitCode === undefined
        ? ""
        : `process.exitCode = ${String(options.exitCode)};`,
    ].join("\n"),
    "utf8",
  );
  const wrapper = join(dir, "fake-model.sh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,
    "utf8",
  );
  await chmod(wrapper, 0o755);
  return wrapper;
};

const createDeveloper = async (
  name: string,
  email: string,
): Promise<{ readonly apiKey: string; readonly id: string }> => {
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, email }),
  });
  const body = (await response.json()) as {
    data: { apiKey: string; developer: { id: string } };
  };
  return { apiKey: body.data.apiKey, id: body.data.developer.id };
};

const post = async (
  path: string,
  apiKey: string,
  body: unknown,
): Promise<Response> =>
  fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

const envelope = (
  kind: string,
  body: unknown,
  developerId: string,
  sessionId: string,
): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_${crypto.randomUUID()}`,
  ts: new Date().toISOString(),
  producer: { developerId, agentKind: "claude-code", sessionId },
  kind,
  body,
});

const send = async (
  apiKey: string,
  records: readonly Record<string, unknown>[],
): Promise<void> => {
  const response = await post("/api/records", apiKey, { records });
  if (response.status !== 200) {
    throw new Error(
      `seeding failed: ${String(response.status)} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as {
    data: {
      rejected: number;
      results?: { status: string; reason?: string }[];
    };
  };
  // IGNORED counts as a failure here, not only REJECTED. An envelope whose
  // kind the hub does not know is ignored with a 200, so a fixture with a
  // misspelt kind seeds nothing and every assertion about it passes for the
  // wrong reason — which is exactly what happened while this file was written.
  const unusable = (body.data.results ?? []).filter(
    (entry) => entry.status !== "accepted" && entry.status !== "duplicate",
  );
  if (body.data.rejected > 0 || unusable.length > 0) {
    throw new Error(`seeding failed: ${JSON.stringify(body.data.results)}`);
  }
};

const claim = (
  id: string,
  contextId: string,
  sessionId: string,
  fields: Record<string, unknown>,
): Record<string, unknown> => ({
  id,
  workContextId: contextId,
  authorSessionId: sessionId,
  kind: "evidence",
  status: "proposed",
  confidence: 0.8,
  captureMode: "agent",
  provenance: "declared",
  evidenceRefs: [],
  createdAt: new Date().toISOString(),
  ...fields,
});

const envFor = (
  apiKey: string,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  CROSSCHECK_HOME: home,
  HOME: home,
  CROSSCHECK_HUB_URL: hubUrl,
  CROSSCHECK_API_KEY: apiKey,
  CROSSCHECK_TIMEOUT_MS: "4000",
  CROSSCHECK_DOCTOR_NO_PROBE: "1",
  ...extra,
});

/** The conference command with its pre-run lines captured rather than printed. */
const runConferenceFor = async (
  argv: readonly string[],
  extraEnv: Record<string, string>,
  cwd: string = repo,
): Promise<{
  readonly stdout: string;
  readonly exitCode: number;
  readonly written: readonly string[];
}> => {
  const written: string[] = [];
  const result = await runConference(
    argv,
    envFor(aliceKey, extraEnv),
    cwd,
    (line) => {
      written.push(line);
    },
  );
  return { ...result, written };
};

const reportOf = async (stdout: string): Promise<string> => {
  const line = stdout.split("\n").find((entry) => entry.startsWith("report: "));
  if (line === undefined) {
    throw new Error(`no report path printed in: ${stdout}`);
  }
  return Bun.file(line.slice("report: ".length)).text();
};

/** The hub's own ordering of the slice — freshest first, by construction. */
const corpusContextIds = async (repoId: string): Promise<readonly string[]> => {
  const response = await fetch(
    `${hubUrl}/api/conference?repo=${encodeURIComponent(repoId)}`,
    { headers: { Authorization: `Bearer ${aliceKey}` } },
  );
  const body = (await response.json()) as {
    data: { conference: { contexts: { id: string }[] } };
  };
  return body.data.conference.contexts.map((context) => context.id);
};

const claimsOn = async (
  contextId: string,
): Promise<
  readonly {
    body: string;
    provenance: string;
    status: string;
    confidence: number;
  }[]
> => {
  const response = await fetch(
    `${hubUrl}/api/work-contexts/${contextId}/diagnosis`,
    { headers: { Authorization: `Bearer ${aliceKey}` } },
  );
  const body = (await response.json()) as {
    data: {
      claims: {
        body: string;
        provenance: string;
        status: string;
        confidence: number;
      }[];
    };
  };
  return body.data.claims;
};

beforeAll(async () => {
  db = await createDb();
  server = Bun.serve({
    port: 0,
    fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch,
  });
  hubUrl = `http://127.0.0.1:${String(server.port)}`;
  home = await makeHome("conference-cli");
  repo = await makeRepo("conference-cli", {
    remote: "git@github.com:acme/api.git",
  });
  bigRepo = await makeRepo("conference-big", {
    remote: "git@github.com:acme/big.git",
  });

  const alice = await createDeveloper("Alice Ng", "alice-conf@example.com");
  aliceKey = alice.apiKey;
  aliceId = alice.id;
  const ken = await createDeveloper("Ken Weber", "ken-conf@example.com");
  kenKey = ken.apiKey;
  kenId = ken.id;

  for (const [key, sessionId] of [
    [aliceKey, ALICE_SESSION],
    [kenKey, KEN_SESSION],
  ] as const) {
    await post("/api/sessions", key, {
      id: sessionId,
      agentKind: "claude-code",
      repo: REPO_ID,
      branch: "feat/importer",
      baseCommit: "a1b2c3d4",
      status: "analyzing",
    });
  }

  // KEN FIRST, so Alice's tree is the freshest of the two by the hub's own
  // ordering — which is the property the publish target has to follow.
  await send(kenKey, [
    envelope(
      "work_context",
      {
        id: KEN_CONTEXT,
        sessionId: KEN_SESSION,
        title: "Refresh 500s after key rotation",
        status: "analyzing",
        intent: { summary: KEN_INTENT, provenance: "declared", confidence: 0.9, capturedAt: new Date().toISOString() },
        createdAt: new Date().toISOString(),
      },
      kenId,
      KEN_SESSION,
    ),
    envelope(
      "claim",
      claim("cl_conf_ken", KEN_CONTEXT, KEN_SESSION, { body: KEN_DECLARED }),
      kenId,
      KEN_SESSION,
    ),
    // A Tier-1 draft of Ken's on the same tree: never shown to the model.
    envelope(
      "claim",
      claim("cl_conf_ken_draft", KEN_CONTEXT, KEN_SESSION, {
        body: KEN_DRAFT,
        kind: "hypothesis",
        provenance: "derived",
        captureMode: "auto",
        confidence: 0.4,
      }),
      kenId,
      KEN_SESSION,
    ),
    envelope(
      "target",
      { workContextId: KEN_CONTEXT, kind: "file", value: SHARED_FILE },
      kenId,
      KEN_SESSION,
    ),
    envelope(
      "target",
      { workContextId: KEN_CONTEXT, kind: "file", value: SHARED_FILE_TWO },
      kenId,
      KEN_SESSION,
    ),
  ]);

  await send(aliceKey, [
    envelope(
      "work_context",
      {
        id: ALICE_CONTEXT,
        sessionId: ALICE_SESSION,
        title: "Importer drops rotated key ids",
        status: "analyzing",
        intent: {
          summary: ALICE_INTENT,
          provenance: "declared",
          confidence: 0.9,
          capturedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      },
      aliceId,
      ALICE_SESSION,
    ),
    envelope(
      "claim",
      claim("cl_conf_alice", ALICE_CONTEXT, ALICE_SESSION, {
        body: "The mapping loses the key id whenever a rotation is in flight",
      }),
      aliceId,
      ALICE_SESSION,
    ),
    envelope(
      "target",
      { workContextId: ALICE_CONTEXT, kind: "file", value: SHARED_FILE },
      aliceId,
      ALICE_SESSION,
    ),
    envelope(
      "target",
      { workContextId: ALICE_CONTEXT, kind: "file", value: SHARED_FILE_TWO },
      aliceId,
      ALICE_SESSION,
    ),
  ]);
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(
    [home, repo, bigRepo, ...temps].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("the conference command", () => {
  test("Alice's tree is the freshest of the two the hub sends", async () => {
    // The arrangement every attribution test below leans on, asserted rather
    // than assumed: if the seeding order ever stops producing this, those
    // tests would pass for a reason that has nothing to do with their subject.
    expect(await corpusContextIds(REPO_ID)).toEqual([
      ALICE_CONTEXT,
      KEN_CONTEXT,
    ]);
  });

  test("the model is shown both intents and Ken's DECLARED claim, never his draft", async () => {
    // Arrange
    const dump = join(await tempDir("dump"), "stdin.txt");
    const model = await makeFakeModel({ output: "NONE", stdinDump: dump });

    // Act
    await runConferenceFor([], { CROSSCHECK_SUMMARIZER_CMD: model });

    // Assert
    const stdin = await Bun.file(dump).text();
    expect(stdin).toContain(ALICE_INTENT);
    expect(stdin).toContain(KEN_INTENT);
    expect(stdin).toContain(KEN_DECLARED);
    expect(stdin).not.toContain(KEN_DRAFT);
    // And never a name: the label is the whole attribution mechanism.
    expect(stdin).not.toContain("Ken");
    expect(stdin).not.toContain("Alice");
  });

  test("the token estimate is printed BEFORE the model is spawned", async () => {
    // Arrange: the marker is written by the fake model itself, so the order
    // asserted is the real one and not the order the lines were collected in.
    const marker = join(await tempDir("order"), "invoked");
    const model = await makeFakeModel({ output: "NONE", invokedMarker: marker });

    // Act
    const seen: { readonly line: string; readonly spawned: boolean }[] = [];
    await runConference(
      [],
      envFor(aliceKey, { CROSSCHECK_SUMMARIZER_CMD: model }),
      repo,
      (line) => {
        seen.push({ line, spawned: Bun.file(marker).size > 0 });
      },
    );

    // Assert: an estimate is a quote, and a quote after the spend is a bill.
    const quote = seen.find((entry) => entry.line.includes("input tokens"));
    expect(quote).toBeDefined();
    expect(quote?.spawned).toBe(false);
    expect(quote?.line).toContain("about ");
    expect(quote?.line).toContain("capped at ");
  });

  test("one session with anything to compare spends no model call", async () => {
    // Arrange: a repo of its own holding exactly one substantive context.
    const soloSession = "cc_conf_solo";
    const soloRepo = "github.com/acme/solo";
    const soloRoot = await makeRepo("conference-solo", {
      remote: "git@github.com:acme/solo.git",
    });
    temps.push(soloRoot);
    await post("/api/sessions", aliceKey, {
      id: soloSession,
      agentKind: "claude-code",
      repo: soloRepo,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "analyzing",
    });
    await send(aliceKey, [
      envelope(
        "work_context",
        {
          id: "wc_conf_solo",
          sessionId: soloSession,
          title: "One investigation, alone",
          status: "analyzing",
          intent: {
            summary: ALICE_INTENT,
            provenance: "declared",
            confidence: 0.9,
            capturedAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        },
        aliceId,
        soloSession,
      ),
    ]);
    const marker = join(await tempDir("solo"), "invoked");
    const model = await makeFakeModel({ output: "NONE", invokedMarker: marker });

    // Act
    const result = await runConferenceFor(
      [],
      { CROSSCHECK_SUMMARIZER_CMD: model },
      soloRoot,
    );

    // Assert: nothing spent, and the page still says why.
    expect(await Bun.file(marker).exists()).toBe(false);
    const report = await reportOf(result.stdout);
    expect(report).toContain("No model call was made: only one session");

    // THE CONTROL: the same fake, the same command, on the repo that HAS two
    // — the binary IS invoked. So the silence above is the floor, not a
    // runner that never runs.
    await runConferenceFor([], { CROSSCHECK_SUMMARIZER_CMD: model });
    expect(await Bun.file(marker).exists()).toBe(true);
  });

  test("a NONE writes the page that says so, with every section speaking", async () => {
    // Arrange
    const model = await makeFakeModel({ output: "NONE" });

    // Act
    const result = await runConferenceFor([], {
      CROSSCHECK_SUMMARIZER_CMD: model,
    });

    // Assert
    expect(result.exitCode).toBe(0);
    const report = await reportOf(result.stdout);
    expect(report).toContain(
      "The model compared these sessions and found no shared cause.",
    );
    expect(report).toContain("## Contradictions worth refereeing");
    expect(report).toContain("## Duplicated work");
    expect(report).toContain("## Questions nobody has answered");
    // The duplicated-work pair is DETERMINISTIC and owes the model nothing:
    // it is there on a run whose model said nothing at all.
    expect(report).toContain("Alice Ng and Ken Weber");
    expect(report).toContain(SHARED_FILE);
  });

  test("a finding is published on the FRESHEST of the two, not the letter the model wrote first", async () => {
    // Arrange: the model names the OLDER tree first. Which letter it happens
    // to put first is a model's choice; whose tree gets a machine-written
    // draft filed on it must not be.
    const model = await makeFakeModel({ output: `B+A: ${SENTENCE}` });

    // Act
    const result = await runConferenceFor(["--publish"], {
      CROSSCHECK_SUMMARIZER_CMD: model,
    });

    // Assert
    expect(result.stdout).toContain("published 1 finding as a derived draft");
    expect(result.stdout).toContain(`on Alice Ng's tree — get_diagnosis ${ALICE_CONTEXT}`);
    const onAlice = (await claimsOn(ALICE_CONTEXT)).filter((entry) =>
      entry.body.startsWith("Conference finding"),
    );
    const onKen = (await claimsOn(KEN_CONTEXT)).filter((entry) =>
      entry.body.startsWith("Conference finding"),
    );
    expect(onAlice.length).toBe(1);
    expect(onKen.length).toBe(0);
    // Tier-1 and nothing more, and the other tree is named so the reader can
    // open both sides.
    expect(onAlice[0]?.provenance).toBe("derived");
    expect(onAlice[0]?.status).toBe("proposed");
    expect(onAlice[0]?.confidence).toBe(CONFERENCE_DERIVED_CONFIDENCE);
    expect(CONFERENCE_DERIVED_CONFIDENCE).toBeLessThan(DERIVED_CONFIDENCE_CAP);
    expect(onAlice[0]?.body).toContain(SENTENCE);
    expect(onAlice[0]?.body).toContain(`get_diagnosis ${KEN_CONTEXT}`);
  });

  test("the report names the two sides freshest first whatever the model wrote", async () => {
    // Arrange
    const model = await makeFakeModel({ output: `B+A: ${SENTENCE}` });

    // Act
    const result = await runConferenceFor([], {
      CROSSCHECK_SUMMARIZER_CMD: model,
    });

    // Assert: the reader meets the same pair in the same order on every run.
    const report = await reportOf(result.stdout);
    const alice = report.indexOf(`get_diagnosis ${ALICE_CONTEXT}`);
    const ken = report.indexOf(`get_diagnosis ${KEN_CONTEXT}`);
    expect(alice).toBeGreaterThan(-1);
    expect(ken).toBeGreaterThan(alice);
  });

  test("without --publish nothing is filed on anybody's tree", async () => {
    // Arrange
    const before = (await claimsOn(ALICE_CONTEXT)).length;
    const model = await makeFakeModel({ output: `A+B: ${SENTENCE} twice over` });

    // Act
    const result = await runConferenceFor([], {
      CROSSCHECK_SUMMARIZER_CMD: model,
    });

    // Assert
    expect(result.stdout).not.toContain("published");
    expect((await claimsOn(ALICE_CONTEXT)).length).toBe(before);
    // THE CONTROL: the finding really was there to publish — the page has it.
    expect(await reportOf(result.stdout)).toContain(`${SENTENCE} twice over`);
  });

  test("a sentence that merely restates a claim it was handed is dropped", async () => {
    // Arrange: provenance laundering by paraphrase — Ken's own declared
    // finding, handed back as this machine's synthesis.
    const model = await makeFakeModel({ output: `A+B: ${KEN_DECLARED}` });

    // Act
    const result = await runConferenceFor([], {
      CROSSCHECK_SUMMARIZER_CMD: model,
    });

    // Assert
    const report = await reportOf(result.stdout);
    expect(result.stdout).toContain("no shared-cause finding");
    expect(report).toContain("## Shared root-cause candidates");
    expect(report).not.toContain(`- «${KEN_DECLARED}»`);
  });

  test("a sentence carrying a credential is dropped, never written to the page", async () => {
    // Arrange: the report is a FILE on disk that people paste around, and
    // --publish would put the same sentence on the hub. A model that read a
    // teammate's claim about a leaked key and repeated the key is the one way
    // this command can spill one.
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    const model = await makeFakeModel({
      output: `A+B: both sessions authenticate with ${secret} directly`,
    });

    // Act
    const result = await runConferenceFor(["--publish"], {
      CROSSCHECK_SUMMARIZER_CMD: model,
    });

    // Assert: dropped whole rather than redacted, and the page never quotes
    // what it matched.
    const report = await reportOf(result.stdout);
    expect(report).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain("no shared-cause finding");
    expect(
      (await claimsOn(ALICE_CONTEXT)).some((entry) => entry.body.includes(secret)),
    ).toBe(false);

    // THE CONTROL: the identical run with the credential taken out of the
    // sentence DOES land, so the drop above is the scan and not the shape of
    // the answer.
    const clean = await makeFakeModel({
      output: "A+B: both sessions authenticate against the same stale key id",
    });
    const kept = await runConferenceFor([], {
      CROSSCHECK_SUMMARIZER_CMD: clean,
    });
    expect(await reportOf(kept.stdout)).toContain(
      "both sessions authenticate against the same stale key id",
    );
  });

  test("a lost model call is booked as a failure and the page still lands", async () => {
    // Arrange
    const model = await makeFakeModel({ output: "", exitCode: 9 });

    // Act
    const result = await runConferenceFor([], {
      CROSSCHECK_SUMMARIZER_CMD: model,
    });

    // Assert
    expect(result.exitCode).toBe(0);
    expect(await reportOf(result.stdout)).toContain(
      "The model call did not answer:",
    );
    const cost = await readConferenceCost(home, repoKey(hubUrl, REPO_ID));
    expect(cost.fails).toBeGreaterThan(0);
    expect(cost.lastFailure).not.toBeNull();
  });

  test("status and doctor read the counters off the file, with no live session", async () => {
    // Act
    const status = await runCli(["status"], envFor(aliceKey), repo);
    const doctor = await runCli(["doctor"], envFor(aliceKey), repo);

    // Assert
    expect(status.stdout).toContain("conference: ");
    expect(status.stdout).toMatch(/conference: \d+ runs? \(last /);
    // A lost model call is a fault and doctor says so — never PASS-only.
    const line =
      doctor.stdout
        .split("\n")
        .find((entry) => /\b(?:PASS|WARN|FAIL) +conference /.test(entry)) ?? "";
    expect(line).toContain("WARN");
    expect(line).toContain("failed");
  });

  test("a hub that cannot answer spends nothing and says so", async () => {
    // Arrange: a reachable port with nothing serving the API.
    const dead = Bun.serve({
      port: 0,
      fetch: () => new Response("no", { status: 503 }),
    });
    const marker = join(await tempDir("dead"), "invoked");
    const model = await makeFakeModel({ output: "NONE", invokedMarker: marker });

    try {
      // Act
      const result = await runConference(
        [],
        {
          ...envFor(aliceKey, { CROSSCHECK_SUMMARIZER_CMD: model }),
          CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(dead.port)}`,
        },
        repo,
        () => undefined,
      );

      // Assert
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("Nothing was read and nothing was spent");
      // And it names what that port actually did rather than a bare code.
      expect(result.stdout).toContain("503");
      expect(result.stdout).toContain("is a crosscheck hub really serving");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      dead.stop(true);
    }
  });

  test("an unknown flag is a usage error, not a silent full run", async () => {
    // Act
    const result = await runConferenceFor(["--publish-everything"], {});

    // Assert
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("usage: crosscheck conference");
  });
});

describe("the sessions the character bound dropped", () => {
  const BIG_SESSION = "cc_conf_big";
  const bigContextId = (index: number): string => `wc_conf_big_${String(index)}`;

  beforeAll(async () => {
    await post("/api/sessions", aliceKey, {
      id: BIG_SESSION,
      agentKind: "claude-code",
      repo: BIG_REPO_ID,
      branch: "main",
      baseCommit: "a1b2c3d4",
      status: "analyzing",
    });
    // Twelve contexts at the hub's own caps — five claims each at the hub's
    // body cut. That is more than CONFERENCE_MAX_INPUT_CHARS of session
    // blocks, so the last of them cannot be sent, which is the whole point:
    // this is ordinary data at the hub's OWN limits, not a hostile payload.
    const records: Record<string, unknown>[] = [];
    for (let index = 0; index < 12; index += 1) {
      const id = bigContextId(index);
      records.push(
        envelope(
          "work_context",
          {
            id,
            sessionId: BIG_SESSION,
            title: `Investigation ${String(index)}`,
            status: "analyzing",
            intent: {
              summary: `Investigation ${String(index)} of the rotation failure`,
              provenance: "declared",
              confidence: 0.9,
              capturedAt: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
          },
          aliceId,
          BIG_SESSION,
        ),
      );
      for (let claimIndex = 0; claimIndex < 5; claimIndex += 1) {
        records.push(
          envelope(
            "claim",
            claim(
              `cl_big_${String(index)}_${String(claimIndex)}`,
              id,
              BIG_SESSION,
              {
                body: `Finding ${String(index)}-${String(claimIndex)} ${"x".repeat(320)}`,
              },
            ),
            aliceId,
            BIG_SESSION,
          ),
        );
      }
    }
    await send(aliceKey, records);
  });

  test("the twelve contexts really are more than one input can hold", async () => {
    // The arrangement, asserted: without this the test below would be green
    // because nothing was dropped rather than because dropping is handled.
    const ids = await corpusContextIds(BIG_REPO_ID);
    expect(ids.length).toBe(12);
    const response = await fetch(
      `${hubUrl}/api/conference?repo=${encodeURIComponent(BIG_REPO_ID)}`,
      { headers: { Authorization: `Bearer ${aliceKey}` } },
    );
    const body = (await response.json()) as {
      data: {
        conference: {
          contexts: {
            intent: { summary: string } | null;
            claims: { body: string }[];
          }[];
        };
      };
    };
    const total = body.data.conference.contexts.reduce(
      (sum, context) =>
        sum +
        (context.intent?.summary.length ?? 0) +
        context.claims.reduce(
          (claimSum, entry) => claimSum + entry.body.length,
          0,
        ),
      0,
    );
    expect(total).toBeGreaterThan(CONFERENCE_MAX_INPUT_CHARS);
  });

  test("a finding naming a session the model was never shown is dropped", async () => {
    // Arrange: L is the twelfth label. It exists on the hub, it has a letter,
    // and the input bound left it out — so the model cannot have compared it,
    // and a sentence about it is a sentence about a tree nobody read.
    const dump = join(await tempDir("big"), "stdin.txt");
    const model = await makeFakeModel({
      output: `A+L: ${SENTENCE}`,
      stdinDump: dump,
    });

    // Act
    const result = await runConferenceFor(
      ["--publish"],
      { CROSSCHECK_SUMMARIZER_CMD: model },
      bigRepo,
    );

    // Assert: the input really did leave L out …
    const stdin = await Bun.file(dump).text();
    expect(stdin).toContain("SESSION A intends");
    expect(stdin).not.toContain("SESSION L");
    // … so the sentence about it is not a finding, is not on the page, and is
    // certainly not filed on anybody's tree.
    expect(result.stdout).toContain("no shared-cause finding");
    expect(await reportOf(result.stdout)).not.toContain(SENTENCE);
    expect(
      (await claimsOn(bigContextId(11))).filter((entry) =>
        entry.body.startsWith("Conference finding:"),
      ).length,
    ).toBe(0);

    // THE CONTROL: a pair the model WAS shown lands normally, so the drop
    // above is the bound and not a parser that rejects everything.
    const good = await makeFakeModel({ output: `A+B: ${SENTENCE}` });
    const kept = await runConferenceFor(
      [],
      { CROSSCHECK_SUMMARIZER_CMD: good },
      bigRepo,
    );
    expect(await reportOf(kept.stdout)).toContain(SENTENCE);
  });

  test("the printed session count is what was sent, not what was read", async () => {
    // Arrange
    const model = await makeFakeModel({ output: "NONE" });

    // Act
    const result = await runConferenceFor(
      [],
      { CROSSCHECK_SUMMARIZER_CMD: model },
      bigRepo,
    );

    // Assert: a quote that over-counts the sessions is a quote for a call
    // nobody made. The read line still says twelve; the send line must not.
    const quote =
      result.written.find((line) => line.includes("input tokens")) ?? "";
    const sent = /from (\d+) sessions/.exec(quote)?.[1];
    expect(sent).toBeDefined();
    expect(Number(sent)).toBeLessThan(12);
    expect(
      result.written.some((line) => line.includes("read 12 work contexts")),
    ).toBe(true);
  });
});

/**
 * WHAT THE COMMAND SAYS WHEN THE HUB IS THE PROBLEM. Three states that look
 * identical through a bare status code and need three different people to do
 * three different things: a hub older than this CLI, a hub whose endpoint is
 * failing, and a hub that is simply slower than one hook's request timeout.
 */
describe("a hub the conference cannot read", () => {
  const EMPTY_CORPUS = JSON.stringify({
    ok: true,
    data: {
      conference: {
        contexts: [],
        overlaps: [],
        questions: [],
        contradictions: [],
        contextsInWindow: 0,
        contextsInWindowCapped: false,
        windowDays: 14,
      },
    },
  });

  const withHub = async (
    handler: (request: Request) => Response | Promise<Response>,
    extraEnv: Record<string, string>,
    run: (url: string) => Promise<void>,
  ): Promise<void> => {
    const fake = Bun.serve({ port: 0, fetch: handler });
    try {
      await run(`http://127.0.0.1:${String(fake.port)}`);
    } finally {
      fake.stop(true);
    }
    void extraEnv;
  };

  test("a hub slower than the hook timeout still answers the conference", async () => {
    // Arrange: a hub that takes SIX TIMES the request timeout every hook on
    // this machine runs under. A conference is the one caller that is not a
    // hook — it owns a 90 s wall clock and prints it — so the hook's 400 ms
    // must not be the bound that decides whether the feature works at all.
    const model = await makeFakeModel({ output: "NONE" });
    await withHub(
      async (request) => {
        if (new URL(request.url).pathname !== "/api/conference") {
          return new Response(JSON.stringify({ ok: true, data: {} }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        await Bun.sleep(1_200);
        return new Response(EMPTY_CORPUS, {
          headers: { "Content-Type": "application/json" },
        });
      },
      {},
      async (url) => {
        // Act
        const result = await runConference(
          [],
          {
            ...envFor(aliceKey, { CROSSCHECK_SUMMARIZER_CMD: model }),
            CROSSCHECK_HUB_URL: url,
            CROSSCHECK_TIMEOUT_MS: "200",
          },
          repo,
          () => undefined,
        );

        // Assert
        expect(result.stdout).not.toContain("nothing was read");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("report: ");
      },
    );
  });

  test("a hub too old for the route is named as older, not as a 404", async () => {
    // Arrange: the state a team is in for exactly as long as it takes to
    // update the hub — a deployment fact, and the only one of the three that
    // nobody needs to be paged for.
    const model = await makeFakeModel({ output: "NONE" });
    await withHub(
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "not_found", message: "no such route" },
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      {},
      async (url) => {
        // Act
        const result = await runConference(
          [],
          {
            ...envFor(aliceKey, { CROSSCHECK_SUMMARIZER_CMD: model }),
            CROSSCHECK_HUB_URL: url,
          },
          repo,
          () => undefined,
        );

        // Assert: the sentence names the cause, the address and who moves it.
        expect(result.stdout).toContain("older than this crosscheck");
        expect(result.stdout).toContain(url);
        expect(result.stdout).toContain("Nothing was read and nothing was spent");
      },
    );
  });

  test("an endpoint that exists and is failing says so, not the same sentence", async () => {
    // Arrange: the CONTRAST to the test above — same shape, different status,
    // and this one is the one somebody has to look at.
    const model = await makeFakeModel({ output: "NONE" });
    await withHub(
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "internal", message: "boom" },
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      {},
      async (url) => {
        // Act
        const result = await runConference(
          [],
          {
            ...envFor(aliceKey, { CROSSCHECK_SUMMARIZER_CMD: model }),
            CROSSCHECK_HUB_URL: url,
          },
          repo,
          () => undefined,
        );

        // Assert
        expect(result.stdout).not.toContain("older than this crosscheck");
        expect(result.stdout).toContain("500");
        expect(result.stdout).toContain("exists and is failing");
      },
    );
  });
});

/**
 * The floor and the bound, in the order they have to be applied. Two sessions
 * is the floor because a shared cause is a statement about two pieces of work
 * — and the list the floor must count is WHAT WAS SENT, not what the hub
 * named. CONFERENCE_MAX_INPUT_CHARS exists for a hub that is modified or
 * hostile, so these fixtures are one.
 */
describe("a hub whose contexts do not fit the input bound", () => {
  /** A context whose block alone is wider than CONFERENCE_MAX_INPUT_CHARS. */
  const oversizeContext = (id: string): Record<string, unknown> => ({
    id,
    title: `Investigation ${id}`,
    developerId: "dev_big",
    developerName: "Big",
    status: "analyzing",
    intent: { summary: `Investigation ${id}`, provenance: "declared" },
    lastActiveAt: new Date().toISOString(),
    claims: Array.from({ length: 60 }, (_unused, index) => ({
      id: `clm_${id}_${String(index)}`,
      kind: "evidence",
      status: "proposed",
      confidence: 0.8,
      provenance: "declared",
      body: "y".repeat(400),
      authorDeveloperName: "Big",
      createdAt: new Date().toISOString(),
    })),
  });

  const ordinaryContext = (id: string): Record<string, unknown> => ({
    ...oversizeContext(id),
    claims: [
      {
        id: `clm_${id}_only`,
        kind: "evidence",
        status: "proposed",
        confidence: 0.8,
        provenance: "declared",
        body: "the refresh path reads the key id too early",
        authorDeveloperName: "Big",
        createdAt: new Date().toISOString(),
      },
    ],
  });

  const corpusHub = (contexts: readonly Record<string, unknown>[]) =>
    Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/api/conference"
          ? new Response(
              JSON.stringify({
                ok: true,
                data: {
                  conference: {
                    contexts,
                    overlaps: [],
                    questions: [],
                    contradictions: [],
                    contextsInWindow: contexts.length,
                    contextsInWindowCapped: false,
                    windowDays: 14,
                  },
                },
              }),
              { headers: { "Content-Type": "application/json" } },
            )
          : new Response(JSON.stringify({ ok: true, data: {} }), {
              headers: { "Content-Type": "application/json" },
            }),
    });

  const runAgainst = async (
    contexts: readonly Record<string, unknown>[],
  ): Promise<{
    readonly stdout: string;
    readonly written: readonly string[];
    readonly spawned: boolean;
    readonly report: string;
  }> => {
    const marker = join(await tempDir("floor"), "invoked");
    const model = await makeFakeModel({
      output: "A+B: both are the same bug",
      invokedMarker: marker,
    });
    const hub = corpusHub(contexts);
    const written: string[] = [];
    try {
      const result = await runConference(
        [],
        {
          ...envFor(aliceKey, { CROSSCHECK_SUMMARIZER_CMD: model }),
          CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(hub.port)}`,
        },
        repo,
        (line) => {
          written.push(line);
        },
      );
      return {
        stdout: result.stdout,
        written,
        spawned: await Bun.file(marker).exists(),
        report: await reportOf(result.stdout),
      };
    } finally {
      hub.stop(true);
    }
  };

  test("one session left after the bound spends no model call", async () => {
    // Act: two comparable sessions, only one of which fits.
    const run = await runAgainst([
      oversizeContext("wc_floor_big"),
      ordinaryContext("wc_floor_small"),
    ]);

    // Assert: a call on ONE session cannot produce an "A+B" line, so it is a
    // call spent to be told nothing — and the answer would then be booked
    // `unreadable`, which is a standing doctor WARN nothing ever clears.
    expect(run.spawned).toBe(false);
    expect(run.stdout).toContain("no shared-cause finding");
    // And the page says WHICH bound cut it, not "nothing to compare".
    expect(run.report).toContain("only 1 of 2 sessions fit");
    expect(run.written.join("\n")).not.toContain("from 1 sessions");
  });

  test("no session left after the bound never sends empty stdin", async () => {
    // Act: neither context fits on its own.
    const run = await runAgainst([
      oversizeContext("wc_floor_big_a"),
      oversizeContext("wc_floor_big_b"),
    ]);

    // Assert: the quote-before-you-spend property — the run must not print
    // "about 0 input tokens" and then spawn a model on an empty document.
    expect(run.spawned).toBe(false);
    expect(run.written.join("\n")).not.toContain("about 0 input tokens");
    expect(run.report).toContain("only 0 of 2 sessions fit");
  });
});

/**
 * THE DELIVERABLE IS THE PAGE, and a command whose only output is a file has
 * to say something when the file cannot be written. The module header promises
 * "THE REPORT IS ALWAYS WRITTEN when the hub answered"; this is what happens
 * when the filesystem disagrees.
 */
describe("a home the report cannot be written to", () => {
  test("the page is printed and the failure named, never a silent exit", async () => {
    // Arrange: the shape a cron job hits — a home owned by somebody else, a
    // full disk, or a read-only mount.
    const readOnly = await tempDir("ro-home");
    const model = await makeFakeModel({ output: "NONE" });
    await chmod(readOnly, 0o500);

    try {
      // Act
      const result = await runConference(
        [],
        envFor(aliceKey, {
          CROSSCHECK_SUMMARIZER_CMD: model,
          CROSSCHECK_HOME: readOnly,
          HOME: readOnly,
        }),
        repo,
        () => undefined,
      );

      // Assert: the page itself, the cause, the directory, and an exit code
      // that means "this failed" rather than "you typed it wrong".
      expect(result.stdout).toContain("# Team conference");
      expect(result.stdout).toContain("could not write the report to ");
      expect(result.stdout).toContain(readOnly);
      expect(result.exitCode).toBe(EXIT_FAIL);
      expect(result.exitCode).not.toBe(EXIT_USAGE);
    } finally {
      await chmod(readOnly, 0o700);
    }
  });

  test("the REAL bin says it too, instead of exiting 64 in silence", async () => {
    // Arrange: the entry point a cron job actually runs — `main().catch`
    // printed nothing and exited EXIT_USAGE for any throw at all.
    const readOnly = await tempDir("ro-bin");
    const model = await makeFakeModel({ output: "NONE" });
    await chmod(readOnly, 0o500);

    try {
      // Act
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "..", "src", "bin", "crosscheck.ts"),
          "conference",
        ],
        {
          cwd: repo,
          env: envFor(aliceKey, {
            CROSSCHECK_SUMMARIZER_CMD: model,
            CROSSCHECK_HOME: readOnly,
            HOME: readOnly,
            PATH: process.env["PATH"] ?? "",
          }),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      // Assert: not exit 64, and not an empty terminal.
      expect(code).not.toBe(EXIT_USAGE);
      expect(code).toBe(EXIT_FAIL);
      expect(`${stdout}${stderr}`).toContain("could not write the report to ");
      expect(stdout).toContain("# Team conference");
    } finally {
      await chmod(readOnly, 0o700);
    }
  });
});

/**
 * WHOSE TREE, and whether the reader is ever told. `orderedPair` files on the
 * FRESHER of the two contexts, which is frequently a teammate's — the hub
 * permits it on purpose ("extending someone else's diagnosis tree is the
 * product") — and both freshest-first tests above are constructed so Alice's
 * own tree wins, so the cross-developer path had no coverage at all.
 */
describe("a finding published on somebody else's tree", () => {
  const TEAM_REPO_ID = "github.com/acme/team";
  const TEAM_ALICE_SESSION = "cc_team_alice";
  const TEAM_KEN_SESSION = "cc_team_ken";
  const TEAM_ALICE_CONTEXT = "wc_team_alice";
  const TEAM_KEN_CONTEXT = "wc_team_ken";
  const TEAM_SENTENCE =
    "Both sessions are circling the same stale key id that the rotation leaves behind";
  let teamRepo: string;

  beforeAll(async () => {
    teamRepo = await makeRepo("conference-team", {
      remote: "git@github.com:acme/team.git",
    });
    temps.push(teamRepo);
    for (const [key, sessionId] of [
      [aliceKey, TEAM_ALICE_SESSION],
      [kenKey, TEAM_KEN_SESSION],
    ] as const) {
      await post("/api/sessions", key, {
        id: sessionId,
        agentKind: "claude-code",
        repo: TEAM_REPO_ID,
        branch: "feat/importer",
        baseCommit: "a1b2c3d4",
        status: "analyzing",
      });
    }
    // ALICE FIRST this time, so KEN'S tree is the freshest of the two and the
    // draft lands on a teammate — the arrangement the two tests above cannot
    // reach and the one this describe exists for.
    await send(aliceKey, [
      envelope(
        "work_context",
        {
          id: TEAM_ALICE_CONTEXT,
          sessionId: TEAM_ALICE_SESSION,
          title: "Importer drops rotated key ids",
          status: "analyzing",
          intent: {
            summary: ALICE_INTENT,
            provenance: "declared",
            confidence: 0.9,
            capturedAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        },
        aliceId,
        TEAM_ALICE_SESSION,
      ),
      envelope(
        "claim",
        claim("cl_team_alice", TEAM_ALICE_CONTEXT, TEAM_ALICE_SESSION, {
          body: "The mapping loses the key id whenever a rotation is in flight",
        }),
        aliceId,
        TEAM_ALICE_SESSION,
      ),
    ]);
    await send(kenKey, [
      envelope(
        "work_context",
        {
          id: TEAM_KEN_CONTEXT,
          sessionId: TEAM_KEN_SESSION,
          title: "Refresh 500s after key rotation",
          status: "analyzing",
          intent: {
            summary: KEN_INTENT,
            provenance: "declared",
            confidence: 0.9,
            capturedAt: new Date().toISOString(),
          },
          createdAt: new Date().toISOString(),
        },
        kenId,
        TEAM_KEN_SESSION,
      ),
      envelope(
        "claim",
        claim("cl_team_ken", TEAM_KEN_CONTEXT, TEAM_KEN_SESSION, {
          body: KEN_DECLARED,
        }),
        kenId,
        TEAM_KEN_SESSION,
      ),
    ]);
  });

  test("Ken's tree is the freshest of the two on this repo", async () => {
    // The arrangement, asserted rather than assumed.
    expect(await corpusContextIds(TEAM_REPO_ID)).toEqual([
      TEAM_KEN_CONTEXT,
      TEAM_ALICE_CONTEXT,
    ]);
  });

  test("the printed line names the teammate whose tree it landed on", async () => {
    // Arrange
    const model = await makeFakeModel({ output: `A+B: ${TEAM_SENTENCE}` });

    // Act
    const result = await runConference(
      ["--publish"],
      envFor(aliceKey, { CROSSCHECK_SUMMARIZER_CMD: model }),
      teamRepo,
      () => undefined,
    );

    // Assert: not a bare count. Alice closed the terminal believing she had
    // filed something on her own work; the claim is on Ken's tree, under her
    // name, and Ken meets it tomorrow.
    expect(result.stdout).toContain("Ken Weber");
    expect(result.stdout).toContain(`get_diagnosis ${TEAM_KEN_CONTEXT}`);
    expect(result.stdout).toContain("review_draft");
    const onKen = (await claimsOn(TEAM_KEN_CONTEXT)).filter((entry) =>
      entry.body.startsWith("Conference finding"),
    );
    expect(onKen.length).toBe(1);
    expect((await claimsOn(TEAM_ALICE_CONTEXT)).filter((entry) =>
      entry.body.startsWith("Conference finding"),
    ).length).toBe(0);
  });

  test("the teammate's name survives the briefing's 80-character cut", async () => {
    // Arrange: the ONLY surface a draft is met on cuts a body at
    // MAX_TITLE_CHARS — the same measurement the ghost draft was reordered by.
    const onKen = (await claimsOn(TEAM_KEN_CONTEXT)).find((entry) =>
      entry.body.startsWith("Conference finding"),
    );
    expect(onKen).toBeDefined();

    // Act
    const line = formatDraftLine(
      {
        id: "clm_conference_draft",
        workContextId: TEAM_KEN_CONTEXT,
        kind: "hypothesis",
        status: "proposed",
        confidence: CONFERENCE_DERIVED_CONFIDENCE,
        body: onKen?.body ?? "",
        createdAt: new Date().toISOString(),
      },
      new Date(),
    );

    // Assert: the reader learns WHO the finding is about on the line itself.
    expect(line).toContain("Ken Weber");
    expect(line).toContain("review_draft");
  });

  test("a hub that will not list drafts publishes anyway and counts the duplicate apart", async () => {
    // Arrange: a proxy that answers everything except /api/drafts, so the
    // one-unreviewed-draft guard cannot read and has to fail OPEN — the
    // posture every reader here takes. The same sentence again, so the hub's
    // own body dedup is what the run then meets.
    const before = (await claimsOn(TEAM_KEN_CONTEXT)).filter((entry) =>
      entry.body.startsWith("Conference finding"),
    ).length;
    expect(before).toBe(1);
    const model = await makeFakeModel({ output: `A+B: ${TEAM_SENTENCE}` });
    const proxy = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/drafts") {
          return new Response(
            JSON.stringify({ ok: false, error: { code: "boom", message: "no" } }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        return fetch(`${hubUrl}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          ...(request.method === "GET" ? {} : { body: await request.text() }),
        });
      },
    });

    try {
      // Act
      const result = await runConference(
        ["--publish"],
        {
          ...envFor(aliceKey, { CROSSCHECK_SUMMARIZER_CMD: model }),
          CROSSCHECK_HUB_URL: `http://127.0.0.1:${String(proxy.port)}`,
        },
        teamRepo,
        () => undefined,
      );

      // Assert: it says it could not check, publishes, and then reports the
      // duplicate APART from the publish — a log that reconciles against the
      // hub instead of naming a draft it did not add.
      expect(result.stdout).toContain("could not check for earlier conference drafts");
      expect(result.stdout).toContain("already filed by an earlier run");
      expect(
        (await claimsOn(TEAM_KEN_CONTEXT)).filter((entry) =>
          entry.body.startsWith("Conference finding"),
        ).length,
      ).toBe(before);
    } finally {
      proxy.stop(true);
    }
  });

  test("a paraphrase is refused while last night's draft is still unreviewed", async () => {
    // Arrange: the hub dedups on the normalised body, which a real model
    // defeats by construction — it paraphrases. A nightly scheduler would put
    // ~30 near-identical hypotheses a month on one teammate's tree, and the
    // briefing's two draft slots would always be the newest two of them.
    const drafts = (await claimsOn(TEAM_KEN_CONTEXT)).filter((entry) =>
      entry.body.startsWith("Conference finding"),
    );
    expect(drafts.length).toBe(1);
    const model = await makeFakeModel({
      output: `A+B: The stale key id left behind by a rotation is what both are circling`,
    });

    // Act
    const result = await runConference(
      ["--publish"],
      envFor(aliceKey, { CROSSCHECK_SUMMARIZER_CMD: model }),
      teamRepo,
      () => undefined,
    );

    // Assert: refused, and the sentence names the tree, the age and the call
    // that clears it — not the hub's duplicate path, which this paraphrase
    // would sail straight through.
    expect(result.stdout).toContain("still unreviewed on Ken Weber's tree");
    expect(result.stdout).toContain("review_draft ");
    expect(result.stdout).not.toContain("already filed by an earlier run");
    expect(
      (await claimsOn(TEAM_KEN_CONTEXT)).filter((entry) =>
        entry.body.startsWith("Conference finding"),
      ).length,
    ).toBe(1);
    // THE CONTROL: the finding was real and the page still carries it — only
    // the FILING was refused.
    expect(await reportOf(result.stdout)).toContain("stale key id left behind");
  });
});
