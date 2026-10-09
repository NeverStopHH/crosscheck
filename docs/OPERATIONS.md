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

## Passkeys, drafts and a lost device

Since 0.11 a key only drafts a person's judgements and settings: labels, ratings, pins, breaks, mutes and switching presence back on. Nothing counts, protects or changes until the person confirms it on `/ui/confirm` with a passkey (`crosscheck confirm` opens the page). Switching presence off is immediate. A new passkey waits 24 hours (its cool-off). What it confirms takes effect at once and counts in the figures from the moment the cool-off ends.

A passkey is revoked for one of two reasons:

- **retired**: the device is lost, replaced, or the hub moved to a new https name. Everything the passkey confirmed while it stood keeps counting. This is the default, and it is the only reason the operator's admin token can give.
- **compromised**: someone else may have used it. Only its owner can say so, on `/ui/passkeys` ("Revoke with another passkey", reason "compromised"), signed with another of their passkeys that is past its cool-off. Everything it confirmed is retracted. Those drafts return to the confirm page marked "re-confirm", its effects are undone (a break it recorded is disarmed, presence it switched on is off again, mutes it changed are reverted, a pin it created protects nothing), and each closed month keeps its figures with a correction line beneath them.

A passkey revoked during its cool-off, for either reason and by anyone, never counted. Its drafts return to the confirm page marked "re-confirm: the passkey that confirmed these was revoked before it counted", its effects are undone, and the person confirms them again with another passkey. Nothing is lost.

### When someone loses a device

The person tells the hub's operator, the holder of the admin token. The operator retires the passkey, which keeps the person's record:

```sh
# 1. the person's developer id
curl -s -H "Authorization: Bearer $CROSSCHECK_ADMIN_TOKEN" https://<hub>/api/developers
# 2. their passkeys, with labels and when each was created and last used
curl -s -H "Authorization: Bearer $CROSSCHECK_ADMIN_TOKEN" https://<hub>/api/developers/<developer-id>/passkeys
# 3. retire the lost one: what it confirmed keeps counting
curl -s -X POST -H "Authorization: Bearer $CROSSCHECK_ADMIN_TOKEN" https://<hub>/api/developers/<developer-id>/passkeys/<passkey-id>/revoke
# 4. a code for the replacement, which the person enrols on /ui/passkeys
curl -s -X POST -H "Authorization: Bearer $CROSSCHECK_ADMIN_TOKEN" https://<hub>/api/developers/<developer-id>/passkey-enrollments
```

The person can also retire it themselves on `/ui/passkeys` with another passkey. If the device may have been used by someone else, the person declares it compromised there instead. A person with no other passkey has the operator retire it at once, which stops it signing, and then declares it compromised with the replacement once that passkey's cool-off ends. A retired passkey can still be declared compromised later.

### Refusing writes from clients older than 0.11

A 0.10 CLI says "recorded" over what the hub now only drafts, because it predates drafts and sends no version. With `CROSSCHECK_REFUSE_PRE_011_DRAFTS=1` in the hub's environment, the doors that draft (labels, ratings, pins, breaks, mutes and unmutes, presence back on) refuse a request without the `X-Crosscheck-Client` header that 0.11 clients send, or with an older version in it. The refusal is a sentence the 0.10 CLI prints as it is: upgrade crosscheck, nothing was recorded. Reads and switching presence off are never refused.

This is not a security control. Any program can send the header. It only stops a 0.10 client from telling its user that something was recorded when it was only drafted. Unset, or `0`, the hub accepts every client as before. Any other value stops the hub at start-up.

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

## Running the hub under its own user

A hub that runs as your OS user, for example from a LaunchAgent in `~/Library/LaunchAgents`, is reachable by every coding agent you start. Such an agent can read `ADMIN_TOKEN` from `hub.env`, change the hub's database, and change the hub's code. The rule is **agent credential ≠ operator authority**: the hub's data, its token and its code belong to an OS user that no agent runs as.

A separate macOS user is not a VM. Anyone with admin rights or root still gets in. It is a cheap step that keeps your own agents out, and a service account, a container or a VM is the stronger one.

**Before you start.** The steps need `sudo`, so no agent can run them for you. Run them in a terminal window where no agent runs, because an agent in the same terminal can reuse sudo's cached credentials for several minutes. End with `sudo -k`. If the hub's address changes (to an https `tailscale serve` front, say), every member logs in again, because keys are bound to the address they were issued for.

The steps, on macOS, with `crosscheck-hub` as the user's name:

1. **Create the user**, hidden and with no login shell:
   ```sh
   sudo sysadminctl -addUser crosscheck-hub -fullName "Crosscheck Hub" -shell /usr/bin/false -password -
   sudo dscl . -create /Users/crosscheck-hub IsHidden 1
   sudo createhomedir -c -u crosscheck-hub
   sudo chmod 700 /Users/crosscheck-hub
   ```
   Give it a long random password. You never need it again.
