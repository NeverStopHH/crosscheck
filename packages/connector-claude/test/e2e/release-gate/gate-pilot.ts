/**
 * P1 — the pilot collision — and its twin N1, as test suites for any profile
 * (release-gate/profile.ts). Each case runs its whole scenario in `beforeAll`;
 * every test only reads what happened, so an expected failure can never be a
 * setup error in disguise — the `setup` tests are ordinary tests and must
 * pass under every profile.
 *
 * The assertions are the gate's own (provenance in each comment). A profile
 * with parallel subagents adds R1, the relay's per-hit check; a profile with
 * the lives adds L1–L4, read after Nick's session ended and resumed. A
 * profile that may book instead of warn (the loaded lane) accepts, wherever
 * a PERSON must be told, a line the connector booked that says why — and
 * nowhere else.
 */
import { beforeAll, describe, expect } from "bun:test";

import { readTelemetryLossReport } from "@crosscheck/connector-core/spool/loss-report.ts";

import { repoKey } from "../../../src/index.ts";
import { gateTest } from "./expected.ts";
import type { Expectations } from "./expected.ts";
import {
  CASE_TIMEOUT_MS,
  COVERAGE_SOURCE_ORDER,
  SILENT,
  SOURCES_WITHOUT_EMITTER,
  agentEventOf,
  collisionBookings,
  collisionNoise,
  collisionTextsFor,
  crashedHooks,
  isQualifiedAsLarge,
  mentions,
  nickRows,
  overlapFileCount,
  runsOn,
  tripwireAnswers,
} from "./gate-checks.ts";
import { gitIn } from "./git.ts";
import { agentTexts, personLines } from "./host.ts";
import type { HookRun } from "./host.ts";
import { breakdownOf, isHookTraceOn, readHookTraces, renderBreakdowns } from "./hook-traces.ts";
import type { Breakdown } from "./hook-traces.ts";
import { dumpDatabase } from "./hub.ts";
import type { TestHub } from "./hub.ts";
import { bookedLines, bookingsOf } from "./observe.ts";
import type { Moment } from "./observe.ts";
import type { GateProfile } from "./profile.ts";
import {
  MIKE_AFTER_RESUME_FILES,
  MIKE_BRANCH,
  MIKE_NEXT_FILES,
  STALE_BRANCH,
  TOPIC_BRANCH,
  runLongSessionCase,
} from "./scenario-long-session.ts";
import type { LongSessionPlan, LongSessionWorld } from "./scenario-long-session.ts";
import { FOREGROUND_HITS } from "./scenario-nick-work.ts";
import { findMarker } from "./team.ts";
import type { GateDeveloper } from "./team.ts";

export interface GateContext {
  readonly profile: GateProfile;
  /** The file's shared hub, started in its own `beforeAll`. */
  readonly hub: () => TestHub;
  /** Directories the file deletes in its `afterAll`. */
  readonly cleanups: string[];
  readonly expected: Expectations;
}

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

type Get = () => LongSessionWorld;
type Register = (id: string, name: string, body: () => void | Promise<void>) => void;

/**
 * The person saw it — or, in the loaded lane only, `developer`'s connector
 * booked, INSIDE `moment`, a line that names the untold warning itself
 * (release-gate/gate-checks.ts `collisionBookings`).
 */
const toldOrBooked = async (ctx: GateContext, told: boolean, developer: GateDeveloper, moment: Moment): Promise<boolean> =>
  told || (ctx.profile.mayBookInsteadOfWarn && collisionBookings(await bookingsOf(developer), moment).length > 0);

const shortName = (path: string): string => path.split("/").at(-1) ?? path;

