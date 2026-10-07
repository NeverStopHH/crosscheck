/**
 * THE PILOT SHAPE, at pilot scale (P1), and its no-overlap twin (N1).
 *
 * Mike works the ordinary way: one worktree on `feat/streaming-practice-beta`,
 * one session over two "days" (a startup and a resume), 25 files, 11 of them
 * under the mapping directory, committed. Nick works the way the pilot owner
 * does: ONE long session started in `agentic-main`, a worktree DETACHED at an
 * old main commit that an old branch still points at (so the session's title
 * is that stale branch), and every topic done from there — here NumLabs, in a
 * sibling worktree on `feat/numlabs-practices`. 190 files: 172 through
 * SUBAGENTS (PreToolUse/PostToolUse carrying `agent_id`), 12 on the main
 * thread, 6 only through Bash (`cp`, a `>` redirect, `mv`), 4 of them `.env`
 * files whose content carries a marker that must never leave the machine.
 * Tina is the third developer: her PR lands on main, which then contains
 * Nick's base commit, and her next SessionStart reports it — the report that
 * once stamped the pilot owner's context landed.
 *
 * P1 puts Mike's 11 mapping files in Nick's mapping directory too (3 of them
 * Nick changes only by Bash); N1 moves Nick's to a different area, so the two
 * share NOTHING at the same scale.
 *
 * Day phases are ORDER, not time: the connector's clock has no seam
 * (hooks/runner.ts), and moving only the hub's would exercise clock skew and
 * the six-hour reaper rather than the pilot. Presence is real: each phase
 * that needs a teammate's live heartbeat runs right after that teammate
 * worked, as it did when both were at their desks.
 */
