/**
 * THE SIMULATION'S WORLD: seeded scenarios of one to three conversations on
 * one repo spool, and the actors that play them over the REAL register, flush,
 * heal and SessionEnd code (test/spool-simulation.test.ts).
 *
 * A scenario is a list of events, generated from a seed by a deterministic
 * PRNG, so a failing seed replays exactly and a shrinker can drop events from
 * it. Every actor does what a host does: SessionStart registers (walking the
 * life ladder on a resume), flushes with its healer and reaps; an edit
 * captures one target into the life the state names and the hook flushes;
 * set_intent posts a status straight to the hub; SessionEnd runs the end flow.
 * Around them: the hub ending a live life (a sibling's SessionEnd), a host
 * that goes idle for an hour or dies silently for good, an older connector's
 * flush, hub faults, a work context the hub refuses for good, and a crash at
 * any hooked write.
 */
import { readdir, utimes } from "node:fs/promises";

import {
  MAX_INGEST_BATCH,
  MAX_SPOOL_AGE_DAYS,
  MINUTES_PER_HOUR,
  MS_PER_DAY,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
} from "../../src/constants.ts";
import { repoKey, sessionSlug, sessionStatePath, spoolDir } from "../../src/config/paths.ts";
import { targetRecord, withProducer, workContextRecord } from "../../src/capture/records.ts";
import type { Producer } from "../../src/capture/records.ts";
import { seqAt, withSeq } from "../../src/capture/seq.ts";
import type { HubContext } from "../../src/http/client.ts";
import { endSession, postRecords } from "../../src/http/hub.ts";
import { endSessionFlow } from "../../src/flows/end-session.ts";
import { sessionHealer } from "../../src/flows/heal-session.ts";
import { fallbackWorkContextTitle, registerSessionFlow } from "../../src/flows/register-session.ts";
import { ACP_CONNECTOR, guaranteeDeclarationFor } from "../../src/guarantees/declarations.ts";
import { appendRecords } from "../../src/spool/append.ts";
import { bytesOfLines, writeCursorOffset } from "../../src/spool/cursor.ts";
import { readDropDetail, recordDrop } from "../../src/spool/drops.ts";
import { readAllSessionSpools, readSessionSpool } from "../../src/spool/files.ts";
import { flushSpool } from "../../src/spool/flush.ts";
import { settleOwedOnIntent } from "../../src/spool/owed-work-context.ts";
import { reapSpool } from "../../src/spool/reap.ts";
import { recordRefusedLife } from "../../src/spool/refused-lives.ts";
import { rejectCauseOf } from "../../src/spool/reject-cause.ts";
import { reapStaleSessionStates } from "../../src/state/session-reap.ts";
import { allocateSeq, readSessionState, updateSessionState } from "../../src/state/session-state.ts";
import { makeHome } from "../helpers.ts";
import { beginScenario, beginStep, endScenario, endStep, scenarioLog, SimulatedCrash } from "./sim-hooks.ts";
import type { Captured, Crash, DebtWrite, DropCall } from "./sim-hooks.ts";
import { calmDials, resetHub } from "./sim-hub.ts";
import type { Delivery, SimHub } from "./sim-hub.ts";

export const REPO_ID = "github.com/acme/simulation";
const BRANCH = "main";
const BASE_COMMIT = "0000000000000000000000000000000000000000";
const AGENT_KIND = "acp:simulation";
const REQUEST_TIMEOUT_MS = 1500;
/** What a hook spares a drain. */
const FLUSH_BUDGET_MS = 2000;
/** What the deadline check and one clamped request may add on a busy runner. */
const DRAIN_SLACK_MS = 600;
/** I5: a hook's drain returns inside its budget… */
const HOOK_LIMIT_MS = FLUSH_BUDGET_MS + DRAIN_SLACK_MS;
/** …and SessionEnd inside its drain's budget plus the one `end` call. */
const END_LIMIT_MS = FLUSH_BUDGET_MS + REQUEST_TIMEOUT_MS + DRAIN_SLACK_MS;
const MINUTE_MS = SECONDS_PER_MINUTE * MS_PER_SECOND;
/** The hour round 6's hold released an idle life after (review M2, P3). */
const IDLE_MS = 61 * MINUTE_MS;
/** Past the bound session-reap deletes a state on: the host died long ago. */
const ABANDONED_MS = MAX_SPOOL_AGE_DAYS * MS_PER_DAY + MINUTES_PER_HOUR * MINUTE_MS;
/** How many rounds the final drain may take before the scenario has failed to settle. */
const DRAIN_ROUNDS = 12;
const STATUSES = ["implementing", "blocked", "reviewing", "done"] as const;
const DEBT_SUFFIX = ".owed-wc";

