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
  - a landing branch git cannot answer for in time is named in the stop
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
- Every git call is bounded, non-interactive and never fetches, at most
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
fetch is invisible to git. A later step fetches the landing branches in the
background (remote-tracking refs only; never your working tree or your local
branches), rate-limited and non-interactive, with an off switch.

## Build order

Each step is one PR into `feat/landed-changes-flow`, then one PR to `main`.

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
  merge's history inside git; a teammate commit whose cherry-picked copy
  lives only on the side being merged in can then read as missing.
