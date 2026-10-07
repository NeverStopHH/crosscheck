/**
 * THE RELEASE GATE: the pilot's Nick/Mike collision, end to end, at pilot
 * scale — and negative controls that must stay silent, so nobody reaches
 * 100% recall by warning about everything.
 *
 * THE PILOT. Two developers changed 11 shared files over two days and
 * crosscheck warned nobody. 180 of Nick's 190 files reached the hub; three
 * things hid them: (a) one long detached session filed every topic under one
 * context titled after a stale branch; (b) a teammate's report stamped that
 * context landed because its base commit was already in main; (c) contexts
 * over 50 files counted as a "sweep" and were excluded. Also: 6 files were
 * created only by Bash and never captured; 91% of edits came from subagents,
 * whose tripwire hits reached only the subagent; hints reached only agents,
 * never a person (157 delivered, 0 opened).
 *
 * EVERYTHING IS REAL: the hook runner, the settings plan that decides which
 * hooks fire (release-gate/host.ts), the hub over PGlite (release-gate/hub.ts),
 * git repos with worktrees and backdated history (release-gate/git.ts). Each
 * case runs its whole scenario in `beforeAll`; every `test` only reads what
 * happened, so an expected failure can never be a setup error in disguise —
 * the `setup:` tests of each case are ordinary tests and must pass.
 *
 * EXPECTED FAILURES are `test.failing` (`expectedFailure` below) with the
 * real assertion and, in a comment, the branch that fixes it: the test turns
 * red the moment that fix lands, and its marker must then be removed.
 * "Sweep ≠ Ignore" (a large surface may lower the rank or qualify an overlap
 * row, never exclude it) is in progress on fix/false-landed-stamp and
 * committed nowhere yet. A plain `test` that fails is a gap no branch
 * addresses — except N2, whose desired silence is kept as an expected
 * failure on purpose: the rule that would give it is specified, not built
 * (release-gate/scenario-generated.ts). `RELEASE_GATE_AUDIT=1` runs every
 * expected failure as a plain test, to print why each one fails.
 *
 * RUNTIME: about two minutes — some 1,400 real hook runs, sequential on
 * purpose (parallel hooks of one session contend for its state lock, and a
 * busy lock is fail-open silence, i.e. nondeterministic capture).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { GHOST_SECTION_HEADER } from "@crosscheck/connector-core/briefing/ghost.ts";
import { readTelemetryLossReport } from "@crosscheck/connector-core/spool/loss-report.ts";

import { repoKey } from "../../src/index.ts";
import { agentTexts, personLines } from "./release-gate/host.ts";
import type { HookRun, HostSession } from "./release-gate/host.ts";
import { dumpDatabase, startHub } from "./release-gate/hub.ts";
import type { TestHub } from "./release-gate/hub.ts";
import { GENERATED_CLASSES, runGeneratedCase } from "./release-gate/scenario-generated.ts";
import type { GeneratedWorld } from "./release-gate/scenario-generated.ts";
import { MIKE_BRANCH, STALE_BRANCH, TOPIC_BRANCH, runLongSessionCase } from "./release-gate/scenario-long-session.ts";
import type { LongSessionPlan, LongSessionWorld } from "./release-gate/scenario-long-session.ts";
import { conferenceOverlaps, contextsOf, findMarker, ghostRows, targetsOf } from "./release-gate/team.ts";
import type { ConferenceOverlap, ContextRow, GateDeveloper, GhostRow, TargetRow } from "./release-gate/team.ts";

/** A whole case — hundreds of real hook runs against a real hub — per beforeAll. */
const CASE_TIMEOUT_MS = 300_000;

/**
 * Bun's `test.failing`, or — with RELEASE_GATE_AUDIT=1 — an ordinary test, so
 * every expected failure prints the reason it fails: what an integration
 * probe of the fix branches reads to see which assertions still fail.
 */
const expectedFailure = process.env["RELEASE_GATE_AUDIT"] === "1" ? test : test.failing;