export type SimEvent =
  | { readonly kind: "start"; readonly c: number }
  | { readonly kind: "edit"; readonly c: number }
  | { readonly kind: "flush"; readonly c: number }
  | { readonly kind: "intent"; readonly c: number; readonly status: string }
  | { readonly kind: "end"; readonly c: number }
  | { readonly kind: "hubEnd"; readonly c: number }
  | { readonly kind: "idle"; readonly c: number }
  | { readonly kind: "abandon"; readonly c: number }
  | { readonly kind: "oldFlush"; readonly c: number }
  | { readonly kind: "refuseWc"; readonly c: number }
  | {
      readonly kind: "fault";
      readonly fault: "records503" | "recordsLate" | "registersDown";
      readonly count: number;
      /** Calls of that kind that go through before the first one fails. */
      readonly after: number;
    }
  | ({ readonly kind: "crash" } & Crash);

/** mulberry32: a 32-bit seed, a stream of [0, 1). Small, fast and the same everywhere. */
export const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const WEIGHTS: readonly (readonly [SimEvent["kind"], number])[] = [
  ["edit", 30],
  ["flush", 4],
  ["start", 8],
  ["intent", 8],
  ["end", 7],
  ["hubEnd", 6],
  ["idle", 3],
  ["abandon", 2],
  ["oldFlush", 3],
  ["refuseWc", 2],
  ["fault", 12],
  ["crash", 15],
];

const pick = (random: () => number): SimEvent["kind"] => {
  const total = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [kind, weight] of WEIGHTS) {
    roll -= weight;
    if (roll < 0) {
      return kind;
    }
  }
  return "edit";
};

const FAULTS = ["records503", "recordsLate", "registersDown"] as const;

/** The events a connector process plays: the only ones an armed crash can kill. */
const ACTOR_EVENTS: ReadonlySet<SimEvent["kind"]> = new Set(["start", "edit", "flush", "intent", "end", "oldFlush"]);

/** The scenario a seed stands for: 1–3 conversations, 6–21 events. */
export const scenarioOf = (seed: number): readonly SimEvent[] => {
  const random = prng(seed);
  const conversations = 1 + Math.floor(random() * 3);
  const length = 6 + Math.floor(random() * 16);
  const started = new Set<number>();
  return Array.from({ length }, (): SimEvent => {
    const c = Math.floor(random() * conversations);
    const kind = started.has(c) ? pick(random) : "start";
    started.add(c);
    switch (kind) {
      case "intent":
        return { kind, c, status: STATUSES[Math.floor(random() * STATUSES.length)] ?? "implementing" };
      case "fault":
        return {
          kind,
          fault: FAULTS[Math.floor(random() * FAULTS.length)] ?? "records503",
          count: 1 + Math.floor(random() * 2),
          after: Math.floor(random() * 3),
        };
      case "crash":
        return { kind, at: 1 + Math.floor(random() * 8), when: random() < 0.5 ? "before" : "after" };
      default:
        return { kind, c };
    }
  });
};

export type Phase = "new" | "live" | "ended" | "abandoned";

