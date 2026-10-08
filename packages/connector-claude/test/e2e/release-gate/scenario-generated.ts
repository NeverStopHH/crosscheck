/**
 * N2 — two people whose ONLY common ground is lockfiles and generated code.
 * Mike regenerates (one Bash call: install, codegen, build — the git lane at
 * Stop sees the files); Nick then hand-touches each of the same files with
 * the edit tool (the tripwire asks the hub about every one). Nothing here is
 * evidence of a plan, so nothing may warn.
 *
 * WHAT COVERS WHICH CLASS TODAY. Two mechanisms drop machine-written files and
 * neither knows "generated". The connector's path DENYLIST
 * (capture/denylist.ts): `*.lock` at any depth, `package-lock.json` and
 * `pnpm-lock.yaml` ROOT-ANCHORED (no leading `**`), `dist/`, `generated/`
 * (not `__generated__/`), `*.generated.*`, `*.gen.*`. And the hub's HOT rule
 * (GHOST_HOT_TARGET_MAX_CONTEXTS = 20 foreign contexts carrying a value),
 * which a two-person overlap never reaches — so a lockfile the denylist
 * misses is dropped only once it is hot. Nothing reads `.gitattributes`. A
 * nested lockfile, a `__generated__/` file and a `linguist-generated` file
 * therefore become targets, trip the wire, and clear the two-file floor.
 *
 * SPEC — THE GENERATED-TARGET RULE (no branch implements it yet):
 *  1. SIGNALS, all read on the developer's machine:
 *     a. well-known paths at ANY depth: every lockfile name (package-lock.json,
 *        pnpm-lock.yaml, yarn.lock, bun.lock, bun.lockb, go.sum, Cargo.lock,
 *        poetry.lock, composer.lock, Gemfile.lock), `__generated__/`,
 *        `generated/`, `*.generated.*`, `*.gen.*`, `dist/`, `*_pb2.py`,
 *        `*.pb.go`, `*_pb.{ts,js}`;
 *     b. `git check-attr linguist-generated linguist-vendored -- <path>` set,
 *        one bounded call per NEW path, cached per root under the blob id of
 *        the root's `.gitattributes` at HEAD;
 *     c. an `@generated` token or a `Code generated … DO NOT EDIT.` line in
 *        the first 512 bytes — read locally, never sent.
 *  2. WHERE: the CONNECTOR classifies (only it can read the file and the
 *     attributes) and sends the path with `generated: "path" | "attribute" |
 *     "header"` on the target record; the HUB filters — a generated target is
 *     never overlap evidence (ghost pairs, conference pairs, tripwire rows,
 *     the hot count) and never counts toward a context's size. The hub also
 *     applies signal (a) to targets that carry no field, so an older
 *     connector is covered for the well-known paths. PreToolUse skips the
 *     tripwire for a classified path exactly as for a denied one. Targets are
 *     KEPT, not dropped: `suspect` and coverage still see the touch.
 *  3. HONEST COVERAGE: overlap rows carry `generatedSharedCount` beside
 *     `sharedTargetCount` ("and 3 generated files, not counted"); `doctor`
 *     prints "N generated targets kept out of overlap" by signal; a
 *     classification that could not run (check-attr timed out) is counted as
 *     unknown and the target stays ORDINARY — fail toward warning, never
 *     toward silence.
 */
import { join } from "node:path";

import { MIKE, NICK } from "../../../../connector-core/test/fixtures/landing-repos.ts";
import { checkoutFor, editEach, fileSource, seedCase } from "./case-kit.ts";
import type { CaseRepo } from "./case-kit.ts";
import { writeTree } from "./git.ts";
import { openSession } from "./host.ts";
import type { HookRun, HostSession } from "./host.ts";
import type { TestHub } from "./hub.ts";
import { makeDeveloper } from "./team.ts";
import type { GateDeveloper } from "./team.ts";

export interface GeneratedClass {
  readonly name: string;
  readonly path: string;
}

