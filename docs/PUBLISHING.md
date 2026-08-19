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

## Preconditions

- On `main`, green CI. The packed tarball is proven on every test run by
  `packages/cli/test/e2e/npm-package.e2e.test.ts` (clean-dir
  install, `--help`, `serve` + HTTP 200 + clean SIGTERM, `doctor`, both the
  Node-shim and Bun paths, license/file audit). That e2e needs node + npm on
  PATH and — on a cold npm cache — the registry; where those are missing it
  skips with a loud warning instead of failing, so a green offline run proves
  nothing about the tarball. CI has all three.
- All three workspace `package.json` versions identical — the pack script
  refuses to pack otherwise, and `--version` reports this number.
- Name still free (it was on 2026-08-18):
  `curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/crosscheck-hub`
  → `404` means free.

## Publish

```bash
npm login                          # the npmjs account that will own the package

cd ~/Desktop/crosscheck
npm publish "$(bun packages/cli/scripts/pack-npm.ts | tail -1)"
# the script assembles dist/npm/, runs `npm pack`, and prints the tarball path last
# unscoped packages are public by default; publishConfig.access=public is set anyway
```

No `--access` flag is required (unscoped), no scope, no dependency order —
there is exactly one package.

## Verify afterwards (machine without the repo)

```bash
npx crosscheck-hub@latest --version    # -> crosscheck 0.5.1 (the CLI keeps its name)
bunx crosscheck-hub@latest --help      # usage screen, exit 0
ADMIN_TOKEN=t CROSSCHECK_DATA_DIR=/tmp/cx-smoke npx crosscheck-hub@latest serve
# expect: "crosscheck server listening on :7100 · search: exact+fts (keyless)"
# then:   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7100/ui/login  -> 200
# Ctrl+C must end it cleanly.

npm install -g crosscheck-hub@latest && crosscheck --version   # the connector flow —
# `init` must be run from a PERMANENT install like this one; it refuses to
# wire hooks from an npx/bunx cache (the launcher would die with the cache).
```

Then tag: `git tag v0.5.1 && git push origin v0.5.1`.

## Version bumps

Bump the SAME version in all three `packages/*/package.json` files (the pack
script enforces equality), re-run the suite, publish the fresh tarball.