const P1_PLAN: LongSessionPlan = {
  label: "p1",
  repoId: "github.com/acme/monorepo",
  remoteUrl: "git@github.com:acme/monorepo.git",
  mikeMappingDir: "apps/practice/mapping",
  nickMappingDir: "apps/practice/mapping",
};

const N1_PLAN: LongSessionPlan = {
  label: "n1",
  repoId: "github.com/acme/scale-twin",
  remoteUrl: "git@github.com:acme/scale-twin.git",
  mikeMappingDir: "apps/practice/mapping",
  nickMappingDir: "apps/numlabs/mapping",
};

/** The sweep threshold the pilot tripped (server GHOST_MAX_CONTEXT_TARGETS). */
const SWEEP_TARGETS = 50;
const COVERAGE_SOURCE_ORDER = ["agent_event", "git", "ci", "runtime", "human_edit"];
/** Sources no emitter in these scenarios feeds: never `complete`. */
const SOURCES_WITHOUT_EMITTER = new Set(["ci", "runtime", "human_edit"]);

let hub: TestHub;
const cleanups: string[] = [];

beforeAll(async () => {
  hub = await startHub();
});

afterAll(async () => {
  await hub.close();
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

interface Observed {
  readonly mikeGhost: readonly GhostRow[];
  readonly nickGhost: readonly GhostRow[];
  readonly mikeConference: readonly ConferenceOverlap[];
  readonly contexts: readonly ContextRow[];
  readonly targets: readonly TargetRow[];
}

const observe = async (world: LongSessionWorld): Promise<Observed> => ({
  mikeGhost: await ghostRows(hub, world.mike, world.plan.repoId),
  nickGhost: await ghostRows(hub, world.nick, world.plan.repoId),
  mikeConference: await conferenceOverlaps(hub, world.mike, world.plan.repoId),
  contexts: await contextsOf(hub.db, world.plan.repoId),
  targets: await targetsOf(hub.db, world.plan.repoId),
});

const mentions = (texts: readonly string[], needle: string): boolean => texts.some((text) => text.includes(needle));

/** A PostToolUse/PreToolUse run on a file whose path ends with `suffix`. */
const runsOn = (runs: readonly HookRun[], suffix: string, event: HookRun["event"]): readonly HookRun[] =>
  runs.filter((run) => run.event === event && run.filePath?.endsWith(suffix) === true);

/** The `- …` lines under a briefing's ghost header: the briefing's collision rows. */
const ghostLines = (texts: readonly string[]): readonly string[] =>
  texts.flatMap((text) => {
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line.includes(GHOST_SECTION_HEADER));
    if (at === -1) {
      return [];
    }
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((line) => !line.startsWith("- "));
    return end === -1 ? rest : rest.slice(0, end);
  });

/** What an agent is told AS A COLLISION: tripwire output, and the ghost rows of a briefing — never the presence list. */
const collisionTextsFor = (runs: readonly HookRun[]): readonly string[] => [
  ...agentTexts(runs.filter((run) => run.event === "PreToolUse")),
  ...ghostLines(agentTexts(runs.filter((run) => run.event !== "PreToolUse"))),
];

/** A field that states how big the teammate's change is (never the shared count, never an identity). */
const SIZE_KEY = /size|large|sweep|surface|breadth|contextTarget|targetTotal|totalTargets|fileCount|touched/i;
/** A field that labels the overlap. */
const QUALIFIER_KEY = /qualif|label|kind|note|scale|class|reason/i;
const LARGE_WORD = /\b(large|sweep|broad|wide|bulk)\b/i;

const flatten = (value: unknown, prefix = ""): readonly (readonly [string, unknown])[] =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => flatten(inner, `${prefix}${key}.`))
    : [[prefix.slice(0, -1), value]];

/**
 * "Qualified as a large change", whatever the spelling Sweep ≠ Ignore picks:
 * a size field over the sweep threshold (or true), or a qualifier field that
 * says so in words. Titles, branches, names and ids are never read — a repo
 * or branch that happens to contain "sweep" qualifies nothing.
 */