2. **Install Bun and the hub as that user**, so that both belong to it and you cannot write them:
   ```sh
   sudo -u crosscheck-hub -H bash -c 'curl -fsSL https://bun.sh/install | bash'
   sudo -u crosscheck-hub -H /Users/crosscheck-hub/.bun/bin/bun add -g crosscheck-hub@<version>
   ```
3. **Stop the old hub**: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.crosscheck.hub.plist`. Then `lsof -nP -iTCP:7100 -sTCP:LISTEN` must print nothing.
4. **Move the data**: the data dir, its state dir if your hub has one, every backup, and `hub.env`. Copy them with `sudo ditto` into `/Users/crosscheck-hub/.crosscheck-hub`, then `sudo chown -R crosscheck-hub:staff` and `sudo chmod -R go-rwx` that directory.
5. **Edit the hub user's `hub.env`** with `sudo -u crosscheck-hub -H nano …`. Point `CROSSCHECK_DATA_DIR` at the moved data dir. Behind `tailscale serve`, set `CROSSCHECK_LISTEN=127.0.0.1` and list only the https origin in `CROSSCHECK_WEBAUTHN_ORIGINS`. **Set a new `ADMIN_TOKEN`** (`openssl rand -hex 32`): the old one sat in your home and counts as known. Write it straight into the file, store it nowhere else, and never paste it into an agent's window.
6. **Run the hub as a system LaunchDaemon under that user.** Create `/Library/LaunchDaemons/com.crosscheck.hub.plist`. Set `UserName` to `crosscheck-hub` and `HOME` to `/Users/crosscheck-hub`. The program is `/bin/sh -c 'set -a; . <hub home>/hub.env; set +a; exec <hub user's bun> <its crosscheck-hub>/packages/server/src/index.ts'`, with `RunAtLoad` and `KeepAlive` on and the logs in the hub user's home. Then run `sudo chown root:wheel` and `sudo chmod 644` on it, and `sudo launchctl bootstrap system <plist>`.
7. **Optionally, add https through Tailscale**: `tailscale serve --bg 7100`. MagicDNS and HTTPS certificates must be on in the tailnet.
8. **Check the result.** `sudo lsof -nP -iTCP:7100 -sTCP:LISTEN` shows `crosscheck-hub` as the user. Without `sudo`, lsof lists only your own sockets and shows nothing. `cat /Users/crosscheck-hub/.crosscheck-hub/hub.env` as yourself answers `Permission denied`. `crosscheck doctor` passes the lines below.
9. **Clean up your home**, once the new hub runs. Delete `~/Library/LaunchAgents/com.crosscheck.hub.plist`. Delete `~/.crosscheck-hub`: it holds the old token, the old database and `trial-keys.txt`. Every key listed in `trial-keys.txt` was readable by your agents, so reissue or revoke it. Then run `sudo -k`.

From then on the token lives only with the hub user. For an operator action, read it in a terminal with no agent, using `sudo -u crosscheck-hub -H cat /Users/crosscheck-hub/.crosscheck-hub/hub.env`, then run `sudo -k`. Backups run as the hub user and land in its home.

### What `crosscheck doctor` checks

Doctor runs as you, so it checks what your user can reach. It never opens `hub.env`, and it prints no file's contents and no secret.

| Line | FAIL / WARN when | PASS when |
|---|---|---|
| `operator token` | FAIL: `~/.crosscheck-hub/hub.env` is readable or writable by you, or belongs to you (mode 600 included), or `ADMIN_TOKEN` is set in your shell. | there is no `hub.env` there, or you cannot read it. |
| `hub state` | WARN: anything else in `~/.crosscheck-hub` (data dir, state dir, backups, `trial-keys.txt`, logs) or the dirs that `CROSSCHECK_DATA_DIR` / `CROSSCHECK_STATE_DIR` name in your environment is readable or writable by you, or belongs to you. | none of it is. |
| `hub process` | WARN: the process listening for your hub runs as your uid. | the hub's `bun` runs as another user. |
| `hub LaunchAgent` | WARN: `~/Library/LaunchAgents/com.crosscheck.hub.plist` exists (macOS only). | there is none. |

`hub process` judges only a hub on this machine: a loopback address, one of this machine's own addresses (its tailnet IP among them), or an https `tailscale serve` front, which doctor follows to the loopback port behind it. Everything else is `SKIP`, counted as "not checked" in the summary and never PASS. That covers a hub elsewhere (`not checked here: the hub runs elsewhere`), a name that does not resolve, an https front with no `tailscale serve` mapping, a listener that is not the hub's `bun` (a proxy), and a probe that failed or ran out of time. Without root, lsof sees only your own sockets, so on macOS doctor names another user's listener with `netstat -anv` and `ps`. On Linux, a hub under another user reads as "not checked".
