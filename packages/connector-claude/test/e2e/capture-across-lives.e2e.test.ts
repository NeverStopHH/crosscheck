/**
 * THE PILOT COLLISION ACROSS A RESUME AND A COMPACT (integration review of
 * batch 2, H1) — the review's own sequences, on the release gate's harness:
 * real hooks under the real settings plan, the real hub over PGlite on a
 * random loopback port, real git repos and worktrees.
 *
 * RESUME. Mike edits the shared mapping files. Nick's one long session works
 * in a sibling worktree through a subagent: 2 shared files edited and left
 * dirty, 2 edited and committed, 2 created only by Bash. Then SessionEnd
 * (a VS Code reload, `claude --resume`) and a resume, a subagent's work, a
 * Stop — and Mike edits. Before the fix the resume reset the git lane's
 * window and forgot the sibling: 0 of the 6 were visible to Mike's tripwire
 * after the resume, and 4 never again, with nothing counted.
 *
 * COMPACT. An Edit and a Bash-only write in a sibling worktree, then a compact
 * before the turn's Stop: before the fix the Stop lane filed the Edit's file
 * only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MIKE, NICK } from "../../../connector-core/test/fixtures/landing-repos.ts";
import { checkoutFor, editEach, fileSource, seedCase } from "./release-gate/case-kit.ts";
import { addDetachedWorktree, addWorktree, cloneFor, commitAll, gitIn } from "./release-gate/git.ts";
import { agentTexts, openSession } from "./release-gate/host.ts";
import type { Actor } from "./release-gate/host.ts";
import { startHub } from "./release-gate/hub.ts";
import type { TestHub } from "./release-gate/hub.ts";
import { makeDeveloper, targetsOf } from "./release-gate/team.ts";
import type { GateDeveloper } from "./release-gate/team.ts";

const CASE_TIMEOUT_MS = 300_000;
const DIR = "apps/practice/mapping";
const TOPIC_BRANCH = "feat/numlabs-practices";
const MIKE_BRANCH = "feat/streaming-practice-beta";
const TEMPLATE = `${DIR}/templates/grid.template.tsx`;
/** File mtimes have one-second granularity on some filesystems: the compact must start strictly after the writes. */
const MTIME_GRANULARITY_MS = 1_100;

const at = (name: string): string => `${DIR}/${name}`;

/** Who touches what. All of them are Mike's too. */
const FILES = {
  preEditDirty: [at("MappingToolbar.tsx"), at("useMappingState.ts")],
  preEditCommitted: [at("mappingSchema.ts"), at("MappingRow.tsx")],
  preBash: [at("PlayerMappingGrid.tsx"), at("columns.ts")],
  afterEdit: [at("mappingApi.ts")],
} as const;
const PRE: readonly string[] = [...FILES.preEditDirty, ...FILES.preEditCommitted, ...FILES.preBash];
const ALL_SHARED: readonly string[] = [...PRE, ...FILES.afterEdit];
/** columns.ts is new: Mike and Nick each create it. */
const SEEDED = ALL_SHARED.filter((path) => !path.endsWith("/columns.ts"));
const MIKE_CHECKS = [FILES.preEditDirty[0], FILES.preEditCommitted[0], FILES.preBash[0]];

const shortName = (path: string): string => path.split("/").at(-1) ?? path;

interface TripwireRow {
  readonly developerName: string;
}

/** Of `files`, the ones `reader`'s tripwire would warn about `teammate` on, read straight off the hub. */
const filesWarnedAbout = async (
  hub: TestHub,
  reader: GateDeveloper,
  repo: string,
  files: readonly string[],
  teammate: string,
): Promise<readonly string[]> => {
  const out: string[] = [];
  for (const file of files) {
    const answer = await hub.getAs<{ sessions: readonly TripwireRow[] }>(
      reader.account,
      `/api/hints/tripwire?${new URLSearchParams({ repo, value: file }).toString()}`,
    );
    if (answer.sessions.some((row) => row.developerName === teammate)) {
      out.push(file);
    }
  }
  return out;
};

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })));
});