const isQualifiedAsLarge = (row: Readonly<Record<string, unknown>>): boolean =>
  flatten(row).some(([key, value]) => {
    const leaf = key.split(".").at(-1) ?? key;
    const isSize = SIZE_KEY.test(leaf) && leaf !== "sharedTargetCount";
    return (
      (isSize && ((typeof value === "number" && value > SWEEP_TARGETS) || value === true)) ||
      (QUALIFIER_KEY.test(leaf) && typeof value === "string" && LARGE_WORD.test(value))
    );
  });

const nickRows = (rows: readonly GhostRow[]): readonly GhostRow[] => rows.filter((row) => row.developerName === "Nick");

/**
 * SILENT, as the negative controls mean it: no line a person is shown names a
 * teammate, no tripwire output (ask or notice, any thread) names one, no
 * briefing carries a ghost section, no statusline shows an overlap. The hub's
 * own overlap rows are checked beside this, per case.
 */
const collisionNoise = (
  sessions: readonly HostSession[],
  teammates: readonly string[],
  statuslines: readonly string[],
): Readonly<Record<string, readonly string[]>> => {
  const runs = sessions.flatMap((session) => session.runs());
  const namesTeammate = (text: string): boolean => teammates.some((name) => text.includes(name));
  return {
    personLines: personLines(runs).filter(namesTeammate),
    tripwire: agentTexts(runs.filter((run) => run.event === "PreToolUse")).filter(namesTeammate),
    briefingGhosts: agentTexts(runs.filter((run) => run.event !== "PreToolUse")).filter((text) => text.includes(GHOST_SECTION_HEADER)),
    statuslines: statuslines.filter((line) => line.includes("overlap")),
  };
};

const SILENT = { personLines: [], tripwire: [], briefingGhosts: [], statuslines: [] };

interface OverlapRows {
  readonly ghost: readonly GhostRow[];
  readonly conference: readonly ConferenceOverlap[];
}

/** Every overlap row the hub would show any of `readers` on `repo`. */
const overlapRows = async (on: TestHub, readers: readonly GateDeveloper[], repo: string): Promise<OverlapRows> => ({
  ghost: (await Promise.all(readers.map(async (reader) => ghostRows(on, reader, repo)))).flat(),
  conference: (await Promise.all(readers.map(async (reader) => conferenceOverlaps(on, reader, repo)))).flat(),
});

interface CoverageRow {
  readonly source: string;
  readonly state: string;
  readonly reason: string;
}

interface TripwireAnswer {
  readonly sessions: number;
  readonly sources: readonly CoverageRow[];
}

/** Every tripwire answer Mike's hooks got on this case's repo, as the hub sent it. */
const tripwireAnswers = (world: LongSessionWorld): readonly TripwireAnswer[] =>
  hub.wire
    .filter(
      (entry) =>
        entry.developer === "Mike" &&
        entry.path.startsWith("/api/hints/tripwire") &&
        entry.path.includes(encodeURIComponent(world.plan.repoId)),
    )
    .map((entry) => {
      const data = (JSON.parse(entry.responseBody) as {
        data: { sessions: readonly unknown[]; coverage: { sources: readonly CoverageRow[] } };
      }).data;
      return { sessions: data.sessions.length, sources: data.coverage.sources };
    });

const agentEventOf = (answer: TripwireAnswer): CoverageRow | undefined =>
  answer.sources.find((row) => row.source === "agent_event");