/** What one execution of a scenario left behind, for the invariants. */
export interface Run {
  readonly trace: readonly string[];
  readonly captured: readonly Captured[];
  readonly drops: readonly DropCall[];
  readonly debts: readonly DebtWrite[];
  readonly deliveries: readonly Delivery[];
  /** Each conversation's phase BEFORE each step: `phaseAt(c, step)`. */
  readonly phaseAt: (conversation: number, step: number) => Phase;
  /** The conversation a life belongs to, by its host session key. */
  readonly conversationOf: (sessionId: string) => number | null;
  /** Steps whose flusher was an older connector: the one exception I6 grants (documented residual). */
  readonly oldFlushSteps: ReadonlySet<number>;
  /** The newest status set_intent wrote and the hub took, per work context. */
  readonly latestStatus: ReadonlyMap<string, string>;
  /** The status set_intent last left in the state, per work context — what every other sender reads. */
  readonly writtenStatus: ReadonlyMap<string, string>;
  /** Every drain's wall time against the deadline it had (I5). */
  readonly timings: readonly Timing[];
  /** Records a step may have counted twice: it died between a ledger append and the cursor write past it. */
  readonly overCountAllowance: number;
  /** Steps whose process died (a crash the scenario armed). */
  readonly crashedSteps: ReadonlySet<number>;
  readonly sixViolations: readonly string[];
  readonly quiescent: boolean;
  readonly ledgerTotal: number;
  readonly lives: ReadonlySet<string>;
}

export interface Timing {
  readonly step: number;
  readonly ms: number;
  readonly limitMs: number;
}

let runs = 0;

interface World {
  readonly hub: SimHub;
  readonly home: string;
  readonly repoRoot: string;
  readonly key: string;
  readonly ctx: HubContext;
  readonly keys: readonly string[];
  readonly phase: Phase[];
  readonly history: Phase[][];
  readonly latestStatus: Map<string, string>;
  readonly writtenStatus: Map<string, string>;
  readonly timings: Timing[];
  readonly six: string[];
  readonly oldFlushSteps: Set<number>;
  readonly crashedSteps: Set<number>;
  edits: number;
  overCount: number;
}

const producerOf = (world: World, sessionId: string): Producer => ({
  developerId: world.hub.developerId,
  agentKind: AGENT_KIND,
  sessionId,
});

const healerFor = (world: World, hostSessionKey: string) =>
  sessionHealer({
    home: world.home,
    repoKey: world.key,
    hub: world.ctx,
    agentKind: AGENT_KIND,
    hostSessionKey,
    repoId: REPO_ID,
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
    now: () => new Date(),
  });

/** Times a drain for I5, whatever it ends in. */
const timed = async (world: World, limitMs: number, run: () => Promise<unknown>): Promise<void> => {
  const started = Date.now();
  try {
    await run();
  } finally {
    world.timings.push({ step: world.hub.clock.step, ms: Date.now() - started, limitMs });
  }
};

/** A hook's drain, under the life the state names, with its healer. */
const hookFlush = async (world: World, hostSessionKey: string): Promise<void> => {
  const state = await readSessionState(world.home, hostSessionKey);
  if (state === null) {
    return;
  }
  const input = { sessionId: state.crosscheckSessionId, developerId: world.hub.developerId, heal: healerFor(world, hostSessionKey) };
  await timed(world, HOOK_LIMIT_MS, () => flushSpool(world.ctx, input, FLUSH_BUDGET_MS));
};

const register = (world: World, hostSessionKey: string) =>
  registerSessionFlow({
    home: world.home,
    repoKey: world.key,
    hub: world.ctx,
    agentKind: AGENT_KIND,
    hostSessionKey,
    repoId: REPO_ID,
    repoRoot: world.repoRoot,
    branch: BRANCH,
    baseCommit: BASE_COMMIT,
    hubUrl: world.ctx.hubUrl,
    fallbackDeveloperId: world.hub.developerId,
    title: fallbackWorkContextTitle(BRANCH, REPO_ID),
    status: "analyzing",
    now: new Date(),
    guarantees: guaranteeDeclarationFor(ACP_CONNECTOR),
  });

/** SessionStart: register (a resume walks the ladder), the drain with the healer, the maintenance reaps. */
const start = async (world: World, c: number): Promise<void> => {
  const hostSessionKey = world.keys[c] ?? "";
  await register(world, hostSessionKey);
  await hookFlush(world, hostSessionKey);
  await reapSpool(world.home, world.key, new Date(), async (crosscheckSessionId, seq) =>
    (await endSession(world.ctx, crosscheckSessionId, seq)).ok ? "ended" : "retry",
  );
  await reapStaleSessionStates(world.home, new Date(), { keepHostSessionKey: hostSessionKey });
};

