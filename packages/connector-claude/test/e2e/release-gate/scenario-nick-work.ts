/**
 * NICK'S SUBAGENT WORK in the long session (P1, and its twin N1): the same
 * 180 subagent touches, in one of two shapes (release-gate/profile.ts).
 *
 * SEQUENTIAL (the generous variant): four subagents one after another — the
 * mapping port (the eight shared files, the hits), then the bulk, the new
 * modules with the three Bash-only mapping files, and the fixtures.
 *
 * PARALLEL (production): ONE TURN FANS OUT TWELVE WORKERS, as a turn that
 * launches several Task calls at once does.
 *  - Ten foreground workers start together; six of them edit one shared file
 *    each halfway through their work, so six tripwire hits race each other,
 *    the PostToolUse captures in flight and the other workers' edits. Each returns
 *    (SubagentStop, then the main thread's `subagent-return` — the RELAY)
 *    once the presence cache has gone stale, as a real subagent that runs
 *    for minutes does, so a relay cannot lean on a presence answer fetched
 *    just before; their returns race the workers still running.
 *  - Two BACKGROUND workers outlive the turn. `mapping-late` edits a shared
 *    file the moment the turn ends (racing `turn-end`) and another the moment
 *    the person prompts (racing `user-prompt-submit`). `codegen` writes the
 *    six Bash-only files after the turn's lanes have run.
 *  - With `compacts`, the conversation COMPACTS before the next Stop: the
 *    person's next prompt meets a full context. The codegen worker's Bash
 *    files land between the turn's last lane and the compaction — the order
 *    the review's H1 names — and every lane after it (codegen's SubagentStop,
 *    the turn's Stop) is the one that must still file them.
 */
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PRESENCE_CACHE_TTL_MS } from "@crosscheck/connector-core/constants.ts";

import type { Actor, HookRun, HostSession } from "./host.ts";
import type { LongSessionFiles, LongSessionPlan } from "./scenario-long-session.ts";

/** How far past the presence cache's freshness a subagent runs before it returns. */
const SUBAGENT_OVERRUN_MS = 1_500;
/** Foreground workers of the fan-out; two background workers come on top. */
const FOREGROUND_WORKERS = 10;
const BACKGROUND_WORKERS = 2;
/** Of the eight shared files Nick edits, how many go to the foreground workers (the first ones, in order). */
export const FOREGROUND_HITS = 6;
/** The foreground workers that write the four `.env` files (two each). */
const ENV_WORKERS = [6, 7] as const;
/**
 * Between the last Bash write and the compaction: a file system's mtime may be
 * as coarse as one second (HFS+), and the git lane compares mtimes against the
 * window's start. Compaction itself takes seconds, so this costs no realism.
 */
const MTIME_MARGIN_MS = 1_100;

export const sourceOf = (path: string): string => `// ${path}\nexport const value = ${String(path.length)};\n`;

export const edited = (path: string, who: string, phase: string): string => `${sourceOf(path)}// ${who}: ${phase}\n`;

export const editAll = async (
  session: HostSession,
  root: string,
  paths: readonly string[],
  actor: Actor,
  phase: string,
): Promise<void> => {
  for (const path of paths) {
    await session.edit(join(root, path), edited(path, "nick", phase), actor);
  }
};

interface BashContext {
  readonly session: HostSession;
  readonly topic: string;
  readonly scratch: string;
  readonly actor: Actor;
}

/** What a `mv` from outside the repo leaves: a file that no edit tool reported. */
const moveInto = async (context: BashContext, target: string, content: string): Promise<void> => {
  const staged = join(context.scratch, target.replaceAll("/", "_"));
  await writeFile(staged, content, "utf8");
  await mkdir(dirname(join(context.topic, target)), { recursive: true });
  await rename(staged, join(context.topic, target));
};

/** Three of the mapping files, by `cp` over a tracked file, a `>` redirect, and an `mv` into a new one. */
const bashMapping = async (context: BashContext, files: LongSessionFiles, plan: LongSessionPlan): Promise<void> => {
  const at = (path: string): string => join(context.topic, path);
  const [viaCp, viaRedirect, viaMove] = files.nickMappingByBash;
  const template = `${plan.nickMappingDir}/templates/grid.template.tsx`;
  const options = { cwd: context.topic, actor: context.actor };
  await context.session.bash(`cp ${template} ${viaCp ?? ""}`, async () => copyFile(at(template), at(viaCp ?? "")), options);
  await context.session.bash(
    `bun run gen:mapping-config > ${viaRedirect ?? ""}`,
    async () => writeFile(at(viaRedirect ?? ""), edited(viaRedirect ?? "", "nick", "redirect"), "utf8"),
    options,
  );
  await context.session.bash(
    `mv /tmp/numlabs-columns.ts ${viaMove ?? ""}`,
    async () => moveInto(context, viaMove ?? "", edited(viaMove ?? "", "nick", "moved")),
    options,
  );
};