const pilotSetup = (it: Register, get: Get, hub: () => TestHub): void => {
  it("P1.setup.detached", "Nick's ONE session is detached at a main commit a stale branch still points at (the shape of a)", async () => {
    const own = get().seen.contexts.filter((context) => context.developer === "Nick" && !context.id.includes("~t"));
    expect(own, "Nick's long session must own exactly one session context").toHaveLength(1);
    expect(own[0]?.sessionBranch.startsWith("detached@"), "agentic-main must be a DETACHED HEAD").toBe(true);
    const head = await gitIn(get().roots.nickStart, ["rev-parse", "HEAD"]);
    expect(await gitIn(get().roots.nickStart, ["rev-parse", STALE_BRANCH])).toBe(head);
    await gitIn(get().roots.nickStart, ["merge-base", "--is-ancestor", head, "origin/main"]);
  });

  it("P1.setup.files", "Nick touched 190 files — 172 by subagents, 12 on the main thread, 6 only by Bash", () => {
    const runs = get().nickSession.runs();
    const edits = runs.filter((run) => run.event === "PostToolUse" && run.filePath !== null);
    const bash = runs.filter((run) => run.event === "PostToolUse" && run.toolName === "Bash" && run.agentId !== null);
    expect(new Set(get().files.nickAll).size).toBe(190);
    expect(new Set(edits.map((run) => run.filePath)).size).toBe(184);
    expect(new Set(edits.filter((run) => run.agentId !== null).map((run) => run.filePath)).size).toBe(172);
    expect(bash).toHaveLength(6);
  });

  it("P1.setup.reached", "every file an edit tool reported reached the hub as Nick's target (pilot: 180 of 190 did)", () => {
    const { files, seen } = get();
    const nickValues = new Set(seen.targets.filter((target) => target.developer === "Nick").map((target) => target.value));
    const bashOnly = new Set([...files.nickMappingByBash, ...files.nickBashOnlyOthers]);
    const toolReported = files.nickAll.filter((path) => !bashOnly.has(path) && !files.nickEnvFiles.includes(path));
    expect(toolReported).toHaveLength(180);
    expect(toolReported.filter((path) => !nickValues.has(path))).toEqual([]);
  });

  it("P1.setup.hits", "the subagent's own hooks met Mike on the shared files (the hits existed; the pilot's reached only the subagent)", () => {
    const hits = get().moments.nickSubagentHits.filter(
      (run) => run.event === "PreToolUse" && run.agentId !== null && mentions(agentTexts([run]), "Mike"),
    );
    expect(hits.length, "a subagent edit of a file Mike works on must trip the wire").toBeGreaterThan(0);
  });

  it("P1.setup.report", "Tina's report named Nick's base commit, which main now contains (the report that stamped b)", () => {
    const reports = hub().wire.filter(
      (entry) => entry.developer === "Tina" && entry.method === "POST" && entry.requestBody.includes("landed_evidence"),
    );
    expect(mentions(reports.map((entry) => entry.requestBody), get().commits.staleBase)).toBe(true);
  });

  it("P1.setup.processes", "no hook process crashed or hung (a hook always exits 0)", () => {
    expect(crashedHooks([get().mikeSession, get().nickSession, get().tinaSession])).toEqual([]);
  });

  // WHAT THE EXPECTED FAILURES READ EXISTS: 1d, 5b, R1 and L1-L4 can only fail on what they assert,
  // never on a moment that did not happen (a statusline that never rendered, an edit that never ran).
  it("P1.setup.moments", "every moment the assertions read happened: statuslines rendered, Mike's edits ran, the hits and the lives exist", () => {
    const { moments, seenAfterResume, profile } = get();
    const preOn = (runs: readonly HookRun[] | null, names: readonly string[]): readonly string[] =>
      names.filter((name) => runsOn(runs ?? [], `/${name}`, "PreToolUse").length === 0);
    expect(moments.mikeStatusline).toContain("cx ");
    expect(preOn(moments.mikeNext, MIKE_NEXT_FILES)).toEqual([]);
    if (profile.isParallel) {
      expect(moments.nickStatuslineAtTurnEnd ?? "").toContain("cx ");
      expect(foregroundHitFiles(get()).size, "the simultaneous foreground hits must exist").toBeGreaterThan(0);
    }
    if (profile.hasCompactAndResume) {
      expect(seenAfterResume, "the snapshot after Nick's resume").not.toBeNull();
      expect(moments.mikeStatuslineAfterResume ?? "").toContain("cx ");
      expect(preOn(moments.mikeAfterResume, MIKE_AFTER_RESUME_FILES)).toEqual([]);
    }
  });
};