/** One captured edit, positioned from the state's counter, then the hook's drain. */
const edit = async (world: World, c: number): Promise<void> => {
  const hostSessionKey = world.keys[c] ?? "";
  const state = await readSessionState(world.home, hostSessionKey);
  if (state === null) {
    return;
  }
  world.edits += 1;
  const seq = seqAt(await allocateSeq(world.home, hostSessionKey, 1), 0);
  const record = targetRecord(
    state.workContextId,
    "file",
    `src/sim/${hostSessionKey}-${String(world.edits)}.ts`,
    producerOf(world, state.crosscheckSessionId),
    new Date(),
  );
  await appendRecords(world.home, world.key, hostSessionKey, [withSeq(record, seq)], new Date());
  await hookFlush(world, hostSessionKey);
};

/** The status written to the state — read back after, so a write that landed before a crash still counts. */
const writeStatus = async (world: World, hostSessionKey: string, workContextId: string, status: string | null) => {
  try {
    await updateSessionState(world.home, hostSessionKey, (fresh) => ({ ...fresh, workContextStatus: status }));
  } finally {
    const state = await readSessionState(world.home, hostSessionKey);
    world.writtenStatus.set(workContextId, state?.workContextStatus ?? "");
  }
};

/**
 * set_intent's write, in the tool's order (mcp/tools/set-intent.ts): the new
 * status into the state, then straight to the hub; a post the hub did not
 * take puts the old one back, one it took settles the debt for it.
 */
const intent = async (world: World, c: number, status: string): Promise<void> => {
  const hostSessionKey = world.keys[c] ?? "";
  const state = await readSessionState(world.home, hostSessionKey);
  if (state === null) {
    return;
  }
  const isNew = status !== state.workContextStatus;
  if (isNew) {
    await writeStatus(world, hostSessionKey, state.workContextId, status);
  }
  const record = workContextRecord(
    {
      workContextId: state.workContextId,
      sessionId: state.crosscheckSessionId,
      title: state.workContextTitle ?? fallbackWorkContextTitle(BRANCH, REPO_ID),
      status,
    },
    producerOf(world, state.crosscheckSessionId),
    new Date(),
  );
  const posted = await postRecords(world.ctx, [withProducer(record, world.hub.developerId, state.crosscheckSessionId)]);
  if (!posted.ok) {
    // Every failure the simulation injects is an HTTP 5xx: it may have landed, so the state keeps the new status.
    return;
  }
  const answer = posted.data.results?.[0];
  if (answer?.status !== "accepted" && answer?.status !== "duplicate") {
    if (isNew) {
      await writeStatus(world, hostSessionKey, state.workContextId, state.workContextStatus);
    }
    if (answer?.status === "rejected" && rejectCauseOf(answer.issues) === "session_ended") {
      await recordRefusedLife(world.home, world.key, state.crosscheckSessionId, new Date());
    }
    return;
  }
  world.latestStatus.set(state.workContextId, status);
  await writeStatus(world, hostSessionKey, state.workContextId, status);
  await settleOwedOnIntent(world.home, world.key, hostSessionKey, state.workContextId);
};

const end = async (world: World, c: number): Promise<void> => {
  const hostSessionKey = world.keys[c] ?? "";
  const state = await readSessionState(world.home, hostSessionKey);
  if (state === null) {
    return;
  }
  const input = {
    home: world.home,
    repoKey: world.key,
    hub: world.ctx,
    hostSessionKey,
    crosscheckSessionId: state.crosscheckSessionId,
    developerId: world.hub.developerId,
    flushBudgetMs: FLUSH_BUDGET_MS,
    now: () => new Date(),
  };
  await timed(world, END_LIMIT_MS, () => endSessionFlow(input));
};