export const GENERATED_CLASSES: readonly GeneratedClass[] = [
  { name: "root bun.lock", path: "bun.lock" },
  { name: "root package-lock.json", path: "package-lock.json" },
  { name: "root pnpm-lock.yaml", path: "pnpm-lock.yaml" },
  { name: "nested package-lock.json", path: "apps/practice/package-lock.json" },
  { name: "__generated__/ directory", path: "packages/api/src/__generated__/schema.ts" },
  { name: "*.generated.ts", path: "packages/api/src/client.generated.ts" },
  { name: "linguist-generated in .gitattributes", path: "packages/proto/src/messages_pb.ts" },
  { name: "dist/", path: "packages/ui/dist/index.js" },
];

const GITATTRIBUTES = "packages/proto/src/** linguist-generated=true\n";
const MIKE_OWN = ["apps/streaming/feed.ts", "apps/streaming/player.ts", "apps/streaming/queue.ts"];
const NICK_OWN = ["apps/numlabs/sync.ts", "apps/numlabs/client.ts", "apps/numlabs/retry.ts"];

export interface GeneratedWorld {
  readonly repo: CaseRepo;
  readonly mike: GateDeveloper;
  readonly nick: GateDeveloper;
  readonly mikeSession: HostSession;
  readonly nickSession: HostSession;
  /** Nick's PreToolUse/PostToolUse runs per class path — what each hand edit was told. */
  readonly nickEdits: ReadonlyMap<string, readonly HookRun[]>;
  readonly mikeStatusline: string;
  readonly nickStatusline: string;
  readonly cleanup: readonly string[];
}

export const runGeneratedCase = async (hub: TestHub): Promise<GeneratedWorld> => {
  const repo = await seedCase("generated-only", hub.url, [...MIKE_OWN, ...NICK_OWN, ...GENERATED_CLASSES.map((entry) => entry.path)], {
    ".gitattributes": GITATTRIBUTES,
  });
  const mike = await makeDeveloper(hub, MIKE, "n2-mike");
  const nick = await makeDeveloper(hub, NICK, "n2-nick");
  const mikeAt = await checkoutFor(repo, MIKE, "feat/streaming-deps", "mike");
  const nickAt = await checkoutFor(repo, NICK, "feat/numlabs-sync", "nick");
  const mikeSession = openSession(mike, "n2-mike-deps", mikeAt.worktree);
  const nickSession = openSession(nick, "n2-nick-sync", nickAt.worktree);

  mikeSession.label("mike-regenerates");
  await mikeSession.start();
  await mikeSession.prompt("bump the streaming client and regenerate everything");
  await editEach(mikeSession, mikeAt.worktree, MIKE_OWN, "streaming");
  await mikeSession.bash(
    "bun install && bun run codegen && bun run build",
    async () => {
      await writeTree(
        mikeAt.worktree,
        Object.fromEntries(GENERATED_CLASSES.map((entry) => [entry.path, fileSource(entry.path, "regenerated by mike")])),
      );
    },
    { cwd: mikeAt.worktree },
  );
  await mikeSession.stop();

  nickSession.label("nick-hand-edits");
  await nickSession.start();
  await nickSession.prompt("numlabs sync: retry policy, then fix the generated client by hand");
  await editEach(nickSession, nickAt.worktree, NICK_OWN, "numlabs");
  const nickEdits = new Map<string, readonly HookRun[]>();
  for (const entry of GENERATED_CLASSES) {
    nickEdits.set(entry.path, await nickSession.edit(join(nickAt.worktree, entry.path), fileSource(entry.path, "patched by nick")));
  }
  await nickSession.stop();
  const nickStatusline = await nickSession.statusline();

  mikeSession.label("mike-next");
  await mikeSession.start("resume");
  await mikeSession.prompt("next: the queue backpressure");
  await editEach(mikeSession, mikeAt.worktree, ["apps/streaming/queue.ts"], "next morning");
  const mikeStatusline = await mikeSession.statusline();

  return {
    repo,
    mike,
    nick,
    mikeSession,
    nickSession,
    nickEdits,
    mikeStatusline,
    nickStatusline,
    cleanup: [repo.seed, mikeAt.parent, nickAt.parent, mike.home, nick.home],
  };
};
