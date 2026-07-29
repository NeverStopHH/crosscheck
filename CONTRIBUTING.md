# Contributing to crosscheck

Thank you for looking. Two things before anything else, because both will
otherwise waste your time.

**A Contributor License Agreement is required.** A bot asks on your first pull
request; you reply with one sentence, once, ever. It exists so the copyright
stays in one place — see [`CLA.md`](CLA.md) for what you grant and, more
importantly, what you keep. If you would rather not sign, open an issue instead:
a precise bug report is worth more here than a patch we cannot accept.

**The repository is licensed in parts.** Apache-2.0 for the connector and the
schema, FSL-1.1-ALv2 for the hub. [`LICENSE`](LICENSE) explains why and what it
means for you.

## Getting it running

```bash
bun install
bun test          # ~35 s
bun run typecheck
```

Bun 1.2 or newer. No database to install — the hub embeds PGlite, so `bun test`
needs nothing beyond the repository.

## What this project is unusually strict about

These are not style preferences. Each one exists because this repository already
produced the defect it prevents, and reviewers will hold you to them.

**A test must be shown to fail against the unfixed code.** A green test that
never reaches the broken path proves nothing. Write it, watch it go red, then
fix. If you cannot make it red, you have not found the defect yet.

**A comment that states a checkable fact must name the command that checks it.**
Not "this is safe because X" — rather, the command a reader can run to see X for
themselves. Fast, single-line, read-only claims are machine-verified in CI:

```
 * VERIFY: grep -c "somethin[g]" packages/connector-claude/src/file.ts
 * PRINTS: 3
```

`scripts/verify-claims.ts` runs every one of these and fails the build if the
output has drifted. Commands run **from the repository root** — a directive that
only works from inside a package will fail, and so it should: a reader starts at
the root. Claims about a state that no longer exists are fine, but mark them
`HISTORICAL` so nobody tries to re-run them.

**Anything touching the filesystem, clocks or concurrency is verified on two
operating systems.** A green suite proves correctness for the OS it ran on. This
is not theoretical here: an inode-reuse bug in the spool was invisible on macOS
(0 of 20 trials) and reliable on Linux (20 of 20). The reproduction recipe:

```bash
rsync -a --delete --exclude node_modules --exclude .git . /tmp/cx-ci/
docker run --rm -v /tmp/cx-ci:/w -w /w --cpus=2 oven/bun:1 sh -c \
  "apt-get update -qq && apt-get install -y -qq git procps && \
   bun install --frozen-lockfile && bun test"
```

`git` must be present in the container or about forty tests fail for the
container's reasons rather than the code's.

**Timing-dependent tests get run repeatedly.** Nearly every defect in the spool
was a race, with hit rates between 3-in-13 and 8-in-10. One green run says
almost nothing; CI repeats the concurrency suite five times for that reason.

**Never weaken a test to make it pass.** If a test is wrong, say so in the pull
request and prove it. That is a perfectly good contribution.

**When a defect keeps moving between individually correct fixes, the design is
wrong.** The flush lock was patched twice before the clock was removed entirely.
Say so when you see it, rather than adding the third patch.

## Pull requests

Branch from `main`, one topic per branch. The template asks for five sections;
they exist because the second one is usually the hardest and the most useful:

- **Summary** — what changed, in a sentence or two
- **Why now** — the evidence that this needed doing, with numbers where you have them
- **What changed** — the shape of the diff, not a file list
- **Test plan** — the commands you ran and what they printed, on both platforms
  where the rules above apply
- **Followups** — what you deliberately left undone. A pull request does not have
  to be complete. It has to be honest.

Quote output you produced in this session, from commands you can name. Numbers
copied from an earlier run or from another report have a way of being wrong by
the time anyone checks.

## Reporting bugs and asking for features

Open an issue. For a bug, the reproduction matters more than the diagnosis — if
you can give a command that shows the wrong behaviour, that is most of the work
done. For a feature, describe the situation you are in before describing the
feature; the situation is often solvable another way.

Security issues: please do not open a public issue. Report them privately
through GitHub's "Report a vulnerability" button on the Security tab.