/** The conversation's state has said nothing for `silentMs`. */
const silence = async (world: World, c: number, silentMs: number): Promise<void> => {
  const hostSessionKey = world.keys[c] ?? "";
  const since = new Date(Date.now() - silentMs);
  const updated = await updateSessionState(world.home, hostSessionKey, (fresh) => ({
    ...fresh,
    startedAt: since.toISOString(),
    lastHeartbeatAt: since.toISOString(),
  }));
  if (updated) {
    await utimes(sessionStatePath(world.home, hostSessionKey), since, since);
  }
};

const causesOf = (results: readonly { readonly issues?: string[] | undefined }[]): Record<string, number> =>
  results.reduce<Record<string, number>>((counts, result) => {
    const cause = rejectCauseOf(result.issues);
    return { ...counts, [cause]: (counts[cause] ?? 0) + 1 };
  }, {});

/**
 * AN OLDER CONNECTOR'S FLUSH, as every release before round 7 shipped it:
 * every spool drained under its own life, no ownership, no debt, the hub's
 * refusals counted and the cursor moved past them (review p5-mixed).
 */
const oldFlush = async (world: World, c: number): Promise<void> => {
  const state = await readSessionState(world.home, world.keys[c] ?? "");
  if (state === null) {
    return;
  }
  for (const spool of await readAllSessionSpools(world.home, world.key)) {
    const batch = spool.lines.slice(0, MAX_INGEST_BATCH);
    if (batch.length === 0) {
      continue;
    }
    const records = batch.map((line) =>
      withProducer(JSON.parse(line) as Record<string, unknown>, world.hub.developerId, state.crosscheckSessionId),
    );
    const posted = await postRecords(world.ctx, records);
    if (!posted.ok) {
      return;
    }
    const refused = (posted.data.results ?? []).filter((result) => result.status === "rejected");
    await recordDrop(world.home, world.key, spool.slug, refused.length, "rejected", new Date(), {}, causesOf(refused));
    await writeCursorOffset(spool.dataPath, spool.cursorPath, spool.offset + bytesOfLines(spool.pending, batch.length), spool);
  }
};

/** Another process's SessionEnd reaches the hub — past the proxy, so no flusher here is told. */
const hubEnd = async (world: World, c: number): Promise<void> => {
  const state = await readSessionState(world.home, world.keys[c] ?? "");
  if (state !== null) {
    await endSession({ ...world.ctx, hubUrl: world.hub.directUrl }, state.crosscheckSessionId);
  }
};

const act = async (world: World, event: SimEvent, step: number): Promise<void> => {
  switch (event.kind) {
    case "start":
      return start(world, event.c);
    case "edit":
      return edit(world, event.c);
    case "flush":
      return hookFlush(world, world.keys[event.c] ?? "");
    case "intent":
      return intent(world, event.c, event.status);
    case "end":
      return end(world, event.c);
    case "hubEnd":
      return hubEnd(world, event.c);
    case "idle":
      return silence(world, event.c, IDLE_MS);
    case "abandon":
      world.phase[event.c] = "abandoned";
      return silence(world, event.c, ABANDONED_MS);
    case "oldFlush":
      world.oldFlushSteps.add(step);
      return oldFlush(world, event.c);
    case "refuseWc":
      world.hub.dials.wcRefusedFor.add(`cc_${world.keys[event.c] ?? ""}`);
      return;
    case "fault":
      world.hub.dials[event.fault] = { skip: event.after, count: event.count };
      return;
    case "crash":
      return;
  }
};

/** Whether the event can act on its conversation's phase; otherwise it is skipped. */
const applies = (world: World, event: SimEvent): boolean => {
  if (!("c" in event)) {
    return true;
  }
  const phase = world.phase[event.c] ?? "new";
  if (phase === "abandoned") {
    return false;
  }
  return event.kind === "start" || event.kind === "refuseWc" || phase === "live";
};

/** The phases as the disk has them: a state file is a live conversation, its absence one that ended. */
const syncPhases = async (world: World): Promise<void> => {
  for (const [c, phase] of world.phase.entries()) {
    if (phase === "abandoned") {
      continue;
    }
    const isLive = (await readSessionState(world.home, world.keys[c] ?? "")) !== null;
    world.phase[c] = isLive ? "live" : phase === "new" ? "new" : "ended";
  }
};

