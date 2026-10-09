# Operating a hub

What an operator needs beyond the README's "run it": where the hub listens, what the hub does on its own at start-up, and how to undo what it did.

## Where the hub listens

`CROSSCHECK_LISTEN` is a comma list of IP addresses. The hub starts one listener per address, all on `PORT`. An entry must be an IP literal (`127.0.0.1`, `100.101.4.7`, `::1` or `[::1]`), never a hostname, so where the hub listens never depends on a DNS lookup. Entries are compared by address, not by spelling: `0:0:0:0:0:0:0:1` is `::1`. `0.0.0.0`, `::` and `::ffff:0.0.0.0` mean every interface and must stand alone. The list is checked before the database opens: an entry that is not an IP, an empty value, or an address no interface on this machine has stops the hub with a sentence naming it, and the data dir is not touched.

Before binding, the hub knocks at each address it will listen at: both loopbacks when unset, and every interface address for a wildcard or for the every-interface plan. Something already answering there stops it with `port N is already in use`. On macOS a second listener can otherwise bind over a foreign one and split the traffic.

Unset, the data dir decides, once, at the first start of a release that knows the setting (`hub_install` in `bootstrap.sql`):

- **A data dir this release creates** listens on loopback only: `127.0.0.1`, plus `::1` where the machine has it.
- **A data dir from an older hub** keeps listening on every interface, as it always did, so an upgrade cuts off no teammate. Every start logs `WARN listening on EVERY network interface` with the fix, and every member's `crosscheck doctor` prints `WARN hub listen` until it is set.
- **A dump of an older hub restored into a fresh data dir** is recorded as new, so it listens on loopback. Every start logs `WARN listening on loopback only` while the hub holds members created before its own install record. A file-level copy of a data dir keeps its old record and is not affected.

Pick one:

```sh
# teammates reach http://<tailnet IP>:7100 over the tailnet, nothing else does
CROSSCHECK_LISTEN=127.0.0.1,$(tailscale ip -4)

# teammates reach https://<host>.<tailnet>.ts.net through tailscale serve
CROSSCHECK_LISTEN=127.0.0.1
tailscale serve --bg 7100
```

In the Docker kit the hub must be told both settings, because a fresh containerised hub listens on the container's own loopback, where Caddy cannot reach it: `CROSSCHECK_LISTEN=0.0.0.0` inside the container, `CROSSCHECK_TRUSTED_PROXIES` set to the compose network, and `:7100` never published to the host. A hub started by launchd before `tailscaled` has its address refuses to start, loudly, so give the job `KeepAlive`.

**Forwarded headers.** `X-Forwarded-*` (and RFC 7239 `Forwarded`) count only from a trusted TCP peer: loopback, where `tailscale serve` and any proxy on the hub's machine connect from, or an entry of `CROSSCHECK_TRUSTED_PROXIES`, a comma list of addresses and CIDRs (`172.18.0.0/16` for the Docker kit's Caddy). From any other peer they are ignored, as if absent. The client's protocol comes from the first `X-Forwarded-Proto` value, or else from `proto=` in the first `Forwarded` element. A malformed entry, or one that trusts every peer (`0.0.0.0/0`, `::/0`, `::ffff:0:0/96`), stops the hub at start-up.

**Passkeys behind a proxy.** When `CROSSCHECK_WEBAUTHN_ORIGINS` lists an https origin, or a request arrives through a trusted proxy, the hub refuses every passkey ceremony at a `localhost` or loopback-IP origin (`localhost_origin_off`). Behind `tailscale serve` every request has a loopback peer, so "localhost only from loopback" no longer says "the hub's own machine". List only the https origin. The boot and `crosscheck doctor` warn while `localhost` is still listed beside it.

### Upgrading a 0.10 hub, the pilot's included

What to set in the hub's environment (for the pilot, `~/.crosscheck-hub/hub.env`), then restart the hub:

1. `CROSSCHECK_LISTEN=127.0.0.1,<the hub machine's tailnet IPv4>` if teammates' `hubUrl` is `http://<tailnet IP>:7100`, or `CROSSCHECK_LISTEN=127.0.0.1` if everyone uses the `tailscale serve` https address. A teammate whose `hubUrl` names a LAN address or a `.local` name loses the hub with either list: check `crosscheck status` on each machine first.
2. `CROSSCHECK_WEBAUTHN_ORIGINS=https://<host>.<tailnet>.ts.net`, without `http://localhost:7100`. A passkey enrolled at `localhost` stops working once an https origin is listed, so each person enrols one at the https address: the admin mints a code (`POST /api/developers/<id>/passkey-enrollments`), the person enrols at `/ui/passkeys`, and the new passkey waits its 24 hours. Fences already open stay open until their expiry. Artifacts already released stay released.
3. Nothing for `CROSSCHECK_TRUSTED_PROXIES`: `tailscale serve` connects from loopback.
4. After the restart, check what the hub really listens on. `lsof -nP -iTCP:7100 -sTCP:LISTEN` must show `127.0.0.1`, `[::1]` and the tailnet address, never `*:7100`. Until it does, the upgrade has not closed the exposure.

