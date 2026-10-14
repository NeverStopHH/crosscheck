/**
 * CROSSCHECK'S GIT RUNS NO COMMAND A REPO'S CONFIG NAMES (git/git.ts
 * `GIT_SAFETY_CONFIG`; review round 2, N3).
 *
 * Two baits, both measured by the review:
 * - a clone whose config names a marker script for every key that makes git
 *   execute something;
 * - a clone carrying a committed directory laid out as a bare repository,
 *   whose committed config names an fsmonitor and a clean filter.
 * Each of crosscheck's own argv shapes runs through `runGitOutcome` and must
 * execute none of them. The control arm runs the developer's own commands
 * unpinned against the same bait, which proves every marker is live.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GIT_SAFETY_CONFIG, pinnedGitArgv, runGitOutcome } from "../src/git/git.ts";

const PACKAGES_DIR = new URL("../../", import.meta.url).pathname;
const GIT_TIMEOUT_MS = 10_000;

let base = "";
let fired = "";
let bin = "";
/** What every git here runs under: no global or system config, a scratch home. */
let hermetic: Record<string, string> = {};

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "cx-git-pins-"));
  fired = join(base, "fired.log");
  bin = join(base, "bin");
  await mkdir(bin);
  hermetic = {
    HOME: base,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@example.invalid",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The developer's own git, unpinned: setup and the control arm. */
const devGit = (cwd: string, args: readonly string[]): string => {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, env: { ...process.env, ...hermetic }, stdout: "pipe", stderr: "pipe" });
  return result.stdout.toString().trim();
};

/** A script that books its own name in the log, then behaves neutrally. */
const marker = async (name: string, body: string): Promise<string> => {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\necho ${name} >> "${fired}"\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return path;
};

const firedNames = async (): Promise<readonly string[]> => {
  const text = await readFile(fired, "utf8").catch(() => "");
  return [...new Set(text.split("\n").filter((line) => line.length > 0))].sort();
};

const clearFired = (): Promise<void> => writeFile(fired, "", "utf8");

/** crosscheck's own argv, run the way every call site runs it. */
const crosscheckGit = async (cwd: string, args: readonly string[]): Promise<boolean> =>
  (await runGitOutcome(args, cwd, GIT_TIMEOUT_MS, hermetic)).ok;

