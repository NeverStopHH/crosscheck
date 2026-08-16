# Publishing `crosscheck` to npm

One unscoped package, `crosscheck`, assembled from the three workspace
packages by [`pack-npm.ts`](../packages/connector-claude/scripts/pack-npm.ts). Why one package
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
  `packages/connector-claude/test/e2e/npm-package.e2e.test.ts` (clean-dir
  install, `--help`, `serve` + HTTP 200 + clean SIGTERM, `doctor`, both the
  Node-shim and Bun paths, license/file audit).
- All three workspace `package.json` versions identical — the pack script
  refuses to pack otherwise, and `--version` reports this number.
- Name still free (it was on 2026-08-16):
  `curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/crosscheck`
  → `404` means free.

## Publish

```bash
npm login                          # the npmjs account that will own the package

cd ~/Desktop/crosscheck
npm publish "$(bun packages/connector-claude/scripts/pack-npm.ts | tail -1)"
# the script assembles dist/npm/, runs `npm pack`, and prints the tarball path last
# unscoped packages are public by default; publishConfig.access=public is set anyway
```

No `--access` flag is required (unscoped), no scope, no dependency order —
there is exactly one package.

## Verify afterwards (machine without the repo)

```bash
npx crosscheck@latest --version    # -> crosscheck 0.5.0
bunx crosscheck@latest --help      # usage screen, exit 0
ADMIN_TOKEN=t CROSSCHECK_DATA_DIR=/tmp/cx-smoke npx crosscheck@latest serve
# expect: "crosscheck server listening on :7100 · search: exact+fts (keyless)"
# then:   curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7100/ui/login  -> 200
# Ctrl+C must end it cleanly.
```

Then tag: `git tag v0.5.0 && git push origin v0.5.0`.

## Version bumps

Bump the SAME version in all three `packages/*/package.json` files (the pack
script enforces equality), re-run the suite, publish the fresh tarball.