/** The three other Bash-only files, all new to the worktree. */
const bashOthers = async (context: BashContext, files: LongSessionFiles): Promise<void> => {
  const at = (path: string): string => join(context.topic, path);
  const [readme, fixture, ids] = files.nickBashOnlyOthers;
  const options = { cwd: context.topic, actor: context.actor };
  await context.session.bash(
    `cp docs/templates/README.template.md ${readme ?? ""}`,
    async () => copyFile(at("docs/templates/README.template.md"), at(readme ?? "")),
    options,
  );
  await context.session.bash(
    `bun run fixtures:session > ${fixture ?? ""}`,
    async () => {
      await mkdir(dirname(at(fixture ?? "")), { recursive: true });
      await writeFile(at(fixture ?? ""), '{"session": "practice"}\n', "utf8");
    },
    options,
  );
  await context.session.bash(
    `mv /tmp/ids.ts ${ids ?? ""}`,
    async () => moveInto(context, ids ?? "", edited(ids ?? "", "nick", "moved")),
    options,
  );
};

export interface NickWork {
  readonly session: HostSession;
  readonly topic: string;
  readonly scratch: string;
  readonly files: LongSessionFiles;
  readonly plan: LongSessionPlan;
  /** The token every `.env` file carries. */
  readonly secret: string;
}

export interface NickMoments {
  /** Every run of the subagent work's phase — its PreToolUse runs carrying `agent_id` are the hits. */
  readonly nickSubagentHits: readonly HookRun[];
  /**
   * The main thread's RELAY channels from the subagents' returns to the
   * person's next prompt — `subagent-return`, `turn-end`, `user-prompt-submit`
   * — where a hit only a subagent saw must reach the person. A SessionStart
   * (the compaction's re-briefing) is not one of them.
   */
  readonly nickReturnAndPrompt: readonly HookRun[];
  readonly nickStatusline: string;
  /**
   * Parallel only: the statusline right after the turn ended, before any
   * re-briefing — what the person's record holds of the foreground hits.
   */
  readonly nickStatuslineAtTurnEnd: string | null;
}

const writeEnvFiles = async (work: NickWork, actor: Actor, which: readonly number[]): Promise<void> => {
  const envOf = (index: number): string => join(work.topic, work.files.nickEnvFiles[index] ?? "");
  const lines = [
    `NUMLABS_API_TOKEN=${work.secret}\n`,
    `NUMLABS_API_TOKEN=${work.secret}\nDEBUG=1\n`,
    `PRACTICE_FEED_KEY=${work.secret}\n`,
    `API_TEST_TOKEN=${work.secret}\n`,
  ];
  for (const index of which) {
    await work.session.edit(envOf(index), lines[index] ?? "", actor);
  }
};

/** The generous variant's order: one subagent at a time. */
export const nickWorksSequentially = async (work: NickWork): Promise<NickMoments> => {
  const { session, topic, files } = work;
  // A subagent edits the eight shared files Mike just worked on — the hits.
  // It runs longer than the presence cache stays fresh, as a real subagent
  // does (minutes), with no statusline render in between (an IDE session has
  // none): whatever the main thread is told at its return cannot lean on a
  // presence answer fetched just before.
  session.label("nick-subagent-mapping");
  const returned = await session.subagent("mapping-port", async (actor) => {
    await editAll(session, topic, files.nickMappingByEdit, actor, "mapping port");
    await editAll(session, topic, files.nickModulesEdited.slice(0, 40), actor, "mapping port");
    await Bun.sleep(PRESENCE_CACHE_TTL_MS + SUBAGENT_OVERRUN_MS);
  });
  const nickSubagentHits = session.runs().filter((run) => run.label === "nick-subagent-mapping");
  session.label("nick-next-prompt");
  const prompted = await session.prompt("looks good, now the practices sync");
  const nickStatusline = await session.statusline();

  session.label("nick-subagents-bulk");
  await session.subagent("numlabs-core", async (actor) => {
    await editAll(session, topic, files.nickModulesEdited.slice(40), actor, "core");
    await writeEnvFiles(work, actor, [0, 1]);
  });
  await session.subagent("numlabs-new", async (actor) => {
    await editAll(session, topic, files.nickModulesWritten.slice(0, 60), actor, "new modules");
    await writeEnvFiles(work, actor, [2, 3]);
    await bashMapping({ session, topic, scratch: work.scratch, actor }, files, work.plan);
  });
  await session.subagent("fixtures", async (actor) => {
    await bashOthers({ session, topic, scratch: work.scratch, actor }, files);
  });
  return { nickSubagentHits, nickReturnAndPrompt: [...returned, ...prompted], nickStatusline, nickStatuslineAtTurnEnd: null };
};

