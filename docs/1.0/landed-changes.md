# Landed changes: warn before an edit undoes a teammate's merged work

*Design note, not a numbered spec. It records the decisions behind one
feature and the order it is built in.*

## The failure

Crosscheck models a conflict as SIMULTANEITY: the tripwire fires when an
ACTIVE teammate session has targeted the file you are about to edit. Most
real conflicts are SEQUENTIAL. A teammate finishes, merges into `staging`,
and ends the session. An hour later you edit the same file on a branch cut
from `main` before that merge. The tripwire is silent: nobody is active. The
briefing is silent: "landed" today means "the session's base commit is an
ancestor of the default branch", which says nothing about the file, nothing
about `staging`, and nothing about whether YOUR checkout has the change. You
find out when the two changes meet in review, or in production, or on a
phone call.

## Decisions (grilled with Nick, 2026-09-24)

1. **Warn while the change is missing, at any age.** If a teammate's change
   to the file has landed and your checkout does not contain it, you are told
   no matter how old it is: missing work does not become safe with time.
2. **If you already have it, only when it is recent:** landed within the last
   two working days (Monday to Friday, in the reader's own timezone; public
   holidays are ignored in this version). Older changes you already have are
   ordinary history.
3. **Stop once per file per session, and say why.** An interruptive "ask",
   never a block — the same single decision literal as the live tripwire.
   Headless sessions use the existing `CROSSCHECK_TRIPWIRE=notice`.
   *Refined during review, pending Nick's confirmation:* once per file per
   session **per reason**. The landed-change stop has its own marker, so it
   cannot use up the live one: a teammate who starts on the same file later
   in the session is still named, once. When both reasons apply at the same
   moment it is one stop that says both.
4. **"Landed" means merged into a landing branch, and a team names its own.**
   Not every company has `main` and `staging`. The committed `.crosscheck.json`
   may list them — `"landingBranches": ["main", "staging"]` — and without that
   list the default branch plus any of `staging` and `develop` that exist on
   `origin` are used.
5. **The author hears about it** (a later step): the original author is told
   that someone ran into their landed change, in the next briefing and live
   on the next prompt.

## Mechanism

**Git is the authority on WHAT; the hub adds WHY.** Whether a change landed
and whether your checkout has it are facts about commits, and your own clone
answers them without trusting anyone (`connector-core/src/landed-changes/`).

- *Missing* — asked first, because it is the half that matters:
  `git log --no-merges --cherry-pick --left-only <landing>...HEAD -- <file>`,
  meaning commits reachable from the landing branch, not from your HEAD, and
  not patch-equivalent to anything you already have (a change that reached
  you by cherry-pick is not "missing"). No clock is involved, by design: a
  merged feature branch keeps its original commit dates, so a date filter
  would hide exactly the changes ancestry sees. Then:
  - work that is *arriving* is not missing: while you resolve a merge,
    everything MERGE_HEAD brings; during a cherry-pick, exactly the one
    commit being picked;
  - a file with *nothing an edit could undo* is not warned about: its
    content already equals the landing branch's, or the landing branch made
    no net change to it (a change and its revert) *and* nobody but you
    touched it on your side — without that second condition, a branch
    carrying a teammate's work that the landing branch has since reverted
    would bring the reverted work back, silently;
  - when git's limit was spent partly on arriving work (a merge that brings
    many commits to the file), git is asked again with that work excluded,
    so what is certainly missing is never thrown away with it;
  - a landing branch git cannot answer for in time — or that is still
    answering when the deadline comes — is named in the stop
    ("not checked in time"); what the other branches know is still said. While
    the missing half is incomplete, a stop about recent work alone waits, so
    it cannot spend the once-per-file marker on the half that matters least.
- *Recent and present* — asked second, and allowed to run out of time
  without costing the missing half: a change in HEAD whose FIRST arrival on
  any landing branch falls inside the two-working-day window. Git is asked
  for the window itself (`--first-parent --since=<window start>`, local
  midnight on your calendar), where merge and squash commits carry the time
  a change LANDED. A change some landing branch already had when the window
  opened is dropped (a release merge or back-merge re-lands old work), and
  so is one that only re-lands content a landing branch already had (a
  squash release) — unless that content is from the change's own ancestry,
  because returning to an ancestor's content is a revert, and a revert is
  new. This is the one time-shaped question here, and it is time-shaped by
  decision 2, so its module is the second entry on the staleness-axis
  allowlist.
- Your own commits never warn you. You are recognised by git's own author
  identity passed through the repo's `.mailmap`, exactly as every author in
  the log is — so if GitHub writes your squash merges under another address,
  map it there.