interface CursorMark {
  readonly offset: number;
  readonly drops: number;
}

/** I6's snapshot: every OTHER live conversation's cursor and drop count. */
const marksOfOthers = async (world: World, actor: number | null): Promise<ReadonlyMap<number, CursorMark>> => {
  const marks = new Map<number, CursorMark>();
  for (const [c, phase] of world.phase.entries()) {
    if (phase !== "live" || c === actor) {
      continue;
    }
    const slug = sessionSlug(world.keys[c] ?? "");
    const spool = await readSessionSpool(world.home, world.key, slug);
    const drops = scenarioLog()
      .drops.filter((drop) => drop.slug === slug)
      .reduce((sum, drop) => sum + drop.count, 0);
    marks.set(c, { offset: spool.offset, drops });
  }
  return marks;
};

const checkSix = async (world: World, before: ReadonlyMap<number, CursorMark>, step: number, label: string) => {
  const after = await marksOfOthers(world, null);
  for (const [c, mark] of before.entries()) {
    const now = after.get(c);
    if (now !== undefined && (now.offset !== mark.offset || now.drops !== mark.drops)) {
      world.six.push(
        `step ${String(step)} (${label}) spent conversation ${String(c)}'s records: cursor ${String(mark.offset)}→${String(now.offset)}, drops ${String(mark.drops)}→${String(now.drops)}`,
      );
    }
  }
};

export const describeEvent = (event: SimEvent): string => {
  switch (event.kind) {
    case "intent":
      return `intent c${String(event.c)} ${event.status}`;
    case "fault":
      return `fault ${event.fault}×${String(event.count)} after ${String(event.after)}`;
    case "crash":
      return `crash at write ${String(event.at)} ${event.when}`;
    default:
      return `${event.kind} c${String(event.c)}`;
  }
};

/** One step, with the crash armed before it; its outcome goes on the trace. */
const runStep = async (world: World, event: SimEvent, step: number, crash: Crash | null, trace: string[]) => {
  world.hub.clock.step = step;
  const actor = "c" in event ? event.c : null;
  const before = event.kind === "oldFlush" ? new Map<number, CursorMark>() : await marksOfOthers(world, actor);
  beginStep(step, crash);
  let outcome = "ok";
  try {
    await act(world, event, step);
  } catch (error) {
    if (!(error instanceof SimulatedCrash)) {
      throw error;
    }
  }
  const ended = endStep();
  if (ended.died) {
    outcome = "crashed";
    world.crashedSteps.add(step);
  }
  if (ended.mayOverCount) {
    world.overCount += scenarioLog()
      .drops.filter((drop) => drop.step === step)
      .reduce((sum, drop) => sum + drop.count, 0);
  }
  await syncPhases(world);
  await checkSix(world, before, step, describeEvent(event));
  const armed = crash === null ? "" : ` [dies ${crash.when} write ${String(crash.at)}]`;
  trace.push(`${String(step)}: ${describeEvent(event)}${armed} → ${outcome}`);
};

const openDebts = async (world: World): Promise<number> => {
  try {
    return (await readdir(spoolDir(world.home, world.key))).filter((name) => name.endsWith(DEBT_SUFFIX)).length;
  } catch {
    return 0;
  }
};

/** Whether every spool is empty and no work context is still owed. */
const isQuiescent = async (world: World): Promise<boolean> =>
  (await readAllSessionSpools(world.home, world.key)).every((spool) => spool.lines.length === 0) &&
  (await openDebts(world)) === 0;

/**
 * THE SCENARIO DRAINS: faults off, every live conversation ends, and a fresh
 * janitor conversation drains until nothing is left — or the scenario has
 * failed to settle (I5).
 */
const drainToQuiescence = async (world: World, trace: string[], firstStep: number): Promise<boolean> => {
  calmDials(world.hub);
  let step = firstStep;
  for (const [c, phase] of world.phase.entries()) {
    if (phase === "live") {
      await runStep(world, { kind: "end", c }, step, null, trace);
      step += 1;
    }
  }
  const janitor = world.keys.length - 1;
  await runStep(world, { kind: "start", c: janitor }, step, null, trace);
  for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
    if (await isQuiescent(world)) {
      return true;
    }
    step += 1;
    await runStep(world, { kind: "flush", c: janitor }, step, null, trace);
  }
  return isQuiescent(world);
};