describe("the argv of every crosscheck git call", () => {
  test("starts with the safety pins, then the caller's args", () => {
    // Act
    const argv = pinnedGitArgv(["rev-parse", "--show-toplevel"]);

    // Assert
    expect(argv).toEqual(["git", ...GIT_SAFETY_CONFIG, "rev-parse", "--show-toplevel"]);
    expect(GIT_SAFETY_CONFIG).toEqual([
      "-c",
      "safe.bareRepository=explicit",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "log.showSignature=false",
      "-c",
      "core.pager=cat",
    ]);
  });

  test("puts the diff and transport pins right after the subcommand, past global options", () => {
    // Act
    const diff = pinnedGitArgv(["--literal-pathspecs", "-c", "core.quotePath=false", "diff", "--name-only", "HEAD", "--", "a b"]);
    const fetch = pinnedGitArgv(["-c", "credential.interactive=false", "fetch", "--quiet", "origin"]);
    const elsewhere = pinnedGitArgv(["-C", "log", "ls-files", "-s"]);

    // Assert — `-C log` is a directory, not the log subcommand
    expect(diff.slice(GIT_SAFETY_CONFIG.length + 1)).toEqual([
      "--literal-pathspecs",
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "HEAD",
      "--",
      "a b",
    ]);
    expect(fetch.slice(GIT_SAFETY_CONFIG.length + 1)).toEqual([
      "-c",
      "credential.interactive=false",
      "fetch",
      "--upload-pack=git-upload-pack",
      "--quiet",
      "origin",
    ]);
    expect(elsewhere.slice(GIT_SAFETY_CONFIG.length + 1)).toEqual(["-C", "log", "ls-files", "-s"]);
  });

  test("is built in one place: no other shipped source starts git", async () => {
    // Arrange
    const starts: string[] = [];

    // Act
    for await (const file of new Bun.Glob("*/src/**/*.{ts,tsx,js,cjs,mjs}").scan({ cwd: PACKAGES_DIR })) {
      if (/\[\s*["'`]git["'`]\s*,/.test(await Bun.file(`${PACKAGES_DIR}${file}`).text())) {
        starts.push(file);
      }
    }

    // Assert
    expect(starts).toEqual(["connector-core/src/git/git.ts"]);
  });
});

describe("a clone whose config names a command for every executing key", () => {
  let repo = "";

  beforeAll(async () => {
    const hooks = join(base, "hooks");
    await mkdir(hooks);
    for (const hook of ["post-index-change", "reference-transaction", "post-checkout", "pre-auto-gc"]) {
      await writeFile(join(hooks, hook), `#!/bin/sh\necho hook-${hook} >> "${fired}"\ncat >/dev/null 2>&1\nexit 0\n`, "utf8");
      await chmod(join(hooks, hook), 0o755);
    }
    const origin = join(base, "origin");
    await mkdir(origin);
    devGit(origin, ["init", "-q", "-b", "main"]);
    await writeFile(join(origin, "f.txt"), "a\n", "utf8");
    devGit(origin, ["add", "f.txt"]);
    devGit(origin, ["commit", "-qm", "one"]);
    repo = join(base, "repo");
    devGit(base, ["clone", "-q", origin, repo]);
    await writeFile(join(repo, ".gitattributes"), "* diff=x\n", "utf8");
    devGit(repo, ["add", ".gitattributes"]);
    devGit(repo, ["commit", "-qm", "attrs"]);
    const config: readonly (readonly [string, string])[] = [
      ["core.fsmonitor", await marker("fsmonitor", "exit 1")],
      ["core.hooksPath", hooks],
      ["diff.x.textconv", await marker("textconv", 'cat "$1"')],
      ["diff.x.command", await marker("diffcmd", "exit 0")],
      ["diff.external", await marker("external", "exit 0")],
      ["core.pager", await marker("pager", "cat")],
      ["gpg.program", await marker("gpg", "exit 1")],
      ["gpg.ssh.program", await marker("gpgssh", "exit 1")],
      ["log.showSignature", "true"],
      ["remote.origin.uploadpack", await marker("uploadpack", 'exec git-upload-pack "$@"')],
    ];
    for (const [key, value] of config) {
      devGit(repo, ["config", key, value]);
    }
    // HEAD carries a (fake) signature, so a signature-showing log would call gpg.
    const tree = devGit(repo, ["rev-parse", "HEAD^{tree}"]);
    const parent = devGit(repo, ["rev-parse", "HEAD"]);
    const signedBody =
      `tree ${tree}\nparent ${parent}\nauthor a <a@x> 1700000000 +0000\ncommitter a <a@x> 1700000000 +0000\n` +
      "gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQ==\n -----END PGP SIGNATURE-----\n\nsigned\n";
    await writeFile(join(base, "signed.txt"), signedBody, "utf8");
    const signed = devGit(repo, ["hash-object", "-t", "commit", "-w", join(base, "signed.txt")]);
    devGit(repo, ["update-ref", "refs/heads/main", signed]);
    devGit(repo, ["reset", "-q", "--hard", signed]);
    // One file stat-dirty but content-clean, one really dirty.
    Bun.spawnSync({ cmd: ["touch", "-t", "202001010000", join(repo, "f.txt")] });
    await writeFile(join(repo, "g.txt"), "c\n", "utf8");
    devGit(repo, ["add", "g.txt"]);
    await writeFile(join(repo, "g.txt"), "c\nd\n", "utf8");
  }, 30_000);

  test("crosscheck's own calls execute none of it", async () => {
    // Arrange
    const first = devGit(repo, ["rev-list", "--max-parents=0", "HEAD"]);
    const network = ["-c", "credential.interactive=false", "-c", "fetch.writeCommitGraph=false"];
    await clearFired();

    // Act — the argv shapes of the call sites the review listed
    const answered = [
      await crosscheckGit(repo, ["rev-parse", "--show-toplevel"]),
      await crosscheckGit(repo, ["diff", "--name-only", "HEAD"]),
      await crosscheckGit(repo, ["check-attr", "-z", "linguist-generated", "--", "f.txt", "g.txt"]),
      await crosscheckGit(repo, ["ls-files", "--", "f.txt"]),
      await crosscheckGit(repo, ["--literal-pathspecs", "ls-files", "-z", "-s", "--full-name", "--", "f.txt"]),
      await crosscheckGit(repo, ["log", "--all", "--max-count=50", "--format=%ae%x1f%an%x1f%aI"]),
      await crosscheckGit(repo, ["log", "-1", "--format=%s"]),
      await crosscheckGit(repo, ["show", "-M", "--name-status", "--format=", "HEAD"]),
      await crosscheckGit(repo, ["diff", "--name-only", "-z", "--no-renames", first, "HEAD", "--"]),
      await crosscheckGit(repo, [...network, "ls-remote", "--symref", "origin", "HEAD", "refs/heads/main"]),
      await crosscheckGit(repo, [
        ...network,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-prune",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--refmap=",
        "origin",
        "+refs/heads/main:refs/crosscheck/landing/main",
      ]),
    ];

    // Assert — every call still answered, and nothing ran
    expect(answered.every(Boolean)).toBe(true);
    expect(await firedNames()).toEqual([]);
  }, 30_000);

  test("the developer's own commands run them (the control arm)", async () => {
    // Arrange
    await clearFired();

    // Act
    devGit(repo, ["status"]);
    devGit(repo, ["diff", "HEAD"]);
    devGit(repo, ["log", "-1"]);
    devGit(repo, ["ls-remote", "origin"]);

    // Assert — the bait is live, so the empty list above proves the pins
    // (the attribute's diff driver outranks diff.external, so it is diffcmd)
    expect(await firedNames()).toEqual(
      expect.arrayContaining(["diffcmd", "fsmonitor", "gpg", "hook-post-index-change", "uploadpack"]),
    );
  }, 30_000);
});

describe("a committed directory laid out as a bare repository", () => {
  let gen = "";

  beforeAll(async () => {
    // The attacker's repo commits tools/gen with a bare repo's layout and a
    // config naming an fsmonitor and a clean filter; a plain clone keeps it.
    const outer = join(base, "outer");
    const embedded = join(outer, "tools", "gen");
    await mkdir(join(embedded, "objects"), { recursive: true });
    await mkdir(join(embedded, "refs"), { recursive: true });
    devGit(outer, ["init", "-q", "-b", "main"]);
    await writeFile(join(embedded, "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(join(embedded, "objects", ".keep"), "", "utf8");
    await writeFile(join(embedded, "refs", ".keep"), "", "utf8");
    await writeFile(
      join(embedded, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n" +
        `\tfsmonitor = ${await marker("embedded-fsmonitor", "exit 1")}\n` +
        `[filter "x"]\n\tclean = ${await marker("embedded-clean", "cat")}\n`,
      "utf8",
    );
    await writeFile(join(outer, "tools", ".gitattributes"), "* filter=x\n", "utf8");
    await writeFile(join(outer, "tools", "x.txt"), "x\n", "utf8");
    devGit(outer, ["add", "-A"]);
    devGit(outer, ["commit", "-qm", "tools"]);
    const victim = join(base, "victim");
    devGit(base, ["clone", "-q", outer, victim]);
    gen = join(victim, "tools", "gen");
    await writeFile(join(victim, "tools", "x.txt"), "x\ny\n", "utf8");
  }, 30_000);

  test("is never used by crosscheck's git, so its committed commands never run", async () => {
    // Arrange
    await clearFired();

    // Act — an agent that cd'd into tools/gen takes the hooks' cwd there
    const answered = [
      await crosscheckGit(gen, ["rev-parse", "--show-toplevel"]),
      await crosscheckGit(gen, ["diff", "--name-only", "HEAD"]),
      await crosscheckGit(gen, ["check-attr", "-z", "linguist-generated", "--", "../x.txt"]),
      await crosscheckGit(gen, ["ls-files", "--", "../x.txt"]),
    ];

    // Assert — refused outright, and nothing it named ran
    expect(answered).toEqual([false, false, false, false]);
    expect(await firedNames()).toEqual([]);
  }, 30_000);

  test("is used by an unpinned git, which runs them (the control arm)", async () => {
    // Arrange
    await clearFired();

    // Act
    const toplevel = devGit(gen, ["rev-parse", "--show-toplevel"]);
    devGit(gen, ["ls-files", "--", "../x.txt"]);
    devGit(gen, ["add", "../x.txt"]);

    // Assert — git took tools/ as the work tree and ran the committed commands
    expect(toplevel.endsWith(join("victim", "tools"))).toBe(true);
    expect(await firedNames()).toEqual(expect.arrayContaining(["embedded-clean", "embedded-fsmonitor"]));
  }, 30_000);
});