/** `items` dealt round-robin into `hands` lists. */
const deal = <T>(items: readonly T[], hands: number): readonly (readonly T[])[] =>
  Array.from({ length: hands }, (_, hand) => items.filter((_, index) => index % hands === hand));

const sleepUntil = async (deadline: number): Promise<void> => {
  const remaining = deadline - performance.now();
  if (remaining > 0) {
    await Bun.sleep(remaining);
  }
};

/** The production variant's order (module header): twelve workers at once, the turn ending under them. */
export const nickWorksInParallel = async (work: NickWork, compacts: boolean): Promise<NickMoments> => {
  const { session, topic, files } = work;
  const lanes = deal([...files.nickModulesEdited, ...files.nickModulesWritten.slice(0, 60)], FOREGROUND_WORKERS + BACKGROUND_WORKERS);
  const [atTurnEnd = "", atPrompt = ""] = files.nickMappingByEdit.slice(FOREGROUND_HITS);
  const turnEnded = Promise.withResolvers<void>();
  const prompting = Promise.withResolvers<void>();
  const bashMayRun = Promise.withResolvers<void>();
  const bashDone = Promise.withResolvers<void>();
  const returnsAfter = performance.now() + PRESENCE_CACHE_TTL_MS + SUBAGENT_OVERRUN_MS;
  const bashContext = (actor: Actor): BashContext => ({ session, topic, scratch: work.scratch, actor });

  session.label("nick-fan-out");
  await session.prompt("fan the mapping port and the NumLabs core out over twelve workers");
  const codegen = session.backgroundSubagent("codegen", async (actor) => {
    await editAll(session, topic, lanes[FOREGROUND_WORKERS] ?? [], actor, "codegen");
    await bashMayRun.promise;
    await bashMapping(bashContext(actor), files, work.plan);
    await bashOthers(bashContext(actor), files);
    bashDone.resolve();
    await prompting.promise;
  });
  const late = session.backgroundSubagent("mapping-late", async (actor) => {
    await editAll(session, topic, lanes[FOREGROUND_WORKERS + 1] ?? [], actor, "mapping late");
    await turnEnded.promise;
    await editAll(session, topic, [atTurnEnd], actor, "mapping port");
    await prompting.promise;
    await editAll(session, topic, [atPrompt], actor, "mapping port");
  });
  const foreground = Array.from({ length: FOREGROUND_WORKERS }, async (_, worker) =>
    session.subagent(`worker-${String(worker)}`, async (actor) => {
      const own = lanes[worker] ?? [];
      const half = Math.ceil(own.length / 2);
      // The shared file comes MID-RUN, as in a real worker: every other
      // worker's edits and their captures are in flight around the hit.
      await editAll(session, topic, own.slice(0, half), actor, "numlabs");
      const hit = worker < FOREGROUND_HITS ? files.nickMappingByEdit[worker] : undefined;
      if (hit !== undefined) {
        await editAll(session, topic, [hit], actor, "mapping port");
      }
      const envPair = ENV_WORKERS.indexOf(worker as (typeof ENV_WORKERS)[number]);
      if (envPair !== -1) {
        await writeEnvFiles(work, actor, [2 * envPair, 2 * envPair + 1]);
      }
      await editAll(session, topic, own.slice(half), actor, "numlabs");
      await sleepUntil(returnsAfter);
    }),
  );
  await Promise.all(foreground);

  // The turn ends while both background workers run: turn-end races the late worker's edit.
  turnEnded.resolve();
  await session.stop();
  const nickStatuslineAtTurnEnd = await session.statusline();
  if (compacts) {
    // Every lane of the turn has run before the codegen worker's Bash work lands.
    await session.settle();
  }
  bashMayRun.resolve();
  await bashDone.promise;
  if (compacts) {
    await Bun.sleep(MTIME_MARGIN_MS);
    await session.start("compact");
  }
  // The person's next prompt races the late worker's second edit.
  prompting.resolve();
  await session.prompt("looks good, now the practices sync");
  await Promise.all([codegen.launched, codegen.finished, late.launched, late.finished]);
  // What the background workers ran into is relayed here at the latest.
  await session.prompt("continue");
  const nickStatusline = await session.statusline();
  const fanOut = session.runs().filter((run) => run.label === "nick-fan-out");
  return {
    nickSubagentHits: fanOut.filter((run) => run.agentId !== null),
    nickReturnAndPrompt: fanOut.filter((run) => run.agentId === null && run.event !== "SessionStart"),
    nickStatusline,
    nickStatuslineAtTurnEnd,
  };
};
