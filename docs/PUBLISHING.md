# Publishing `crosscheck-hub` to npm

One unscoped package, `crosscheck-hub`, assembled from the seven workspace
packages by [`pack-npm.ts`](../packages/cli/scripts/pack-npm.ts).

Why `crosscheck-hub` and not `crosscheck`: npm refused `crosscheck` at publish
time — its similarity rule against the existing package `cross-check`
("Package name too similar to existing package cross-check"). Only the
PACKAGE name changed: the installed bin is still `crosscheck`, so every
`crosscheck <command>` below is unchanged; only what `npx`/`npm install -g`
name is different.

Why one package
and not three scoped ones: the `@crosscheck` scope's availability cannot be
verified read-only (any npm user or org named `crosscheck` blocks it), a
3-person-team tool gains nothing from three coordinated publishes, and the
single package keeps the licensing split legible — each shipped
`packages/<name>/` directory carries its own LICENSE (+ NOTICE), with the
root LICENSE as the map. The tarball ships TypeScript sources that Bun runs
directly (no build pipeline to rot); a plain-Node bin shim makes `npx` work
by re-executing under Bun, and prints the Bun install one-liner when Bun is
absent.

## How a release reaches npm

Releases are published by CI, never from a laptop:
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml) runs when a
`v*` tag is pushed, and publishes through npm's
[trusted publishing](https://docs.npmjs.com/trusted-publishers): no npm token
exists anywhere, and npm attaches a provenance attestation that names this
repository, the workflow and the commit, so anyone can check where a version
came from.

1. **Bump the version** in a pull request: the same version in all seven
   `packages/*/package.json` files (the pack script refuses to pack unequal
   ones), `MCP_SERVER_VERSION` in `packages/connector-core/src/constants.ts`,
   and the fake install in `packages/cli/test/cli.test.ts`. Merge it.
2. **Wait until CI on that `main` commit is green.** The packed tarball is
   proven there by `packages/cli/test/e2e/npm-package.e2e.test.ts` (clean-dir
   install, `--help`, `serve` + HTTP 200 + clean SIGTERM, `doctor`, both the
   Node-shim and Bun paths, license/file audit).
3. **Push the tag on that commit:**
   ```bash
   git tag vX.Y.Z <main-commit> && git push origin vX.Y.Z
   ```
4. **The workflow does the rest.** Before anything is published,
   [`release-preflight.ts`](../packages/cli/scripts/release-preflight.ts)
   checks that the tag is `vMAJOR.MINOR.PATCH`, that every package carries
   that version, that the tagged commit is on `main`, and that the Test &
   Typecheck legs of CI on that commit succeeded. Any failure stops the job
   with one line naming it. If CI was still running, re-run the job from the
   Actions tab once it is green.

A version can be published once; npm refuses the same version twice, so a
failed publish is fixed forward with a new patch version.

## One-time setup on npmjs.com (the package owner)

1. On npmjs.com, open `crosscheck-hub` → **Settings** → **Trusted Publisher**
   → **GitHub Actions**, and enter: organization or user `NeverStopHH`,
   repository `crosscheck`, workflow filename `publish.yml`, no environment,
   and allow `npm publish`. npm does not check the entry when it is saved; a
   typo shows up only on the first publish, as `ENEEDAUTH`.
2. After the first release published this way: **Settings** → **Publishing
   access** → *Require two-factor authentication and disallow tokens*. From
   then on a leaked token can publish nothing, and trusted publishing keeps
   working.

## Publishing by hand (fallback only)

Only if the workflow cannot run. Every rule below comes from a release that
went wrong without it.

- **Pack from `main`, current:** `git pull --ff-only origin main` and check
  that `HEAD` equals `origin/main` first. The pack script builds from whatever
  directory it runs in; 0.8.0 was once packed from a clone five merges behind.
- **Log in on its own line,** not inside a pasted block: `npm login` is
  interactive and swallows the lines pasted after it.
- **Tag after the publish succeeded,** never before: a tag pushed first once
  landed on the wrong commit and had to be re-cut.

```bash
npm login
npm publish "$(bun packages/cli/scripts/pack-npm.ts | tail -1)"
# the script assembles dist/npm/, runs `npm pack`, and prints the tarball path last
```

**If the publish fails with `E404 Not Found - PUT
https://registry.npmjs.org/crosscheck-hub`: check your token before anything
else.** A STALE npm token (expired, or revoked by an npm security sweep)
yields exactly this misleading 404 on the PUT — it looks like "package does
not exist" or a naming problem, but the registry is answering 404 to an
unauthenticated write. The fix is `npm login` again, then re-run the same
publish command. (This bit us three times; the tarball and the name were fine
every time.)

A new version can take up to about an hour to appear after npm accepted the
upload (0.10.0 took about 40 minutes): the upload answers `+ crosscheck-hub@…`
while `latest` still names the old version. Do not publish again; wait.

## Verify afterwards (machine without the repo)

```bash
npx crosscheck-hub@latest --version    # -> crosscheck X.Y.Z (the CLI keeps its name)
bunx crosscheck-hub@latest --help      # usage screen, exit 0
ADMIN_TOKEN=t CROSSCHECK_DATA_DIR=/tmp/cx-smoke npx crosscheck-hub@latest serve
# expect: "crosscheck server listening on :7100 · search: exact+fts (keyless)"
# then:   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7100/ui/login  -> 200
# Ctrl+C must end it cleanly.

npm install -g crosscheck-hub@latest && crosscheck --version   # the connector flow —
# `init` must be run from a PERMANENT install like this one; it refuses to
# wire hooks from an npx/bunx cache (the launcher would die with the cache).
```