describe("P1 — the pilot collision must warn both people", () => {
  let world: LongSessionWorld;
  let seen: Observed;

  beforeAll(async () => {
    world = await runLongSessionCase(hub, P1_PLAN);
    cleanups.push(...world.cleanup);
    seen = await observe(world);
  }, CASE_TIMEOUT_MS);

  test("setup: Nick's ONE session is detached and its own context carries the stale title (reproduces a)", () => {
    const own = seen.contexts.filter((context) => context.developer === "Nick" && !context.id.includes("~t"));
    expect(own, "Nick's long session must own exactly one session context").toHaveLength(1);
    expect(own[0]?.sessionBranch.startsWith("detached@"), "agentic-main must be a DETACHED HEAD").toBe(true);
    expect(own[0]?.title.startsWith(STALE_BRANCH), "the session title must be the stale branch at HEAD").toBe(true);
  });

  test("setup: Nick touched 190 files — 172 by subagents, 12 on the main thread, 6 only by Bash", () => {
    const edits = world.nickSession.runs().filter((run) => run.event === "PostToolUse" && run.filePath !== null);
    const bash = world.nickSession.runs().filter((run) => run.event === "PostToolUse" && run.toolName === "Bash" && run.agentId !== null);
    expect(new Set(world.files.nickAll).size).toBe(190);
    expect(new Set(edits.map((run) => run.filePath)).size).toBe(184);
    expect(new Set(edits.filter((run) => run.agentId !== null).map((run) => run.filePath)).size).toBe(172);
    expect(bash).toHaveLength(6);
  });

  test("setup: every file an edit tool reported reached the hub as Nick's target (pilot: 180 of 190 did)", () => {
    const nickValues = new Set(seen.targets.filter((target) => target.developer === "Nick").map((target) => target.value));
    const bashOnly = new Set([...world.files.nickMappingByBash, ...world.files.nickBashOnlyOthers]);
    const toolReported = world.files.nickAll.filter((path) => !bashOnly.has(path) && !world.files.nickEnvFiles.includes(path));
    expect(toolReported).toHaveLength(180);
    expect(toolReported.filter((path) => !nickValues.has(path))).toEqual([]);
  });

  test("setup: the subagent's own hooks met Mike on the shared files (the hits existed; the pilot's reached only the subagent)", () => {
    const hits = world.moments.nickSubagentHits.filter(
      (run) => run.event === "PreToolUse" && run.agentId !== null && mentions(agentTexts([run]), "Mike"),
    );
    expect(hits.length, "a subagent edit of a file Mike works on must trip the wire").toBeGreaterThan(0);
  });

  test("setup: Tina's report named Nick's base commit, which main now contains (the report that stamped b)", () => {
    const reports = hub.wire.filter(
      (entry) => entry.developer === "Tina" && entry.method === "POST" && entry.requestBody.includes("landed_evidence"),
    );
    expect(mentions(reports.map((entry) => entry.requestBody), world.commits.staleBase)).toBe(true);
  });

  // ── 1. Mike is told, in a channel a person reads ───────────────────────
  // fixed by feat/collision-visible (systemMessage from the sync PreToolUse).
  expectedFailure("1a: Mike's next edit tells MIKE that Nick overlaps (pilot: hints reached only agents, 0 of 157 opened)", () => {
    expect(mentions(personLines(world.moments.mikeNext), "Nick"), "no systemMessage naming Nick reached Mike").toBe(true);
  });

  // fixed by feat/collision-visible (the channel) + feat/topic-contexts (the topic).
  expectedFailure("1b: the line Mike reads names Nick's topic feat/numlabs-practices, never the stale title (pilot: wrong title a)", () => {
    const person = personLines(world.moments.mikeNext);
    expect(mentions(person, TOPIC_BRANCH), `person lines: ${JSON.stringify(person)}`).toBe(true);
    expect(mentions(person, STALE_BRANCH)).toBe(false);
  });

  // fixed by feat/topic-contexts (the NumLabs work files under its own context, titled after its branch).
  expectedFailure("1c: the collision Mike's agent is told names Nick's topic, never the stale title (pilot: wrong title a)", () => {
    const aboutNick = collisionTextsFor(world.moments.mikeNext).filter((text) => text.includes("Nick"));
    expect(aboutNick.length, "Mike's agent must be told of a collision with Nick at all").toBeGreaterThan(0);
    expect(mentions(aboutNick, TOPIC_BRANCH), `agent texts: ${JSON.stringify(aboutNick)}`).toBe(true);
    expect(mentions(aboutNick, STALE_BRANCH)).toBe(false);
  });

  // fixed by feat/collision-visible (statusline) + Sweep ≠ Ignore (the 11-file ghost row) + feat/topic-contexts (the 3 Bash files).
  expectedFailure("1d: Mike's statusline shows the overlap with Nick on all 11 files (pilot: nobody warned)", () => {
    expect(world.moments.mikeStatusline).toMatch(/overlap: Nick · 11 files/);
  });

  // ── 2. Nick is told, including what only a subagent saw ────────────────
  // fixed by feat/collision-visible (relay at subagent return / next prompt).
  expectedFailure("2a: Nick's main thread tells NICK of a hit first seen by a subagent (pilot: 91% subagent edits, hits stayed there)", () => {
    expect(mentions(personLines(world.moments.nickReturnAndPrompt), "Mike")).toBe(true);
  });

  // fixed by feat/collision-visible.
  expectedFailure("2b: the relayed line names Mike's branch feat/streaming-practice-beta", () => {
    expect(mentions(personLines(world.moments.nickReturnAndPrompt), MIKE_BRANCH)).toBe(true);
  });

  // fixed by feat/collision-visible.
  expectedFailure("2c: Nick's statusline shows the overlap with Mike", () => {
    expect(world.moments.nickStatusline).toMatch(/overlap: Mike/);
  });

  // ── 3. The false landed stamp stays fixed ──────────────────────────────
  test("3: no context of Nick's (or Mike's) is landed after Tina's report (pilot: false landed stamp b)", () => {
    const landed = seen.contexts.filter((context) => context.landedAt !== null);
    expect(landed.map((context) => `${context.developer} ${context.title}`)).toEqual([]);
  });

  // ── 4. The overlap survives Nick's size ─────────────────────────────────
  // fixed by Sweep ≠ Ignore (fix/false-landed-stamp, in progress).
  expectedFailure("4a: Mike's ghost check lists Nick's work despite 190 files (pilot: sweep filter c)", () => {
    expect(nickRows(seen.mikeGhost).length, JSON.stringify(seen.mikeGhost)).toBeGreaterThan(0);
  });

  // fixed by Sweep ≠ Ignore (fix/false-landed-stamp, in progress).
  expectedFailure("4b: the conference pairs Mike's and Nick's contexts despite 190 files (pilot: sweep filter c)", () => {
    const nickIds = new Set(seen.contexts.filter((context) => context.developer === "Nick").map((context) => context.id));
    const mikeIds = new Set(seen.contexts.filter((context) => context.developer === "Mike").map((context) => context.id));
    const pairs = seen.mikeConference.filter(
      (pair) =>
        (nickIds.has(pair.workContextIdA) && mikeIds.has(pair.workContextIdB)) ||
        (nickIds.has(pair.workContextIdB) && mikeIds.has(pair.workContextIdA)),
    );
    expect(pairs.length).toBeGreaterThan(0);
  });

  // fixed by Sweep ≠ Ignore (fix/false-landed-stamp, in progress).
  expectedFailure("4c: the overlap row says Nick's change is large rather than hiding it (Sweep ≠ Ignore)", () => {
    const rows = nickRows(seen.mikeGhost);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(isQualifiedAsLarge), JSON.stringify(rows)).toBe(true);
  });

  // ── 5. Bash-created files count ────────────────────────────────────────
  // fixed by feat/topic-contexts (the git lane sweeps every touched root, untracked files included).
  expectedFailure("5a: all six Bash-only files reach the hub as Nick's targets (pilot: 6 files created by Bash, never captured)", () => {
    const nickValues = new Set(seen.targets.filter((target) => target.developer === "Nick").map((target) => target.value));
    const bashOnly = [...world.files.nickMappingByBash, ...world.files.nickBashOnlyOthers];
    expect(bashOnly.filter((path) => !nickValues.has(path))).toEqual([]);
  });

  // fixed by feat/topic-contexts.
  expectedFailure("5b: Mike's edit of a file Nick changed only by `cp` trips the wire on Nick", () => {
    const grid = runsOn(world.moments.mikeNext, "/PlayerMappingGrid.tsx", "PreToolUse");
    expect(mentions(agentTexts(grid), "Nick")).toBe(true);
  });

  // fixed by feat/topic-contexts + Sweep ≠ Ignore: the row exists and counts the Bash files.
  expectedFailure("5c: the overlap counts all 11 shared files, the three Bash-only ones included", () => {
    expect(nickRows(seen.mikeGhost).map((row) => row.sharedTargetCount)).toContain(11);
  });

  // ── 6. Coverage lines stay honest ──────────────────────────────────────
  test("6a: every target names the lane that saw it — no Bash-only file is ever labelled an edit-tool touch", () => {
    const bashOnly = new Set([...world.files.nickMappingByBash, ...world.files.nickBashOnlyOthers]);
    const mislabelled = seen.targets.filter(
      (target) => target.developer === "Nick" && bashOnly.has(target.value) && target.source === "tool_edit",
    );
    expect(mislabelled).toEqual([]);
  });

  test("6b: the coverage Mike's tripwire answers carried has five rows in contract order and no complete row without an emitter", () => {
    const answers = tripwireAnswers(world);
    expect(answers.length, "Mike's PreToolUse must have asked the hub").toBeGreaterThan(0);
    for (const answer of answers) {
      expect(answer.sources.map((row) => row.source)).toEqual(COVERAGE_SOURCE_ORDER);
      expect(answer.sources.filter((row) => SOURCES_WITHOUT_EMITTER.has(row.source) && row.state === "complete")).toEqual([]);
    }
  });

  test("6c: agent_event agrees with the connectors' own loss ledgers, and an answer naming a session never reads 'no session in window'", async () => {
    const totals = await Promise.all(
      [world.mike, world.nick, world.tina].map(
        async (developer) => (await readTelemetryLossReport(developer.home, repoKey(hub.url, world.plan.repoId))).total,
      ),
    );
    const anyLoss = totals.some((total) => total > 0);
    const answers = tripwireAnswers(world);
    const contradictions = answers.filter((answer) => {
      const row = agentEventOf(answer);
      return (
        (anyLoss && row?.state === "complete") ||
        (!anyLoss && row?.reason === "telemetry_lost") ||
        (answer.sessions > 0 && row?.reason === "no_session_in_window")
      );
    });
    expect(contradictions, `losses ${JSON.stringify(totals)}`).toEqual([]);
    // The briefing's own coverage line never claims a loss no connector booked.
    const briefings = agentTexts(
      [world.mikeSession, world.nickSession, world.tinaSession].flatMap((session) =>
        session.runs().filter((run) => run.event === "SessionStart"),
      ),
    );
    const claimsLoss = briefings.filter((text) => /telemetry[^.\n]*lost/i.test(text));
    expect(anyLoss ? [] : claimsLoss).toEqual([]);
  });

  // ── .env: never content, anywhere ──────────────────────────────────────
  test("env: the four .env files never left the machine — no request, hub row, home file or hook output holds their content", async () => {
    const outputs = [world.mikeSession, world.nickSession, world.tinaSession].flatMap((session) =>
      session.runs().map((run) => run.stdout),
    );
    const found = await findMarker(
      world.secret,
      {
        "hub requests": hub.wire.map((entry) => entry.requestBody).join("\n"),
        "hub answers": hub.wire.map((entry) => entry.responseBody).join("\n"),
        "hub database": await dumpDatabase(hub.db),
        "hook outputs": outputs.join("\n"),
        statuslines: `${world.moments.mikeStatusline}\n${world.moments.nickStatusline}`,
      },
      [world.mike.home, world.nick.home, world.tina.home],
    );
    expect(found).toEqual([]);
  });

  test("env: no .env path became a target either (the denylist holds on both lanes)", () => {
    const envTargets = seen.targets.filter((target) => /(^|\/)\.env/.test(target.value));
    expect(envTargets).toEqual([]);
  });
});