const pilotMikeTold = (it: Register, get: Get, ctx: GateContext): void => {
  // fixed by feat/collision-visible (systemMessage from the sync PreToolUse).
  it("1a", "Mike's next edit tells MIKE that Nick overlaps (pilot: hints reached only agents, 0 of 157 opened)", async () => {
    const told = mentions(personLines(get().moments.mikeNext), "Nick");
    expect(await toldOrBooked(ctx, told, get().mike, get().moments.mikeNextMoment), "no systemMessage naming Nick reached Mike").toBe(true);
  });

  // Was a gap ("NEW GAP — no branch"): the person's line was topic-less; fixed on the batch.
  it("1b", "the line Mike reads names Nick's topic feat/numlabs-practices, never the stale title (pilot: wrong title a)", () => {
    const person = personLines(get().moments.mikeNext);
    expect(mentions(person, TOPIC_BRANCH), `person lines: ${JSON.stringify(person)}`).toBe(true);
    expect(mentions(person, STALE_BRANCH)).toBe(false);
  });

  // fixed by feat/topic-contexts (the NumLabs work files under its own context, titled after its branch).
  it("1c", "the collision Mike's agent is told names Nick's topic, never the stale title (pilot: wrong title a)", () => {
    const aboutNick = collisionTextsFor(get().moments.mikeNext).filter((text) => text.includes("Nick"));
    expect(aboutNick.length, "Mike's agent must be told of a collision with Nick at all").toBeGreaterThan(0);
    expect(mentions(aboutNick, TOPIC_BRANCH), `agent texts: ${JSON.stringify(aboutNick)}`).toBe(true);
    expect(mentions(aboutNick, STALE_BRANCH)).toBe(false);
  });

  // A pointer is only worth handing over if it opens something.
  it("1e", "every get_diagnosis pointer in Mike's collision opens a context that exists", () => {
    const known = new Set(get().seen.contexts.map((context) => context.id));
    const pointers = collisionTextsFor(get().moments.mikeNext).flatMap((text) =>
      [...text.matchAll(/get_diagnosis (\S+)/g)].map((match) => (match[1] ?? "").replace(/\.$/, "")),
    );
    expect(pointers.length, "the collision must hand Mike's agent a pointer").toBeGreaterThan(0);
    expect(pointers.filter((id) => !known.has(id)), `known: ${JSON.stringify([...known])}`).toEqual([]);
  });

  // fixed by feat/collision-visible (statusline) + Sweep ≠ Ignore (the 11-file ghost row) + feat/topic-contexts (the 3 Bash files).
  it("1d", "Mike's statusline shows the overlap with Nick on all 11 files (pilot: nobody warned)", () => {
    expect(get().moments.mikeStatusline).toMatch(/overlap: Nick · 11 files/);
  });
};

/** The shared files a foreground worker's own PreToolUse warned about Mike. */
const foregroundHitFiles = (world: LongSessionWorld): ReadonlySet<string> => {
  const opened = new Set(world.files.nickMappingByEdit.slice(0, FOREGROUND_HITS).map(shortName));
  return new Set(
    world.moments.nickSubagentHits
      .filter((run) => run.event === "PreToolUse" && run.agentId !== null && mentions(agentTexts([run]), "Mike"))
      .flatMap((run) => (run.filePath === null ? [] : [shortName(run.filePath)]))
      .filter((name) => opened.has(name)),
  );
};