- A shallow clone answers "unknown" (its boundary commit reads as touching
  every file) and `doctor` warns. A blobless partial clone is probed without
  patch identity, since that would need the network.
- Every git call the probe makes is bounded, non-interactive and never
  fetches (fetching is a separate background process, below), at most
  eight at once; the whole probe has a deadline no longer than one hub call.
  A slow or broken probe means no warning, never a blocked edit.
- Only an answer that is COMPLETE and found NOTHING is cached — keyed on the file, HEAD,
  the merge or cherry-pick in progress (by its commits), every landing
  branch's tip, your identity and `.mailmap`, and your calendar day — so a
  file is walked once per state of the repo, not once per edit, and a cache
  hit costs the five git calls that compute the key. An answer with an
  unchecked branch, a failed, capped or timed-out half, or a limit reached
  with nothing shown carries no key and is asked again next time.

The hub's part (a later step) is the reason: the teammate's work context for
that file — intent, decisions, rejected approaches — matched to the commit
author, so the warning can say "Mike changed this, and here is why" instead of
only "a commit touched this file".

**Your clone only knows what it has fetched.** A change merged after your last
fetch is invisible to git, so step 2 fetches the landing branches in the
background.

## Fetching the landing branches (step 2)

The most common sequential conflict is the one step 1 cannot see: Mike merged
an hour ago, and you have not run `git fetch` since this morning. So the
landing branches are fetched in the background. This is on by default, can be
switched off, and never makes anything wait.

- **When.** On session start, on each prompt and before each edit, at most
  once every five minutes per clone. Worktrees of one clone share the
  five minutes, because they share the refs. The hook books the attempt under
  a lock and then starts a detached process (book, then start, like every
  other worker here), so two hooks never fetch twice. The hook never waits
  for the network, so the fetch serves the *next* edit, not the one that
  triggered it.
- **Which clones.** Only one that already tracks origin: at least one
  `refs/remotes/origin/*`. A remote someone added but never fetched from may
  carry a wrong URL, and its first contact should be your own `git fetch`,
  not a hook's. (Pointing an already-fetched origin at a new URL keeps its
  refs, so the next background fetch goes to the new URL.) A shallow clone,
  where the stop is silent anyway, is not fetched.