If nobody sets anything:

- The hub keeps listening on every interface on `:7100`, warns at every start, and every member's doctor warns. Nobody is cut off.
- `X-Forwarded-Proto` still counts from `tailscale serve`. From a LAN peer talking to `:7100` directly it no longer does, so that peer's login cookie is not `Secure`, and login still works.
- With an https origin listed, passkey prompts at `http://localhost:7100` are refused, so a person whose only passkey was enrolled at `localhost` can approve no waiver and release no artifact until they enrol at the https address. Without an https origin, a request through `tailscale serve` cannot use `localhost` either, and only the hub machine's own browser at `http://localhost:7100` can.
- Approving an artifact on `/ui/approvals` is a passkey ceremony now, and the old approve form post answers 403. Revoking a release still takes no passkey: the owner uses the plain button, and the operator can re-hide any release during the passkey gap with `POST /api/artifacts/<id>/withdraw` (admin token).

### Topic ids minted before this version

A topic's work-context id (`wc_<life>~t<hex>.<digits>`) used to carry `sha256(branch)`, so anybody who hashed the remote's branch names could tell which branch the topic was on, also for a developer who opted out of presence. Connectors of this version mint the id as an HMAC under a key that never leaves the developer's machine (`~/.crosscheck/sessions/topic-key`, created at the first topic). Nothing needs doing, and nothing is rewritten:

- **On the hub**, topics stored before the upgrade keep their ids, and those ids still hash back to their branch. An id is what every target, claim, question and delivery of the topic points at, and the owning connector may still send records under it, so rewriting it would split the topic in two. Knowledge on the hub is append-only, so nothing removes them either.
- **In a running session**, a topic it already opened keeps its id: ids are minted once and never re-derived, so its work goes on under the same context. Every topic opened after the connector upgrade gets a keyed id, a topic that a heal or a resume opens again in the next life included.

### What a presence opt-out hides now

Opting out hides who you are, where you work (branch, topic) and when (heartbeat, times); teammates still learn that someone is working on a file they touch right now. Before this version an opted-out developer's sessions were dropped from the tripwire and the ghost check entirely, so a teammate about to change the same file was told nothing, which is how the pilot's collision went unseen. Now:

- **The tripwire** answers one nameless row while an opted-out developer is live on the file. The teammate's agent and person read "a teammate is working on <file> right now — talk to your team before you change it"; the statusline counts "1 teammate". Several opted-out developers on one file are still one row.
- **The ghost check** answers a nameless count of the reader's own files an opted-out developer's unfinished work touches, shown in the briefing and to the person as "a teammate's work in progress also touches N of your files".
- Neither carries a name, developer or session id, branch, topic, work-context id, heartbeat or any other time. A developer the reader muted still raises nothing.
- Nameless is not unlinkable. The work contexts an opted-out developer publishes stay attributed in the briefing, with their creation age, as before. In a team of two, "a teammate" is therefore the other person.

`crosscheck presence`, `crosscheck presence off` and doctor print the first sentence above, so a person reads it before opting out. Nothing needs setting; it starts with the hub and connector upgrade.

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

**What it refuses to open.** `--data-dir` must already be a hub data dir (it carries `PG_VERSION`): PGlite would otherwise create a fresh, empty cluster at a typo and report nothing landed. A dir carrying `postmaster.pid` — which a running PGlite holds and removes on close — is refused unless `--force` says it is a copy taken while the hub ran. A flag-shaped value (`--data-dir --apply`) is refused rather than taken as a path, and `--git-dir` must be a git repository.

A stamp is cleared when the evidence shows the base was already on the default branch at register: the connector said so, the session is on a detached HEAD, the session is ON the branch given to `--default-branch`, you named its base with `--stale-base` (a full sha or a unique prefix of 7+ hex digits; repeatable), or the clone given to `--git-dir` dates the base (committer date) more than 24 hours before the session took it, for a session whose connector said nothing. Without `--default-branch` or `--git-dir` that rule is not judged, and the output says so. A context whose connector said its base was *not* on the default branch keeps its stamp — against a date and against `--stale-base` alike; only `--stale-base-override <sha>`, a separate flag on purpose, clears it. Opening the dir runs this version's bootstrap, as a hub start would.

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