describe("resume after SessionEnd: Nick's pre-resume work warns Mike again (H1)", () => {
  let hub: TestHub;
  const seen: { before: readonly string[]; afterNextLane: readonly string[]; mikeWarned: Readonly<Record<string, boolean>> } = {
    before: [],
    afterNextLane: [],
    mikeWarned: {},
  };

  beforeAll(async () => {
    hub = await startHub();
    const repo = await seedCase("cal-resume", hub.url, [...SEEDED, TEMPLATE]);
    const mike = await makeDeveloper(hub, MIKE, "cal-resume-mike");
    const nick = await makeDeveloper(hub, NICK, "cal-resume-nick");
    const mikeCheckout = await checkoutFor(repo, MIKE, MIKE_BRANCH, "mike");
    const nickClone = await cloneFor(repo.seed, "cal-resume-nick", repo.remoteUrl, NICK);
    const nickStart = await addDetachedWorktree(nickClone, join(dirname(nickClone), "agentic-main"), "origin/main");
    const nickTopic = join(dirname(nickClone), "numlabs");
    cleanups.push(repo.seed, mikeCheckout.parent, dirname(nickClone), mike.home, nick.home);

    // Mike's day: every shared file, committed.
    const mikeDay = openSession(mike, "cal-resume-mike-day", mikeCheckout.worktree);
    await mikeDay.start("startup");
    await mikeDay.prompt("streaming beta: wire the player mapping grid to the live feed");
    await editEach(mikeDay, mikeCheckout.worktree, ALL_SHARED, "mike day");
    await mikeDay.bash(
      "git commit -am mapping",
      async () => {
        await commitAll(mikeCheckout.worktree, "streaming beta: mapping", MIKE, new Date().toISOString());
      },
      { cwd: mikeCheckout.worktree },
    );
    await mikeDay.stop();

    // Nick's long session: a subagent edits, commits and Bash-creates shared files in a sibling worktree.
    const nickSession = openSession(nick, "cal-resume-nick-long", nickStart);
    const bashWrite = async (path: string, how: "cp" | "mv", actor: Actor): Promise<void> => {
      const target = join(nickTopic, path);
      await nickSession.bash(
        `${how} … ${path}`,
        async () => {
          await mkdir(dirname(target), { recursive: true });
          if (how === "cp") {
            await copyFile(join(nickTopic, TEMPLATE), target);
            return;
          }
          const staged = join(dirname(nickTopic), `staged-${path.replaceAll("/", "_")}`);
          await writeFile(staged, fileSource(path, "nick moved"), "utf8");
          await rename(staged, target);
        },
        { cwd: nickTopic, actor },
      );
    };
    await nickSession.start("startup");
    await nickSession.prompt("NumLabs: port the practice mapping import onto the practices API");
    await nickSession.bash(
      `git worktree add -b ${TOPIC_BRANCH} ../numlabs origin/main`,
      async () => {
        await addWorktree(nickClone, nickTopic, TOPIC_BRANCH, "origin/main");
      },
      { cwd: nickStart },
    );
    await nickSession.subagent("mapping-port", async (actor) => {
      await editEach(nickSession, nickTopic, [...FILES.preEditDirty, ...FILES.preEditCommitted], "nick pre", actor);
      await bashWrite(FILES.preBash[0], "cp", actor);
      await bashWrite(FILES.preBash[1], "mv", actor);
      await nickSession.bash(
        "git commit mappingSchema.ts MappingRow.tsx",
        async () => {
          await gitIn(nickTopic, ["add", "--", ...FILES.preEditCommitted]);
          await gitIn(nickTopic, ["commit", "--no-verify", "-q", "-m", "numlabs: mapping schema"], {
            as: NICK,
            date: new Date().toISOString(),
          });
        },
        { cwd: nickTopic, actor },
      );
    });
    await nickSession.stop();
    seen.before = await filesWarnedAbout(hub, mike, repo.repoId, PRE, "Nick");

    // The reload: SessionEnd, then the resume — the next life of the same conversation.
    await nickSession.end();
    await nickSession.start("resume");
    // The next life's first work: a subagent edits a file the earlier life never touched, then the turn ends.
    await nickSession.subagent("practices-sync", async (actor) => {
      await editEach(nickSession, nickTopic, FILES.afterEdit, "nick after", actor);
    });
    await nickSession.stop();
    seen.afterNextLane = await filesWarnedAbout(hub, mike, repo.repoId, PRE, "Nick");

    // Mike's next session: each checked file's PreToolUse.
    const mikeNext = openSession(mike, "cal-resume-mike-next", mikeCheckout.worktree);
    await mikeNext.start("resume");
    await mikeNext.prompt("next: the mapping schema for the beta feed");
    const warned: Record<string, boolean> = {};
    for (const file of MIKE_CHECKS) {
      const runs = await mikeNext.edit(join(mikeCheckout.worktree, file), fileSource(file, "mike next"));
      warned[shortName(file)] = agentTexts(runs.filter((run) => run.event === "PreToolUse")).some((text) => text.includes("Nick"));
    }
    seen.mikeWarned = warned;
  }, CASE_TIMEOUT_MS);

  afterAll(async () => {
    await hub.close();
  });

  test("positive control: before the SessionEnd Mike's tripwire sees all 6 of Nick's files", () => {
    expect(seen.before.map(shortName)).toEqual(PRE.map(shortName));
  });

  test("after the resume and Nick's next lanes, Mike's tripwire sees all 6 again", () => {
    expect(seen.afterNextLane.map(shortName)).toEqual(PRE.map(shortName));
  });

  test("Mike's agent is warned about a pre-resume file Nick left dirty, one he committed, and one only Bash created", () => {
    expect(seen.mikeWarned).toEqual({ "MappingToolbar.tsx": true, "mappingSchema.ts": true, "PlayerMappingGrid.tsx": true });
  });
});

