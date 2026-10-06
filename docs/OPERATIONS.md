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

A hub on Postgres (`DATABASE_URL`) takes the same SQL through `psql`.

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

## Forcing a re-embed

With an embedder configured, every start re-embeds each work context that has no vector or a vector from another model. To force a context (or all of them) through it again, clear the vector and restart:

```sql
UPDATE work_contexts SET embedding = NULL WHERE id = '<work context id>';
```