const pilotNickTold = (it: Register, get: Get, ctx: GateContext): void => {
  // fixed by feat/collision-visible (relay at subagent return / turn end / next prompt).
  it("2a", "Nick's main thread tells NICK of a hit first seen by a subagent (pilot: 91% subagent edits, hits stayed there)", async () => {
    const person = personLines(get().moments.nickReturnAndPrompt);
    const shared = get().files.nickMappingByEdit.map(shortName);
    const told = person.some((line) => shared.some((name) => line.includes(name)));
    expect(await toldOrBooked(ctx, told, get().nick, get().moments.nickWork), JSON.stringify(person)).toBe(true);
  });

  // Was a gap: fixed on the batch by 2898b5da (a relayed collision names the teammate unless a presence answer omits them).
  it("2b", "the relayed line names Mike and his branch feat/streaming-practice-beta", async () => {
    const person = personLines(get().moments.nickReturnAndPrompt);
    const told = mentions(person, "Mike") && mentions(person, MIKE_BRANCH);
    expect(await toldOrBooked(ctx, told, get().nick, get().moments.nickWork), JSON.stringify(person)).toBe(true);
  });

  // fixed by feat/collision-visible.
  it("2c", "Nick's statusline shows the overlap with Mike", async () => {
    const told = /overlap: Mike/.test(get().moments.nickStatusline);
    expect(await toldOrBooked(ctx, told, get().nick, get().moments.nickWork), get().moments.nickStatusline).toBe(true);
  });

  if (ctx.profile.isParallel) {
    // The relay, hit by hit (review H2): six foreground workers each edit a shared file mid-run.
    // Every one whose agent was warned about Mike is a file the person's record holds — what the
    // statusline counts and the relay tells — when the turn ends, before any re-briefing adds it.
    // Its precondition (the hits exist, the statusline rendered) is P1.setup.moments, a plain test.
    it("R1", "every shared file a foreground subagent was warned about is on NICK's record when the turn ends (statusline count)", async () => {
      const hits = foregroundHitFiles(get());
      const statusline = get().moments.nickStatuslineAtTurnEnd ?? "";
      const told = overlapFileCount(statusline) >= hits.size;
      expect(
        await toldOrBooked(ctx, told, get().nick, get().moments.nickWork),
        `${String(hits.size)} hits [${[...hits].join(", ")}] · ${statusline}`,
      ).toBe(true);
    });
  }
};

const pilotHubRows = (it: Register, get: Get): void => {
  it("3", "no context of Nick's (or Mike's) is landed after Tina's report (pilot: false landed stamp b)", () => {
    const landed = get().seen.contexts.filter((context) => context.landedAt !== null);
    expect(landed.map((context) => `${context.developer} ${context.title}`)).toEqual([]);
  });

  // fixed by Sweep ≠ Ignore (fix/false-landed-stamp 0d29e41e).
  it("4a", "Mike's ghost check lists Nick's work despite 190 files (pilot: sweep filter c)", () => {
    expect(nickRows(get().seen.mikeGhost).length, JSON.stringify(get().seen.mikeGhost)).toBeGreaterThan(0);
  });

  // fixed by Sweep ≠ Ignore (fix/false-landed-stamp 0d29e41e).
  it("4b", "the conference pairs Mike's and Nick's contexts despite 190 files (pilot: sweep filter c)", () => {
    const { contexts, mikeConference } = get().seen;
    const nickIds = new Set(contexts.filter((context) => context.developer === "Nick").map((context) => context.id));
    const mikeIds = new Set(contexts.filter((context) => context.developer === "Mike").map((context) => context.id));
    const pairs = mikeConference.filter(
      (pair) =>
        (nickIds.has(pair.workContextIdA) && mikeIds.has(pair.workContextIdB)) ||
        (nickIds.has(pair.workContextIdB) && mikeIds.has(pair.workContextIdA)),
    );
    expect(pairs.length).toBeGreaterThan(0);
  });

  // fixed by Sweep ≠ Ignore (fix/false-landed-stamp 0d29e41e).
  it("4c", "the overlap row says Nick's change is large rather than hiding it (Sweep ≠ Ignore)", () => {
    const rows = nickRows(get().seen.mikeGhost);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(isQualifiedAsLarge), JSON.stringify(rows)).toBe(true);
  });

  // fixed by feat/topic-contexts (the git lane sweeps every touched root, untracked files included).
  it("5a", "all six Bash-only files reach the hub as Nick's targets (pilot: 6 files created by Bash, never captured)", () => {
    const { files, seen } = get();
    const nickValues = new Set(seen.targets.filter((target) => target.developer === "Nick").map((target) => target.value));
    const bashOnly = [...files.nickMappingByBash, ...files.nickBashOnlyOthers];
    expect(bashOnly.filter((path) => !nickValues.has(path))).toEqual([]);
  });

  // fixed by feat/topic-contexts.
  it("5b", "Mike's edit of a file Nick changed only by `cp` trips the wire on Nick", () => {
    const grid = runsOn(get().moments.mikeNext, "/PlayerMappingGrid.tsx", "PreToolUse");
    expect(mentions(agentTexts(grid), "Nick")).toBe(true);
  });

  // fixed by feat/topic-contexts + Sweep ≠ Ignore: the row exists and counts the Bash files.
  it("5c", "the overlap counts all 11 shared files, the three Bash-only ones included", () => {
    expect(nickRows(get().seen.mikeGhost).map((row) => row.sharedTargetCount)).toContain(11);
  });
};

