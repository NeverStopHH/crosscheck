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
   never a block — the same single decision literal as the live tripwire,
   sharing its once-per-file marker, so a file stops you at most once per
   session whichever of the two found something. Headless sessions use the
   existing `CROSSCHECK_TRIPWIRE=notice`.
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
answers them without trusting anyone:

- *Missing*: `git log --no-merges --cherry-pick --left-only <landing>...HEAD -- <file>`,
  meaning commits reachable from the landing branch, not from your HEAD, and
  not patch-equivalent to anything you already have (a change that reached
  you by cherry-pick or a different squash is not "missing"). No clock is
  involved, by design: a merged feature branch keeps its original commit
  dates, so a date filter would hide exactly the changes ancestry sees.
- *Recent and present*: `git log --first-parent --since=<window> <landing> -- <file>`,
  the landing branch's own first-parent line, whose merge and squash commits
  carry the time the change LANDED rather than when it was written, then kept
  only if it is an ancestor of HEAD and inside the two-working-day window.
  This is the one time-shaped question here, and it is time-shaped by
  decision 2, so this module is the second entry on the staleness-axis
  allowlist. Its failure direction is known: a fast-forward push keeps old
  commit dates, so such a change reads as older than it is, and the reader,
  who already HAS it, is not told. That is the low-stakes direction.
- Your own commits (author email equals your `git config user.email`) never
  warn you.
- Every git call is bounded and fails open: a slow or broken probe means no
  warning, never a blocked edit.

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
   exclusion, and the PreToolUse ask sharing the tripwire marker.
2. **Background fetch** of the landing branches.
3. **The why from the hub**: the teammate context behind the commit.
4. **The author's notice**: briefing and live prompt, exactly once.

## Not in this version

- Cursor and ACP have no pre-edit hook, so no warning there (the same gap the
  live tripwire has).
- Remotes other than `origin`, and wildcard landing branches (`release/*`).
- Public holidays in the working-day window.