describe("a compact before the turn's Stop keeps the Bash-only files (H1)", () => {
  let hub: TestHub;
  const filed: { values: readonly string[] } = { values: [] };

  beforeAll(async () => {
    hub = await startHub();
    const label = "cal-compact";
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const repo = await seedCase(label, hub.url, paths);
    const dev = await makeDeveloper(hub, { name: "Nick Compact", email: "nick-compact@example.com" }, label);
    const checkout = await checkoutFor(repo, dev.person, `feat/${label}-start`, `nick-${label}`);
    cleanups.push(checkout.parent, repo.seed, dev.home);
    const sibling = await addWorktree(checkout.clone, join(checkout.parent, "sib"), `feat/${label}-sib`, "origin/main");
    const session = openSession(dev, `sess-${label}`, checkout.worktree);
    await session.start("startup");
    await session.prompt("work in the sibling worktree");
    // An Edit-tool touch makes the sibling a known root of the session.
    await session.edit(join(sibling, "src/a.ts"), fileSource("src/a.ts", "edited"));
    // A Bash-only effect there: a new file and a modified tracked file.
    await session.bash(
      "cp src/b.ts src/by-bash.ts && echo '// more' >> src/c.ts",
      async () => {
        await writeFile(join(sibling, "src/by-bash.ts"), await readFile(join(sibling, "src/b.ts"), "utf8"), "utf8");
        await writeFile(join(sibling, "src/c.ts"), `${fileSource("src/c.ts")}// more\n`, "utf8");
      },
      { cwd: sibling },
    );
    await Bun.sleep(MTIME_GRANULARITY_MS);
    await (session.start as (source: string) => Promise<unknown>)("compact");
    await session.stop();
    filed.values = (await targetsOf(hub.db, repo.repoId)).filter((row) => row.kind === "file").map((row) => row.value);
  }, CASE_TIMEOUT_MS);

  afterAll(async () => {
    await hub.close();
  });

  test("the turn's Stop files the Bash-created and the Bash-modified file", () => {
    expect([...new Set(filed.values)].sort()).toEqual(["src/a.ts", "src/by-bash.ts", "src/c.ts"]);
  });
});