describe("N1 — same scale, zero shared files: silent", () => {
  let world: LongSessionWorld;
  let seen: Observed;

  beforeAll(async () => {
    world = await runLongSessionCase(hub, N1_PLAN);
    cleanups.push(...world.cleanup);
    seen = await observe(world);
  }, CASE_TIMEOUT_MS);

  test("setup: the same 190-file, subagent-heavy, detached long session", () => {
    const edits = world.nickSession.runs().filter((run) => run.event === "PostToolUse" && run.filePath !== null);
    expect(new Set(edits.filter((run) => run.agentId !== null).map((run) => run.filePath)).size).toBe(172);
    expect(seen.contexts.some((context) => context.developer === "Nick" && context.sessionBranch.startsWith("detached@"))).toBe(true);
  });

  test("N1: no collision line, tripwire output, briefing ghost section or statusline overlap for anybody", () => {
    expect(
      collisionNoise([world.mikeSession, world.nickSession], ["Mike", "Nick"], [world.moments.mikeStatusline, world.moments.nickStatusline]),
    ).toEqual(SILENT);
  });

  test("N1: no ghost row and no conference pair", () => {
    expect(seen.mikeGhost).toEqual([]);
    expect(seen.nickGhost).toEqual([]);
    expect(seen.mikeConference).toEqual([]);
  });
});