- **Which branches.** Every branch the stop reads now (step 1's rule on the
  clone's own refs), plus what the same rule picks on origin, each only while
  origin has it. Origin is asked about all of those names with
  `git ls-remote`, one round trip, because a named branch that origin lacks
  would fail the whole fetch. The
  union is what keeps the fetch and the stop from disagreeing when origin's
  default branch moved after the clone was made: your `origin/HEAD` still
  names the old one, as with git itself, so the stop still reads it, and it
  is the one that must stay fresh.
- **What it writes: `refs/remotes/origin/<landing branch>`, nothing else.**
  `git fetch --no-tags --no-prune --no-recurse-submodules --no-write-fetch-head --no-auto-maintenance --refmap= origin +refs/heads/<b>:refs/remotes/origin/<b> …`,
  with `fetch.writeCommitGraph=false`.
  - No local branch, working tree, index, tag, submodule, commit-graph or gc,
    and no `FETCH_HEAD`, which matters most: your own `git pull` reads it
    between its fetch and its merge.
  - `--refmap=` matters too. Without it, git also applies every
    `remote.origin.fetch` refspec you configured to what it fetches, and such
    a refspec can name a local branch.
  - It never prunes. The refspecs name only branches origin has, so there is
    nothing to prune (measured: with `fetch.prune` and `fetch.pruneTags` on,
    a local tag survives). `--no-prune` stays as a second guard for a future
    refspec that is not so narrow.
  - A branch named `HEAD` is never a landing branch. It would write through
    `refs/remotes/origin/HEAD` into `origin/main`, and git itself never
    fetches one.
  - A single-branch clone gains the remote-tracking refs it did not have,
    which is the point.
  - Your own `reference-transaction` hook runs, as it does for any fetch of
    yours.
- **Git and ssh cannot ask.** The worker runs in its own session with no
  controlling terminal. This was measured: a child that a hook starts
  normally can open `/dev/tty`, and ssh would ask for a key passphrase right
  on the agent's screen. On top of that it sets:
  - `GIT_TERMINAL_PROMPT=0`;
  - `GIT_ASKPASS=false`, which overrides an editor's askpass that would open a
    dialog;
  - `SSH_ASKPASS_REQUIRE=never`;
  - `ssh -o BatchMode=yes`, unless you set your own ssh command
    (`GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand`). Yours is kept, and
    without a terminal it cannot ask either.

  Credential helpers still run, because a stored token is how a silent fetch
  signs in. They are told `credential.interactive=false` (Git Credential
  Manager also gets `GCM_INTERACTIVE=never`), but a helper or an ssh agent
  that ignores both can still show a dialog of its own: a keychain unlock, a
  hardware-key touch, an agent's confirmation.
- **Bounded, with nothing left behind.** `ls-remote` is bounded at 30 s and
  the fetch at 120 s. Each of the two leads its own process group. At its
  deadline that whole group is ended before the worker goes on: first
  SIGTERM, so git removes its ref locks, then SIGKILL. A ProxyCommand or a
  helper that ignores the signal does not outlive it. Only the abandoned
  call's own processes go. A credential-cache daemon that the earlier,
  finished call started stays yours. An ssh ControlPersist master leaves the
  group by OpenSSH's own design (not probed here: no local sshd). Git runs
  with exactly the environment the hook was given.
- **Off switches.** `"landingFetch": false` in `.crosscheck.json` switches it
  off for the team, `CROSSCHECK_LANDING_FETCH=off` for one person, and
  `"landingBranches": []` switches off both the stop and the fetch.
- **Recorded, and `doctor` says so.** One small file per clone lives in
  Crosscheck's state directory, never inside the repo. It holds the last
  attempt, the last success, the branches it brought and the failures in a
  row. The stored reason is Crosscheck's own words ("did not finish within
  120 s"), never git's output, which can carry a URL with a token in it.
  `doctor` shows how old the last fetch is and which branches it brought.
  It warns when:
  - the fetch has failed three times in a row, with "run `git fetch origin`
    to see why, or switch it off";
  - at its last run a branch origin has did not arrive while others did (git
    refused its ref, and that fails git's whole answer). What arrived still
    counts: the refs are read before and after, and a dropped connection,
    where nothing moved, is a failure however current the refs already were;
  - bookings keep going unreported, meaning the worker is not starting or not
    finishing;
  - git is older than 2.29;
  - the state directory cannot be written, because then the fetch can never
    book a run.

Known limits of step 2:

- The first edit after a teammate lands can come before the fetch has
  finished, because nothing waits for it. The next edit sees the change.
- If your own `git fetch` or `git pull` runs at the same moment, it can fail
  on a ref lock ("cannot lock ref"); run it again. An editor's auto-fetch has
  the same race.
- When origin's default branch is renamed, your `origin/HEAD` still names the
  old one, as with git itself, and the stop keeps reading the old branch
  until you run `git remote set-head origin -a`. The fetch brings the new
  one, and it is used from then on.
- git older than 2.29 has no `--no-write-fetch-head`, so there is no
  background fetch, and `doctor` says why.
- Only `origin`, as in step 1. Cursor and ACP have no pre-edit stop, so they
  do not fetch either.

## Build order

Each step is one PR into `feat/landed-changes-flow`, then one PR to `main`.
Step 1 reached `main` through the batch PR #66.

1. **The reader's warning, from git alone**: landing branches (config and
   auto-detection), the two probes, the working-day window, own-commit
   exclusion, the PreToolUse ask with its own once-per-file marker, and the
   `doctor` line.
2. **Background fetch** of the landing branches.
3. **The why from the hub**: the teammate context behind the commit.
4. **The author's notice**: briefing and live prompt, exactly once.

## Not in this version

- Cursor and ACP have no pre-edit hook, so no warning there (the same gap the
  live tripwire has).
- Remotes other than `origin`, and wildcard landing branches (`release/*`).
- Public holidays in the working-day window.
- A file you RENAMED is probed under its new name only, so a teammate's
  change to the old name is not seen.
- A first-parent commit with an old or skewed date (a fast-forward push)
  ends git's date walk early, so a recent change can read as older than it
  is. Recent half only, and the reader already has the change.
- A `merge --squash` in progress leaves no marker, so its incoming commits
  read as missing until it is committed.
- A stacked branch on which you ALSO edited the file is warned about the
  landed squash of the work it already contains (the content differs, and
  patch identity cannot see through a squash).
- A recent change that sets a file back to content a SIBLING landing branch
  already had (a revert or deletion of work that branch never got) reads as
  a re-landing and is not mentioned. Recent half only; a return to the
  change's own ancestry is recognised as a revert and is mentioned.
- In a merge that fills git's limit, the second question excludes the
  merge's history inside git — on your side too. A teammate commit you
  already have as a cherry-picked copy that is ALSO in the history being
  merged in can then read as missing, until the merge is committed.
