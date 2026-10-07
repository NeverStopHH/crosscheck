# Operating a hub

What an operator needs beyond the README's "run it": what the hub does on its own at start-up, and how to undo what it did.

## Running SQL against a hub's data dir

A PGlite data dir (`CROSSCHECK_DATA_DIR`) is opened by one process at a time, so **stop the hub first**. Then, from a checkout of the hub's own version (a newer PGlite cannot open an older one's dir; `createDb` says so by name):

```sh
cd packages/server
CROSSCHECK_DATA_DIR=/path/to/data bun -e '
  import { sql } from "drizzle-orm";
  import { createDb } from "./src/db/client.ts";
  const db = await createDb({ dataDir: process.env.CROSSCHECK_DATA_DIR });
  console.log((await db.execute(sql.raw(await Bun.file(process.argv[1]).text()))).rows);
' /path/to/statement.sql
```

## Start-up passes

After the hub is serving it runs, in the background and in this order:

1. **Draft link cleanup** (`services/draft-link-cleanup.ts`): the relates_to links an older similarity gate made between two developers' claims on a draft's strength. A link whose draft was since confirmed moves to the confirmed claim; every other one is archived in `claim_edges_removed` and removed, in one statement. The log line names the pass id and the edge ids.
2. **Doc upgrade** (`services/doc-upgrade.ts`): rebuilds the search documents that still fold drafts in, a page at a time, letting requests through between pages.
3. **Vector backfill** (`services/embedding-backfill.ts`, only with an embedder configured): embeds every work context whose vector is missing or was minted by another model.

Each pass is idempotent and resumable: a start that is killed mid-pass leaves the next start the rest.

## Restoring links the cleanup archived

Every link the cleanup removed is in `claim_edges_removed`, as it was, with `removed_by_pass` set to the pass id from the start-up log. To put one pass's links back, replace `<pass id>` and run:

```sql
-- restore-archived-links
INSERT INTO claim_edges (id, from_claim_id, to_claim_id, kind, author_session_id, note, created_at, origin)
SELECT id, from_claim_id, to_claim_id, kind, author_session_id, note, created_at, 'restored'
FROM claim_edges_removed r
WHERE r.removed_by_pass = '<pass id>'
  AND EXISTS (SELECT 1 FROM claims c WHERE c.id = r.from_claim_id)
  AND EXISTS (SELECT 1 FROM claims c WHERE c.id = r.to_claim_id)
  AND EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = r.author_session_id)
ON CONFLICT DO NOTHING;
```

To restore a single link, add `AND r.id = '<edge id>'`. A restored link carries origin `restored`, which the cleanup never matches, so later starts leave it in place. A link whose claim or session no longer exists is skipped.

## Un-landing contexts a base-ancestry stamp got wrong

Before 2026-10-07 a teammate's landed report stamped every open work context whose base commit was an ancestor of the default branch, including ones whose base was already there when their session started — a worktree detached at an old main commit, a branch cut from main with nothing committed yet. Such a context reads *landed* and drops out of ghost checks and the conference while its session is still working. The hub no longer makes those stamps (`services/landed.ts`); this clears the ones an older hub made. It is opt-in and changes nothing unless told to:

```sh
# 1. Stop the hub, copy its data dir, and run against the COPY first.
cp -R /path/to/data /path/to/data-copy
# 2. Save the pilot report as it stands (see below).
crosscheck pilot --json > pilot-before.json
# 3. Dry run, both scopes: prints counts only — never an id, title, branch or sha.
bun packages/server/scripts/unland-false-landed.ts --data-dir /path/to/data-copy \
  --scope open --default-branch origin/main --git-dir /path/to/a/clone/of/the/repo \
  --stale-base <known stale commit>
bun packages/server/scripts/unland-false-landed.ts --data-dir /path/to/data-copy \
  --scope all --default-branch origin/main --git-dir /path/to/a/clone/of/the/repo
# 4. Only when the counts are what you expect, the same with --apply.
```

**Scope.** `--scope open` judges only contexts whose session is still open: those are the stamps hiding live work from ghost checks and the conference today. `--scope all` judges every landed context, ended sessions included. **A full apply breaks the pilot's "both landed" series**: the pilot report's collision proof counts a flagged collision as "both landed" by `landed_at`, and un-landing ended work changes that figure for windows already reported. Save `crosscheck pilot --json` first either way. On the pilot hub the decision is `--scope open` only, after a dry run on a copy. A dry run without `--scope` judges `all`; `--apply` refuses to run without a named scope.

A stamp is cleared when the evidence shows the base was already on the default branch at register: the connector said so, the session is on a detached HEAD, the session is ON the branch given to `--default-branch`, you named its base with `--stale-base` (repeatable), or the clone given to `--git-dir` dates the base (committer date) more than 24 hours before the session took it, for a session whose connector said nothing. Without `--default-branch` or `--git-dir` that rule is not judged, and the output says so. A context whose connector said its base was *not* on the default branch keeps its stamp. Opening the dir runs this version's bootstrap, as a hub start would.

## One hub process per data dir

Two hub processes on one `CROSSCHECK_DATA_DIR` are not supported, and neither is a script that opens the dir while the hub runs. Each PGlite process runs its own PostgreSQL, with its own buffer cache, over the dir, and takes no lock that another process would see, so two processes write over each other's pages. The start-up passes also assume they are the only writer: two hubs would run them at the same time over the same rows. The hub refuses a port that is already taken, but it cannot tell that another process holds its data dir. Run one hub per dir, and stop it before running SQL against the dir.

## Downgrading is not supported

Once a hub has run this version on a data dir, do not start an older version on it. The older version does not know `work_contexts.doc_version`. It goes on rebuilding search documents with drafts folded in, but it never touches the version column, so every document it writes stays stamped current. When you upgrade again, the start-up doc upgrade takes those documents for current ones and skips them, and the drafts' words stay searchable for good. (The older version also writes similarity links without the `origin` mark. The cleanup still recognises those by their note, authorship and the absence of a wire record.)

To go back, restore the data dir from a backup taken before the upgrade. If an older version has already run on an upgraded dir, stop it, mark every document for a rebuild (see "Running SQL against a hub's data dir" above), then start the current version:

```sql
-- after-a-downgrade
UPDATE work_contexts SET doc_version = 0;
```

On that start the doc upgrade rebuilds every document whose context holds a draft and stamps the rest current.

## Forcing a re-embed

With an embedder configured, every start re-embeds each work context that has no vector or a vector from another model. To force a context (or all of them) through it again, clear the vector and restart:

```sql
UPDATE work_contexts SET embedding = NULL WHERE id = '<work context id>';
```