describe("N2 — overlap only in lockfiles and generated code: silent", () => {
  let world: GeneratedWorld;
  let rows: OverlapRows;

  beforeAll(async () => {
    world = await runGeneratedCase(hub);
    cleanups.push(...world.cleanup);
    rows = await overlapRows(hub, [world.mike, world.nick], world.repo.repoId);
  }, CASE_TIMEOUT_MS);

  test("setup: both developers' own work reached the hub, and each hand edit of a generated file asked the tripwire", async () => {
    const targets = await targetsOf(hub.db, world.repo.repoId);
    expect(targets.some((target) => target.developer === "Mike" && target.value === "apps/streaming/feed.ts")).toBe(true);
    expect(targets.some((target) => target.developer === "Nick" && target.value === "apps/numlabs/sync.ts")).toBe(true);
    expect([...world.nickEdits.keys()]).toEqual(GENERATED_CLASSES.map((entry) => entry.path));
  });

  /** NEW GAP — no branch addresses these; the rule that would is specified in release-gate/scenario-generated.ts. */
  const UNRECOGNISED_TODAY = new Set([
    "apps/practice/package-lock.json",
    "packages/api/src/__generated__/schema.ts",
    "packages/proto/src/messages_pb.ts",
  ]);
  for (const entry of GENERATED_CLASSES) {
    const classTest = UNRECOGNISED_TODAY.has(entry.path) ? expectedFailure : test;
    classTest(`N2 ${entry.name}: Nick's hand edit is told nothing about Mike, and no overlap row offers the file`, () => {
      const edit = world.nickEdits.get(entry.path) ?? [];
      expect([...agentTexts(edit), ...personLines(edit)].filter((text) => text.includes("Mike"))).toEqual([]);
      const offered = [...rows.ghost, ...rows.conference].filter((row) =>
        row.sharedTargets.some((target) => target.value === entry.path),
      );
      expect(offered).toEqual([]);
    });
  }

  // NEW GAP — no branch: the generated-target rule (spec in release-gate/scenario-generated.ts).
  expectedFailure("N2: the whole case is silent — no collision output, no statusline overlap, no overlap row", () => {
    expect(
      collisionNoise([world.mikeSession, world.nickSession], ["Mike", "Nick"], [world.mikeStatusline, world.nickStatusline]),
    ).toEqual(SILENT);
    expect(rows.ghost).toEqual([]);
    expect(rows.conference).toEqual([]);
  });
});