const pilotCoverage = (it: Register, get: Get, ctx: GateContext): void => {
  it("6a", "every target names the lane that saw it — no Bash-only file is ever labelled an edit-tool touch", () => {
    const { files, seen } = get();
    const bashOnly = new Set([...files.nickMappingByBash, ...files.nickBashOnlyOthers]);
    const mislabelled = seen.targets.filter(
      (target) => target.developer === "Nick" && bashOnly.has(target.value) && target.source === "tool_edit",
    );
    expect(mislabelled).toEqual([]);
  });

  it("6b", "the coverage Mike's tripwire answers carried has five rows in contract order and no complete row without an emitter", () => {
    const answers = tripwireAnswers(ctx.hub(), "Mike", get().plan.repoId);
    expect(answers.length, "Mike's PreToolUse must have asked the hub").toBeGreaterThan(0);
    for (const answer of answers) {
      expect(answer.sources.map((row) => row.source)).toEqual(COVERAGE_SOURCE_ORDER);
      expect(answer.sources.filter((row) => SOURCES_WITHOUT_EMITTER.has(row.source) && row.state === "complete")).toEqual([]);
    }
  });

  it("6c", "agent_event agrees with the connectors' own loss ledgers, and an answer naming a session never reads 'no session in window'", async () => {
    const world = get();
    const totals = await Promise.all(
      [world.mike, world.nick, world.tina].map(
        async (developer) => (await readTelemetryLossReport(developer.home, repoKey(ctx.hub().url, world.plan.repoId))).total,
      ),
    );
    const anyLoss = totals.some((total) => total > 0);
    const contradictions = tripwireAnswers(ctx.hub(), "Mike", world.plan.repoId).filter((answer) => {
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
};

const pilotEnv = (it: Register, get: Get, ctx: GateContext): void => {
  it("env.content", "the four .env files never left the machine — no request, hub row, home file or hook output holds their content", async () => {
    const world = get();
    const hub = ctx.hub();
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
        statuslines: [
          world.moments.mikeStatusline,
          world.moments.nickStatusline,
          world.moments.nickStatuslineAtTurnEnd ?? "",
          world.moments.mikeStatuslineAfterResume ?? "",
        ].join("\n"),
      },
      [world.mike.home, world.nick.home, world.tina.home],
    );
    expect(found).toEqual([]);
  });

  it("env.paths", "no .env path became a target either (the denylist holds on both lanes)", () => {
    const snapshots = [get().seen, get().seenAfterResume].filter((seen) => seen !== null);
    const envTargets = snapshots.flatMap((seen) => seen.targets).filter((target) => /(^|\/)\.env/.test(target.value));
    expect(envTargets).toEqual([]);
  });
};

/**
 * THE LIVES (review H1): read after Nick's session compacted (Mike's morning
 * check already saw that), ended, resumed and stopped again — touching no
 * shared file after the resume. Everything Nick did before is still on his
 * disk, dirty or untracked; Mike must still see all of it.
 */
const pilotLives = (it: Register, get: Get, ctx: GateContext): void => {
  const after = (): NonNullable<LongSessionWorld["seenAfterResume"]> => {
    const seen = get().seenAfterResume;
    if (seen === null) {
      throw new Error("the lives did not run");
    }
    return seen;
  };
  const mikeLater = (): NonNullable<LongSessionWorld["moments"]["mikeAfterResume"]> => get().moments.mikeAfterResume ?? [];

  it("L1", "after Nick's session ended and resumed, Mike's tripwire still warns about Nick on all 11 shared files, the Bash-only ones included", () => {
    const warned = [...after().mikeWarnedAboutNick].sort();
    expect(warned.map(shortName)).toEqual([...get().files.mikeMapping].sort().map(shortName));
  });

  it("L2", "after the resume, Mike's ghost check still counts all 11 shared files for Nick", () => {
    expect(nickRows(after().mikeGhost).map((row) => row.sharedTargetCount)).toContain(11);
  });

  it("L3", "Mike's edits after the resume warn his agent about Nick, on a file Nick edited and one he wrote only by Bash, both before", () => {
    const silentOn = MIKE_AFTER_RESUME_FILES.filter(
      (name) => !mentions(agentTexts(runsOn(mikeLater(), `/${name}`, "PreToolUse")), "Nick"),
    );
    expect(silentOn).toEqual([]);
  });

  it("L4", "after the resume, Mike is told of Nick in a line he reads", async () => {
    const told = mentions(personLines(mikeLater()), "Nick");
    const moment = get().moments.mikeAfterResumeMoment ?? { from: 0, to: 0 };
    expect(await toldOrBooked(ctx, told, get().mike, moment), JSON.stringify(personLines(mikeLater()))).toBe(true);
  });
};

/** The one line a run prints about P1: enough to read a CI log by, nothing the assertions depend on. */
const pilotSummary = async (world: LongSessionWorld, wallMs: number): Promise<string> => {
  const runs = [world.mikeSession, world.nickSession, world.tinaSession].flatMap((session) => session.runs());
  const hitMs = world.moments.nickSubagentHits
    .filter((run) => run.event === "PreToolUse" && run.agentId !== null && mentions(agentTexts([run]), "Mike"))
    .map((run) => run.durationMs ?? 0)
    .sort((left, right) => left - right);
  return [
    `P1 [${world.profile.name}] ${String(Math.round(wallMs / 1000))} s, ${String(runs.length)} hook runs`,
    `subagent hits ${String(hitMs.length)} (process ms ${hitMs.join(",")})`,
    `nick at turn end "${world.moments.nickStatuslineAtTurnEnd ?? "-"}"`,
    `nick relay lines naming Mike ${String(personLines(world.moments.nickReturnAndPrompt).filter((line) => line.includes("Mike")).length)}`,
    `mike warned about nick ${String(world.seen.mikeWarnedAboutNick.length)}/11, after resume ${String(world.seenAfterResume?.mikeWarnedAboutNick.length ?? "-")}/11`,
    `nick booked [${(await bookedLines(world.nick)).join(", ")}]`,
    `mike booked [${(await bookedLines(world.mike)).join(", ")}]`,
  ].join(" · ");
};

/**
 * WHERE THE FAN-OUT'S WALL TIME GOES (only with CX_HOOK_TRACE=1;
 * release-gate/hook-traces.ts): Nick's subagent PreToolUse processes at the
 * fan-out, the hits among them, the async captures running beside them, and
 * Mike's PreToolUse on a quiet machine the next morning as the baseline.
 */
const pilotTraceLines = async (world: LongSessionWorld): Promise<readonly string[]> => {
  const traces = await readHookTraces();
  const breakdowns = (runs: readonly HookRun[]): readonly Breakdown[] =>
    runs.flatMap((run) => {
      const breakdown = breakdownOf(run, traces);
      return breakdown === null ? [] : [breakdown];
    });
  const fanOut = world.moments.nickSubagentHits;
  const preToolUse = fanOut.filter((run) => run.event === "PreToolUse" && run.agentId !== null);
  return [
    ...renderBreakdowns("fan-out, subagent PreToolUse", breakdowns(preToolUse)),
    ...renderBreakdowns(
      "fan-out, subagent PreToolUse that warned about Mike (the hits)",
      breakdowns(preToolUse.filter((run) => mentions(agentTexts([run]), "Mike"))),
    ),
    ...renderBreakdowns("fan-out, async PostToolUse captures", breakdowns(fanOut.filter((run) => run.event === "PostToolUse" && run.isAsync))),
    ...renderBreakdowns("the next morning, Mike's PreToolUse (quiet)", breakdowns(world.moments.mikeNext.filter((run) => run.event === "PreToolUse"))),
  ];
};

export const describePilot = (ctx: GateContext): void => {
  describe(`P1 — the pilot collision must warn both people [${ctx.profile.name}]`, () => {
    const held: { world: LongSessionWorld | null } = { world: null };
    const get: Get = () => {
      if (held.world === null) {
        throw new Error("P1's scenario did not run");
      }
      return held.world;
    };
    beforeAll(async () => {
      const startedAt = performance.now();
      held.world = await runLongSessionCase(ctx.hub(), P1_PLAN, ctx.profile);
      ctx.cleanups.push(...held.world.cleanup);
      console.log(await pilotSummary(held.world, performance.now() - startedAt));
      if (isHookTraceOn()) {
        console.log((await pilotTraceLines(held.world)).join("\n"));
      }
    }, CASE_TIMEOUT_MS);
    const it: Register = (id, name, body) => gateTest(ctx.expected, id, name, body);
    pilotSetup(it, get, ctx.hub);
    // fixed by feat/topic-contexts (07cbf301: a detached session is never titled after a branch that merely points at its commit).
    it("a", "no context of Nick's is titled after the stale branch (pilot: wrong title a)", () => {
      const stale = get().seen.contexts.filter((context) => context.developer === "Nick" && context.title.includes(STALE_BRANCH));
      expect(stale.map((context) => context.title)).toEqual([]);
    });
    pilotMikeTold(it, get, ctx);
    pilotNickTold(it, get, ctx);
    pilotHubRows(it, get);
    pilotCoverage(it, get, ctx);
    pilotEnv(it, get, ctx);
    if (ctx.profile.hasCompactAndResume) {
      pilotLives(it, get, ctx);
    }
  });
};

export const describeScaleTwin = (ctx: GateContext): void => {
  describe(`N1 — same scale, zero shared files: silent [${ctx.profile.name}]`, () => {
    const held: { world: LongSessionWorld | null } = { world: null };
    const get: Get = () => {
      if (held.world === null) {
        throw new Error("N1's scenario did not run");
      }
      return held.world;
    };
    beforeAll(async () => {
      held.world = await runLongSessionCase(ctx.hub(), N1_PLAN, ctx.profile);
      ctx.cleanups.push(...held.world.cleanup);
    }, CASE_TIMEOUT_MS);
    const it: Register = (id, name, body) => gateTest(ctx.expected, id, name, body);

    it("N1.setup", "the same 190-file, subagent-heavy, detached long session", () => {
      const edits = get().nickSession.runs().filter((run) => run.event === "PostToolUse" && run.filePath !== null);
      expect(new Set(edits.filter((run) => run.agentId !== null).map((run) => run.filePath)).size).toBe(172);
      expect(get().seen.contexts.some((context) => context.developer === "Nick" && context.sessionBranch.startsWith("detached@"))).toBe(true);
    });

    it("N1.setup.processes", "no hook process crashed or hung (a hook always exits 0)", () => {
      expect(crashedHooks([get().mikeSession, get().nickSession, get().tinaSession])).toEqual([]);
    });

    it("N1", "no collision line, tripwire output, briefing ghost section or statusline overlap for anybody", () => {
      const { moments } = get();
      const statuslines = [
        moments.mikeStatusline,
        moments.nickStatusline,
        moments.nickStatuslineAtTurnEnd ?? "",
        moments.mikeStatuslineAfterResume ?? "",
      ];
      expect(collisionNoise([get().mikeSession, get().nickSession], ["Mike", "Nick"], statuslines)).toEqual(SILENT);
    });

    it("N1.rows", "no ghost row and no conference pair, at the morning check and after Nick's resume", () => {
      for (const seen of [get().seen, get().seenAfterResume].filter((entry) => entry !== null)) {
        expect(seen.mikeGhost).toEqual([]);
        expect(seen.nickGhost).toEqual([]);
        expect(seen.mikeConference).toEqual([]);
      }
    });
  });
};