import { copyFile, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { renderRepoConfig } from "@crosscheck/connector-core/config/repo-config.ts";
import { PRESENCE_CACHE_TTL_MS } from "@crosscheck/connector-core/constants.ts";

import { MIKE, NICK } from "../../../../connector-core/test/fixtures/landing-repos.ts";
import {
  SEED_AUTHOR,
  addDetachedWorktree,
  addWorktree,
  cloneFor,
  commitAll,
  daysAgo,
  fetchMain,
  gitIn,
  landOnMain,
  makeSeed,
  writeTree,
} from "./git.ts";
import type { Person } from "./git.ts";
import { MAIN_THREAD, openSession } from "./host.ts";
import type { Actor, HookRun, HostSession } from "./host.ts";
import type { TestHub } from "./hub.ts";
import { makeDeveloper } from "./team.ts";
import type { GateDeveloper } from "./team.ts";

export const TINA: Person = { name: "Tina", email: "tina@example.com" };

export const STALE_BRANCH = "feat/scouting-feed-old";
export const TOPIC_BRANCH = "feat/numlabs-practices";
export const MIKE_BRANCH = "feat/streaming-practice-beta";
const TINA_BRANCH = "feat/billing-export";
const TINA_NEXT_BRANCH = "feat/billing-followup";

export interface LongSessionPlan {
  readonly label: string;
  readonly repoId: string;
  readonly remoteUrl: string;
  /** Mike's mapping directory, repo-relative. */
  readonly mikeMappingDir: string;
  /** Nick's: the SAME directory for P1, another area for N1. */
  readonly nickMappingDir: string;
}

const MAPPING_NAMES = [
  "PlayerMappingGrid.tsx",
  "mappingConfig.ts",
  "columns.ts",
  "MappingToolbar.tsx",
  "useMappingState.ts",
  "mappingSchema.ts",
  "MappingRow.tsx",
  "mappingApi.ts",
  "mappingFilters.ts",
  "MappingLegend.tsx",
  "index.ts",
] as const;

/** The three mapping files Nick changes ONLY through Bash: positions 0..2 of MAPPING_NAMES. */
const BASH_MAPPING_COUNT = 3;
/** Mike creates this one; it is in nobody's seed. */
const NEW_MAPPING_FILE = "columns.ts";

/** How far past the presence cache's freshness the mapping subagent runs. */
const SUBAGENT_OVERRUN_MS = 1_500;

const range = (count: number, from = 1): readonly number[] => Array.from({ length: count }, (_, index) => index + from);
const pad = (value: number): string => String(value).padStart(3, "0");

export interface LongSessionFiles {
  /** Mike's 11 mapping files and Nick's 11 — identical lists in P1. */
  readonly mikeMapping: readonly string[];
  readonly nickMapping: readonly string[];
  /** Nick's mapping files he changes only by Bash (3), and the rest (8). */
  readonly nickMappingByBash: readonly string[];
  readonly nickMappingByEdit: readonly string[];
  readonly mikeOthers: readonly string[];
  readonly nickDocs: readonly string[];
  readonly nickModulesEdited: readonly string[];
  readonly nickModulesWritten: readonly string[];
  readonly nickBashOnlyOthers: readonly string[];
  readonly nickEnvFiles: readonly string[];
  /** Every repo-relative path Nick touched: 190. */
  readonly nickAll: readonly string[];
  readonly mikeAll: readonly string[];
}

const planFiles = (plan: LongSessionPlan): LongSessionFiles => {
  const mikeMapping = MAPPING_NAMES.map((name) => `${plan.mikeMappingDir}/${name}`);
  const nickMapping = MAPPING_NAMES.map((name) => `${plan.nickMappingDir}/${name}`);
  const nickDocs = range(4).map((index) => `docs/notes/numlabs-${String(index)}.md`);
  const nickModulesEdited = range(100).map((index) => `apps/numlabs/src/module${pad(index)}.ts`);
  const nickModulesWritten = range(68, 101).map((index) => `apps/numlabs/src/module${pad(index)}.ts`);
  const nickBashOnlyOthers = ["apps/numlabs/README.md", "apps/numlabs/fixtures/session.json", "apps/numlabs/src/ids.ts"];
  const nickEnvFiles = ["apps/numlabs/.env", "apps/numlabs/.env.local", "apps/practice/.env.development", "packages/api/.env.test"];
  return {
    mikeMapping,
    nickMapping,
    nickMappingByBash: nickMapping.slice(0, BASH_MAPPING_COUNT),
    nickMappingByEdit: nickMapping.slice(BASH_MAPPING_COUNT),
    mikeOthers: range(14).map((index) => `apps/practice/streaming/stream${pad(index)}.ts`),
    nickDocs,
    nickModulesEdited,
    nickModulesWritten,
    nickBashOnlyOthers,
    nickEnvFiles,
    nickAll: [
      ...nickDocs,
      ...nickMapping,
      ...nickModulesEdited,
      ...nickModulesWritten,
      ...nickBashOnlyOthers,
      ...nickEnvFiles,
    ],
    mikeAll: [...mikeMapping, ...range(14).map((index) => `apps/practice/streaming/stream${pad(index)}.ts`)],
  };
};

const sourceOf = (path: string): string => `// ${path}\nexport const value = ${String(path.length)};\n`;

/**
 * The tracked tree. `.crosscheck.json` is what `crosscheck init` commits, and
 * it is load-bearing: capture follows an edit into a sibling worktree only
 * when that worktree's root carries the committed config (the trust rule,
 * config/connected-repo.ts) — without it every NumLabs edit is an
 * outside-root drop.
 */
const seedFiles = (plan: LongSessionPlan, files: LongSessionFiles, hubUrl: string): Record<string, string> => {
  const existingMapping = [...new Set([...files.mikeMapping, ...files.nickMapping])].filter(
    (path) => !path.endsWith(`/${NEW_MAPPING_FILE}`),
  );
  const tracked = [
    "README.md",
    "docs/CHANGELOG.md",
    "docs/templates/README.template.md",
    `${plan.nickMappingDir}/templates/grid.template.tsx`,
    "apps/billing/export.ts",
    ...existingMapping,
    ...files.mikeOthers,
    ...files.nickDocs,
    ...files.nickModulesEdited,
  ];
  return { ...Object.fromEntries(tracked.map((path) => [path, sourceOf(path)])), ".crosscheck.json": renderRepoConfig(hubUrl) };
};

export interface LongSessionWorld {
  readonly plan: LongSessionPlan;
  readonly files: LongSessionFiles;
  readonly mike: GateDeveloper;
  readonly nick: GateDeveloper;
  readonly tina: GateDeveloper;
  readonly mikeSession: HostSession;
  readonly nickSession: HostSession;
  readonly tinaSession: HostSession;
  readonly commits: { readonly staleBase: string; readonly branchPoint: string; readonly tinaLanding: string };
  readonly roots: {
    readonly seed: string;
    readonly mikeWorktree: string;
    readonly nickStart: string;
    readonly nickTopic: string;
    readonly tinaClone: string;
  };
  /** The token every `.env` file carries — it must appear nowhere but in those files. */
  readonly secret: string;
  /** Hook runs at the moments the assertions read. */
  readonly moments: {
    readonly nickSubagentHits: readonly HookRun[];
    readonly nickReturnAndPrompt: readonly HookRun[];
    readonly nickStatusline: string;
    readonly mikeNext: readonly HookRun[];
    readonly mikeStatusline: string;
  };
  /** Every directory a test may delete afterwards. */
  readonly cleanup: readonly string[];
}

const edited = (path: string, who: string, phase: string): string => `${sourceOf(path)}// ${who}: ${phase}\n`;

interface Seeded {
  readonly seed: string;
  readonly staleBase: string;
  readonly branchPoint: string;
}

/** C0 (60 days ago), C1 (40, where STALE_BRANCH points), C2 (20, main's tip) — all too old to be "recent". */
const seedHistory = async (plan: LongSessionPlan, files: LongSessionFiles, hubUrl: string): Promise<Seeded> => {
  const { root } = await makeSeed(plan.label, seedFiles(plan, files, hubUrl), daysAgo(60));
  await writeTree(root, { "docs/CHANGELOG.md": "# changelog\n- scouting feed\n" });
  const staleBase = await commitAll(root, "scouting feed: old preview", SEED_AUTHOR, daysAgo(40));
  await writeTree(root, { "docs/CHANGELOG.md": "# changelog\n- scouting feed\n- practice hub\n" });
  const branchPoint = await commitAll(root, "practice hub", SEED_AUTHOR, daysAgo(20));
  return { seed: root, staleBase, branchPoint };
};

const mikeDay = async (session: HostSession, worktree: string, day: number, paths: readonly string[]): Promise<void> => {
  const phase = `day ${String(day)}`;
  session.label(`mike-day-${String(day)}`);
  await session.start(day === 1 ? "startup" : "resume");
  await session.prompt(`streaming practice beta, ${phase}: wire the player mapping grid to the live feed`);
  for (const path of paths) {
    await session.edit(join(worktree, path), edited(path, "mike", phase));
  }
  await session.bash(
    `git add -A && git commit -m "streaming beta: mapping ${phase}"`,
    async () => {
      await commitAll(worktree, `streaming beta: mapping ${phase}`, MIKE, daysAgo(3 - day));
    },
    { cwd: worktree },
  );
  await session.stop();
};

const editAll = async (
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

const secretToken = (): string => `nl_live_${crypto.randomUUID().replaceAll("-", "")}`;

interface Cast {
  readonly mike: GateDeveloper;
  readonly nick: GateDeveloper;
  readonly tina: GateDeveloper;
}

interface Checkouts {
  readonly mikeClone: string;
  readonly mikeWorktree: string;
  readonly nickClone: string;
  readonly nickStart: string;
  readonly nickTopic: string;
  readonly tinaClone: string;
}

const checkOut = async (plan: LongSessionPlan, seed: string, staleBase: string): Promise<Checkouts> => {
  const mikeClone = await cloneFor(seed, `${plan.label}-mike`, plan.remoteUrl, MIKE);
  const mikeWorktree = await addWorktree(mikeClone, join(dirname(mikeClone), "streaming"), MIKE_BRANCH, "origin/main");
  const nickClone = await cloneFor(seed, `${plan.label}-nick`, plan.remoteUrl, NICK);
  // The stale branch still points at the old commit the long-lived worktree sits on.
  await gitIn(nickClone, ["branch", STALE_BRANCH, staleBase]);
  const nickStart = await addDetachedWorktree(nickClone, join(dirname(nickClone), "agentic-main"), staleBase);
  const tinaClone = await cloneFor(seed, `${plan.label}-tina`, plan.remoteUrl, TINA);
  return { mikeClone, mikeWorktree, nickClone, nickStart, nickTopic: join(dirname(nickClone), "numlabs"), tinaClone };
};

/** Tina's PR lands on main (which then contains Nick's base); her next session reports what landed. */
const tinaLands = async (session: HostSession, seed: string, clone: string): Promise<string> => {
  session.label("tina-report");
  await gitIn(clone, ["checkout", "-q", "-b", TINA_BRANCH, "origin/main"]);
  await writeTree(clone, { "apps/billing/export.ts": "export const exportCsv = true;\n" });
  await commitAll(clone, "billing: csv export", TINA, daysAgo(1));
  const landing = await landOnMain(seed, clone, TINA_BRANCH, "Merge pull request #412 from acme/feat/billing-export", TINA, daysAgo(0.5));
  await fetchMain(clone, seed);
  await gitIn(clone, ["checkout", "-q", "-b", TINA_NEXT_BRANCH, "origin/main"]);
  await session.start("startup");
  await session.prompt("billing follow-up: export the practice invoices");
  await session.stop();
  return landing;
};

export const runLongSessionCase = async (hub: TestHub, plan: LongSessionPlan): Promise<LongSessionWorld> => {
  const files = planFiles(plan);
  const secret = secretToken();
  const { seed, staleBase, branchPoint } = await seedHistory(plan, files, hub.url);
  const cast: Cast = {
    mike: await makeDeveloper(hub, MIKE, `${plan.label}-mike`),
    nick: await makeDeveloper(hub, NICK, `${plan.label}-nick`),
    tina: await makeDeveloper(hub, TINA, `${plan.label}-tina`),
  };
  const scratch = await mkdtemp(join(tmpdir(), `cx-gate-${plan.label}-bash-`));
  const at = await checkOut(plan, seed, staleBase);
  const mikeSession = openSession(cast.mike, `${plan.label}-mike-streaming`, at.mikeWorktree);
  const nickSession = openSession(cast.nick, `${plan.label}-nick-long-session`, at.nickStart);
  const tinaSession = openSession(cast.tina, `${plan.label}-tina-followup`, at.tinaClone);

  // Day 1 (03.10): Mike alone — six mapping files (the three Nick will later
  // change by Bash among them) and nine others.
  await mikeDay(mikeSession, at.mikeWorktree, 1, [...files.mikeMapping.slice(0, 6), ...files.mikeOthers.slice(0, 9)]);

  // 05.10: Nick's long session opens in the detached start checkout.
  nickSession.label("nick-start");
  await nickSession.start("startup");
  await nickSession.prompt("NumLabs: port the practice mapping import onto the practices API");
  await editAll(nickSession, at.nickStart, files.nickDocs, MAIN_THREAD, "notes");
  await nickSession.bash(
    `git worktree add -b ${TOPIC_BRANCH} ../numlabs origin/main`,
    async () => {
      await addWorktree(at.nickClone, at.nickTopic, TOPIC_BRANCH, "origin/main");
    },
    { cwd: at.nickStart },
  );
  await nickSession.stop();

  // Day 2: Mike's other five mapping files and five more, while Nick's session is open.
  await mikeDay(mikeSession, at.mikeWorktree, 2, [...files.mikeMapping.slice(6), ...files.mikeOthers.slice(9)]);

  // A subagent edits the eight shared files Mike just worked on — the hits.
  // It runs longer than the presence cache stays fresh, as a real subagent
  // does (minutes), with no statusline render in between (an IDE session has
  // none): whatever the main thread is told at its return cannot lean on a
  // presence answer fetched just before. Deterministic either side of the
  // window rather than racing it.
  nickSession.label("nick-subagent-mapping");
  const returned = await nickSession.subagent("mapping-port", async (actor) => {
    await editAll(nickSession, at.nickTopic, files.nickMappingByEdit, actor, "mapping port");
    await editAll(nickSession, at.nickTopic, files.nickModulesEdited.slice(0, 40), actor, "mapping port");
    await Bun.sleep(PRESENCE_CACHE_TTL_MS + SUBAGENT_OVERRUN_MS);
  });
  const nickSubagentHits = nickSession.runs().filter((run) => run.label === "nick-subagent-mapping");
  nickSession.label("nick-next-prompt");
  const prompted = await nickSession.prompt("looks good, now the practices sync");
  const nickStatusline = await nickSession.statusline();

  nickSession.label("nick-subagents-bulk");
  const env = files.nickEnvFiles.map((path) => join(at.nickTopic, path));
  await nickSession.subagent("numlabs-core", async (actor) => {
    await editAll(nickSession, at.nickTopic, files.nickModulesEdited.slice(40), actor, "core");
    await nickSession.edit(env[0] ?? "", `NUMLABS_API_TOKEN=${secret}\n`, actor);
    await nickSession.edit(env[1] ?? "", `NUMLABS_API_TOKEN=${secret}\nDEBUG=1\n`, actor);
  });
  await nickSession.subagent("numlabs-new", async (actor) => {
    await editAll(nickSession, at.nickTopic, files.nickModulesWritten.slice(0, 60), actor, "new modules");
    await nickSession.edit(env[2] ?? "", `PRACTICE_FEED_KEY=${secret}\n`, actor);
    await nickSession.edit(env[3] ?? "", `API_TEST_TOKEN=${secret}\n`, actor);
    await bashMapping({ session: nickSession, topic: at.nickTopic, scratch, actor }, files, plan);
  });
  await nickSession.subagent("fixtures", async (actor) => {
    await bashOthers({ session: nickSession, topic: at.nickTopic, scratch, actor }, files);
  });

  const tinaLanding = await tinaLands(tinaSession, seed, at.tinaClone);
  await fetchMain(at.mikeClone, seed);
  await fetchMain(at.nickClone, seed);

  // Nick's main thread finishes the turn — the last of his 190 files.
  nickSession.label("nick-main-finish");
  await editAll(nickSession, at.nickTopic, files.nickModulesWritten.slice(60), MAIN_THREAD, "finish");
  await nickSession.stop();

  // The next morning (06.10): Mike resumes, prompts, edits two shared files —
  // one Nick's subagent edited, one Nick changed only through Bash.
  mikeSession.label("mike-next");
  await mikeSession.start("resume");
  await mikeSession.prompt("next: the mapping schema for the beta feed");
  for (const name of ["mappingSchema.ts", "PlayerMappingGrid.tsx"]) {
    const path = `${plan.mikeMappingDir}/${name}`;
    await mikeSession.edit(join(at.mikeWorktree, path), edited(path, "mike", "next morning"));
  }
  const mikeNext = mikeSession.runs().filter((run) => run.label === "mike-next");
  const mikeStatusline = await mikeSession.statusline();

  return {
    plan,
    files,
    ...cast,
    mikeSession,
    nickSession,
    tinaSession,
    commits: { staleBase, branchPoint, tinaLanding },
    roots: { seed, mikeWorktree: at.mikeWorktree, nickStart: at.nickStart, nickTopic: at.nickTopic, tinaClone: at.tinaClone },
    secret,
    moments: { nickSubagentHits, nickReturnAndPrompt: [...returned, ...prompted], nickStatusline, mikeNext, mikeStatusline },
    cleanup: [
      seed,
      dirname(at.mikeClone),
      dirname(at.nickClone),
      dirname(at.tinaClone),
      scratch,
      cast.mike.home,
      cast.nick.home,
      cast.tina.home,
    ],
  };
};