const newWorld = async (hub: SimHub, events: readonly SimEvent[], repoRoot: string): Promise<World> => {
  runs += 1;
  const home = await makeHome(`sim-${String(runs)}`);
  const key = repoKey(hub.url, REPO_ID);
  const conversations = 1 + events.reduce((max, event) => ("c" in event ? Math.max(max, event.c) : max), 0);
  const keys = Array.from({ length: conversations + 1 }, (_, c) => `sim${String(runs)}-c${String(c)}`);
  return {
    hub,
    home,
    repoRoot,
    key,
    ctx: { hubUrl: hub.url, apiKey: hub.apiKey, timeoutMs: REQUEST_TIMEOUT_MS, home, repoKey: key, now: () => new Date() },
    keys,
    phase: keys.map((): Phase => "new"),
    history: keys.map(() => []),
    latestStatus: new Map(),
    writtenStatus: new Map(),
    timings: [],
    six: [],
    oldFlushSteps: new Set(),
    crashedSteps: new Set(),
    edits: 0,
    overCount: 0,
  };
};

const runOf = async (world: World, trace: readonly string[], quiescent: boolean): Promise<Run> => {
  const log = scenarioLog();
  const ledger = await readDropDetail(world.home, world.key);
  const lifeOwners = new Map(world.keys.map((hostSessionKey, c) => [`cc_${hostSessionKey}`, c]));
  return {
    trace,
    captured: log.captured,
    drops: log.drops,
    debts: log.debts,
    deliveries: [...world.hub.deliveries],
    phaseAt: (c, step) => {
      const history = world.history[c] ?? [];
      return history[Math.min(Math.max(step - 1, 0), history.length - 1)] ?? "new";
    },
    conversationOf: (sessionId) => {
      const tilde = sessionId.indexOf("~");
      return lifeOwners.get(tilde === -1 ? sessionId : sessionId.slice(0, tilde)) ?? null;
    },
    oldFlushSteps: world.oldFlushSteps,
    latestStatus: world.latestStatus,
    writtenStatus: world.writtenStatus,
    timings: world.timings,
    overCountAllowance: world.overCount,
    crashedSteps: world.crashedSteps,
    sixViolations: world.six,
    quiescent,
    ledgerTotal: ledger.summary.records,
    lives: new Set([...log.captured.map((captured) => captured.writer), ...world.hub.deliveries.map((delivery) => delivery.producer)]),
  };
};

/** Executes one scenario from scratch and returns what it left for the invariants. */
export const execute = async (hub: SimHub, events: readonly SimEvent[], repoRoot: string): Promise<Run> => {
  const world = await newWorld(hub, events, repoRoot);
  resetHub(hub);
  beginScenario(world.home);
  const trace: string[] = [];
  let crash: Crash | null = null;
  try {
    for (const [index, event] of events.entries()) {
      const step = index + 1;
      world.phase.forEach((phase, c) => world.history[c]?.push(phase));
      if (event.kind === "crash") {
        crash = { at: event.at, when: event.when };
        trace.push(`${String(step)}: ${describeEvent(event)} (armed)`);
      } else if (applies(world, event)) {
        // A crash kills a connector process; the world around it — the hub, a
        // sibling, a host going quiet — is no process of ours, and leaves it armed.
        const isActor = ACTOR_EVENTS.has(event.kind);
        await runStep(world, event, step, isActor ? crash : null, trace);
        crash = isActor ? null : crash;
      } else {
        trace.push(`${String(step)}: ${describeEvent(event)} (skipped)`);
      }
    }
    world.phase.forEach((phase, c) => world.history[c]?.push(phase));
    const quiescent = await drainToQuiescence(world, trace, events.length + 1);
    world.phase.forEach((phase, c) => world.history[c]?.push(phase));
    return await runOf(world, trace, quiescent);
  } finally {
    endScenario();
  }
};
