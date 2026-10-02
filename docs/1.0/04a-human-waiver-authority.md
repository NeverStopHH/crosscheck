# 04a — The human waiver authority: a passkey the agent cannot hold

*Status: design, decided by Nick 2026-09-30. Amends 04 §3.6 and answers 04 §10 D8.
Built on branch `feat/passkey-waiver-authority`; §11 records what the build found.*

## 1. What breaks today

A fence waiver lifts a `PROTECTED_CONFLICT` on a behaviour a human verified. The
route that grants one, `POST /api/fence-waivers`, takes `developerAuth` plus a
body-declared `presence: "controlling_terminal"`
(`packages/server/src/routes/fence-waivers.ts`). The bearer key that passes
`developerAuth` sits in plaintext in `~/.crosscheck/config.json`, on the same
machine and under the same OS user as the developer's agents. An agent that reads
the file can send the key and the literal, and the hub stamps the grant `human`.
That is principle 4's exact failure: *an agent cannot delete, weaken, or waive a
human-declared invariant* (00-cut-line.md AT-6). 04 shipped the gate as a
**detection** — explicit, attributable, rendered after the fact — and said so in
D8. This spec turns it into a **prevention**, and names what is still open.

## 2. The decision

Nick, 2026-09-30: *"agent credential → request waiver; human WebAuthn authority →
approve / amend / revoke. TOTP only as an explicitly temporary bridge."*

| credential | who holds it | may |
|---|---|---|
| api key | the developer **and every agent on their machine** | request a waiver; withdraw its own pending request; read |
| passkey | the person, behind their device's user verification | approve a request (as asked or amended), amend or revoke a live waiver, enrol a further passkey, revoke a passkey |

No route that changes whether a fence is open accepts the api key alone.

## 3. What a passkey proves, and what it does not

An approval carries a WebAuthn assertion: a signature over a hub-minted challenge
by a private key enrolled for developer D, with the authenticator's
user-verified (UV) flag set. On a platform authenticator (Touch ID, Windows Hello,
a phone) the private key stays in hardware the agent cannot read, and every
signature needs the person's gesture. That is the property this spec relies on.

**The hub cannot tell a hardware authenticator from a software one.** Passkeys
synced by Apple or Google carry no attestation, so the hub asks for none, and a
program can emulate an authenticator, UV flag included. The strength of the gate
therefore sits in **which credentials get enrolled** (§4). Everything after
enrolment is ordinary signature verification, done with `@simplewebauthn/server`
(MIT), never hand-rolled CBOR or COSE parsing.

## 4. Enrolment — the one place an agent could plant a credential

1. **A first passkey needs an enrolment code.** The admin mints one per developer
   (`POST /api/developers/:id/passkey-enrollments`, admin token): random, shown
   once, stored as a hash, valid 24 hours, single use. The admin hands it to the
   person out of band. The person signs in to the web UI, enters the code, and runs
   the WebAuthn registration ceremony at `/ui/passkeys`.
2. **A further passkey needs an assertion from an existing usable passkey** of the
   same developer. The api key never adds a credential on its own.
3. **Every enrolment is announced** where the person looks, not where the agent
   looks: `crosscheck status`, `crosscheck doctor`, the UI members page and feed —
   *"passkey 'MacBook' (authenticator: iCloud Keychain) enrolled for ken at T; it can
   approve waivers from T+24h. Not you? Revoke it at /ui/passkeys."* The
   authenticator name comes from the AAGUID when the authenticator sends one, and
   says *unknown authenticator* otherwise, which is what a software emulator
   usually sends. It is shown, never used as a gate.
4. **A new passkey cools off for 24 hours** (`PASSKEY_COOLOFF_HOURS`) before it can
   approve, amend or revoke anything. During the cool-off its owner (signed in with
   the api key) or the admin can revoke it. After the cool-off, revoking it needs a
   passkey assertion of the same developer, or the admin token. So a rogue
   enrolment is announced **before** it can act, not after.
5. **Recovery.** A lost device: the admin revokes its passkeys and mints a new code;
   the new passkey cools off like any other.

## 5. The ceremonies bind the exact terms

An approval signs **these terms**, not "some approval". For every ceremony the hub
mints a challenge for `(developer, purpose, subject, terms)`: purpose ∈ {enrol,
approve, amend, revoke_waiver, revoke_passkey}; subject is the request, waiver or
passkey id; terms are the pin, its version, the expiry and a hash of the reason as
displayed. The challenge is single use, lives five minutes, and is held in hub
memory only. A restart drops pending ceremonies, and nothing secret is at rest,
which is the same trade `ui/session.ts` makes for the cookie secret. The
verification step recomputes the terms from what is submitted. An expiry or reason
changed after the options were issued fails, as does a pin that moved to a new
version in between (04 §3.5: a waiver is granted against a version).

The usual WebAuthn checks all apply and are each tested: origin and RP ID, UV
required, challenge match and single use, a known credential belonging to the
signed-in developer, not revoked, past its cool-off, and a signature counter that
did not go backwards when the authenticator keeps one.

## 6. Requests, approvals, amendments, revocations

- **Request** (api key): `POST /api/waiver-requests {repo, pinId, pinVersion,
  reason, expiresAt}`. The hub checks the same rules a grant would — the pin
  exists in the repo, the version is current, the expiry is in the future and
  within `MAX_WAIVER_DAYS` — and stores a pending request. The fence stays
  closed. The answer names the approval page. The CLI front is `crosscheck pin
  --waive <pin-id> --expires <2d|12h|date> --reason "<why>"` (§11: built as a
  `pin` flag, and `--expires` rather than `--until`), which prints *"requested —
  the fence stays closed until a person approves it with a passkey at <url>"*.
  `POST /api/waiver-requests/:id/withdraw` lets the requester take it back.
- **Approve** (passkey, `/ui/waivers`): writes the `grant` row in the same
  transaction that marks the request approved. The approver may shorten the expiry
  or edit the reason before signing; the signed terms are what gets stored. Any
  member with a usable passkey may approve, the requester included. The gate is
  *a human did it*, not *a second human did it*; four eyes was weighed in 04 D8
  and rejected as a process cost for a three-person team.
- **Amend** a live waiver (passkey): a `revoke` row and a new `grant` row in one
  transaction, from one ceremony.
- **Revoke** a live waiver (passkey). An agent re-closing a fence would be
  harmless, but Nick's model gives the api key the request and nothing else, and
  that line is kept simple.
- **`POST /api/fence-waivers` and its `/revoke` refuse the api key** with one
  sentence naming the request route and the approval page. Nothing in the
  repository calls them today. The refusal keeps a curl from an older recipe from
  failing silently.

**Rows.** `fence_waivers` gains `authority` (`terminal` | `passkey`), plus
`credential_id` and `request_id`, both required when `authority = 'passkey'`
(check constraint). New tables: `passkeys`, `passkey_enrollments`,
`waiver_requests`. Every new table is registered in the retention registry.

**Waivers that already exist.** A `terminal` grant already live stays live until
its own expiry, at most 14 days. It is rendered as *opened from a terminal before
passkeys (weaker authority)*. No new `terminal` grant can be written.

## 7. Where the web UI must be reachable

WebAuthn needs a secure context. `http://localhost` is one, so the hub's own
machine works as is. A teammate reaching the hub at `http://100.x.y.z:7100` over
the tailnet is not, and the browser refuses the ceremony there. The supported path
is `tailscale serve` in front of the hub, which gives the hub an HTTPS origin like
`https://hub-host.tailnet.ts.net`. `CROSSCHECK_WEBAUTHN_ORIGINS` lists the
accepted origins, comma-separated, defaulting to `http://localhost:<PORT>`. Each
origin's hostname is its RP ID, and a passkey is bound to the RP ID it was enrolled
under, so a passkey enrolled on `localhost` does not work on the tailnet name. The
UI says that rather than failing obscurely.

## 8. What stays open, stated rather than hidden

1. **A software passkey enrolled with a stolen code.** An agent that obtains an
   enrolment code can enrol an emulated passkey: from a channel it can read, or by
   minting one with the admin token, which on the hub's own host sits in
   `~/.crosscheck-hub/hub.env` under the same OS user. That enrolment is announced
   and cannot act for 24 hours. For members on other machines the admin token is
   out of reach, and enrolment needs the code.
2. **A person who approves without reading** has still approved. The ceremony page
   shows the pin, the version, the expiry, the reason and who requested it, and
   cannot make anyone read them.
3. **No TOTP.** Nick allowed it only as a temporary bridge. It is not built while
   every member can reach the UI over HTTPS (§7). If one cannot, the bridge would
   carry the same enrolment code and cool-off, and doctor would name it as
   temporary.
4. **AT-6 after this spec.** The grant path is no longer reachable with the agent
   credential alone. Enrolment stays reachable for an agent on the hub host,
   behind the code, the announcement and the cool-off. AT-6 moves from *detection*
   to *prevention with one stated residue*, and the README row says so.

## 9. Acceptance tests

Each names the mutation that must turn its guard red, anchored in
`connector-core/scripts/mutation-check.ts`. A test helper emulates an authenticator
with a P-256 key — the exact capability §8.1 names, used here to prove the
verification, not to bypass it.

- **PK-1** An api key cannot open a fence: `POST /api/fence-waivers` with key and
  presence → refused, no row. *Mutation:* restore the old grant path.
- **PK-2** A request leaves the fence closed: request → verdict still
  `PROTECTED_CONFLICT`, request listed pending. *Mutation:* write a grant on request.
- **PK-3** An approval with a valid assertion opens it: the grant row carries
  `authority = passkey`, the credential and the request. *Mutation:* skip the
  signature check.
- **PK-4** The signed terms are the stored terms: options for expiry E, a submission
  with E′ → refused. *Mutation:* drop the terms from the challenge binding.
- **PK-5** A challenge is single use: a replayed assertion → refused. *Mutation:*
  do not consume the challenge.
- **PK-6** UV is required: an assertion without the UV flag → refused.
  *Mutation:* `requireUserVerification: false`.
- **PK-7** Cool-off: a passkey enrolled less than 24 hours ago cannot approve.
  *Mutation:* compare against `created_at` instead of `usable_from`.
- **PK-8** A first passkey needs a valid, unused, unexpired code; a second passkey
  needs an assertion by the first. *Mutation:* accept a used code.
- **PK-9** Another developer's passkey, a revoked passkey, a wrong origin → refused.
  *Mutation:* drop the owner check.
- **PK-10** An enrolment is announced on `status` and `doctor`, with the
  authenticator name or *unknown authenticator*. *Mutation:* filter out
  enrolments in cool-off.
- **PK-11** A legacy `terminal` grant still holds until its expiry and renders as
  weaker authority. *Mutation:* treat legacy grants as passkey grants in the render.
- **PK-12** A request against a moved pin version cannot be approved. *Mutation:*
  approve against the current version.

## 10. Defaults taken, for Nick to overturn

- Cool-off 24 hours. Enrolment code valid 24 hours, single use.
- Any member with a usable passkey may approve, including the requester.
- Revoking a waiver needs a passkey too. Withdrawing one's own request does not.
- No attestation is required, and none is used as a gate; the AAGUID name is shown
  only.

## 11. What the build found (2026-10-01)

*Appended, never inserted: §1–§10 are cited by number.* Built on
`feat/passkey-waiver-authority`. PK-1 to PK-12 each have a test, and each has
a mutation anchor in `connector-core/scripts/mutation-check.ts` (19 anchors in
all, every one `caught`).

**Where this spec was wrong, and what was done instead:**

1. **§6 said every new table is registered in the retention registry.** The
   registry (`services/retention-registry.ts`) lists the relations that reference
   a *session*. None of `passkeys`, `passkey_enrollments` or `waiver_requests`
   does, so none belongs there; the CSK-12 foreign-key walk has nothing to find.
2. **§6 had `crosscheck pin waive` print the approval URL the hub sends.** The
   render-surface registry flagged that as hub-chosen text printed for an agent
   to follow, which is an instruction channel. The CLI builds the URL itself from
   the configured hub URL and a fixed path, and never prints the hub's
   `approvePath` (`cli/pin-render.ts`).
3. **§6 named the command `crosscheck pin waive … --until`.** It is built as a
   `pin` flag, `--waive`, next to `--broke` and `--ok`, and the expiry flag is
   `--expires`. `--until` is a git time flag, and CCB-2
   (`staleness-axis.test.ts`) keeps every src module free of those so that
   staleness has one definition. Allowing it in `pin.ts` would have blinded
   that guard for the whole file.

**What the build added that the spec did not name:**

- **`fence_waivers.credential_id` is a foreign key** to `passkeys.credential_id`.
  It sits on top of the CHECK, so a grant cannot name a device that was never
  enrolled. The drizzle column `authority` has no default, which makes
  forgetting it a compile error; the database default `'terminal'` only labels
  rows written before 04a.
- **The terms sit inside the challenge** (`nonce ‖ SHA-256(purpose, subject,
  terms)`), so PK-4 is enforced by the signature check itself, not by a second
  comparison that could be dropped.
- **An approval may shorten the asked-for expiry, never lengthen it**
  (`expiry_beyond_request`), and a fence has at most one pending request
  (`already_requested`).
- **The cool-off outlives the UI session.** A session lasts 12 hours and a
  cool-off lasts 24, so a person who enrols logs in again the next day before
  approving. That is the intended order.
- **Doctor counts and `status` names.** Doctor's registration promises no
  foreign text, so its passkey check counts enrolments that are cooling off and
  points to `crosscheck status`. Status names who enrolled, the device and the
  authenticator, each through `bareUntrusted`.
- **Two pages run JavaScript, and only these two.** `/ui/passkeys` and
  `/ui/waivers` replace the UI's `default-src 'none'` with `script-src 'self';
  connect-src 'self'` and load a single same-origin script
  (`ui/passkey-script.ts`). Every other page stays script-free, which is tested
  and anchored.
- **`CROSSCHECK_WEBAUTHN_ORIGINS` is checked at startup.** An `http` origin that
  is not `localhost` stops the hub with a pointer to `tailscale serve`. Without
  that check, every browser would refuse the ceremony later, in front of a
  person, and nothing would say why.

**Not built, as §8 and §10 left it:** TOTP; an admin page for minting codes (the
API and a curl line are documented in the README); a notification to the
approver when a request arrives (requests show on `/ui/waivers` and in
`crosscheck pin list`).

## 12. What the security review found (2026-10-01)

*Appended, never inserted.* An adversarial review of the branch, with probes
against an in-memory hub. It found no path by which the api key alone, or the
api key plus a UI session, writes a grant or revocation, enrols a passkey,
shortens the cool-off, or gets a signature accepted under other terms. What it
did find is below: first what was fixed, then what stays open and why.

**Fixed:**

1. **Two live grants on one fence** (5327f79). `requestWaiver` checked only for a
   pending request, and `approveRequest` never checked for a live waiver. An
   approval of one hour beside an earlier fourteen-day grant left the long one
   running. Closing the visible grant then said "shut again" while the fence
   read open. Now a request or an approval that meets an open fence is refused
   with `fence_open`; its terms change by amending. The approval checks inside
   its own transaction. Closing reads the fence back and says STILL OPEN when
   another grant holds it, which covers a 0.10 terminal grant.
2. **The api key could fill every prompt slot** (5d080d2). The agent and the
   person are the same developer, and minting a revoke or `authorise_enrolment`
   ceremony needs no gesture. Eight minted prompts locked the person out of
   closing a fence. Ceremonies now belong to the browser session that minted
   them (keyed by a digest of the session token). Neither cap refuses any more:
   - a session at its cap of 4 evicts its own oldest prompt;
   - a developer at its cap of 16 evicts the oldest prompt of the *other*
     session that holds the most;
   - only the hub-wide cap of 1024 refuses.

   Another session can neither finish nor spend the person's prompt.
3. **A refused verify left its ceremony standing** (5d080d2). The route refused
   "credential cannot sign here" before `take()`. It now spends the ceremony
   with `discard`, so §5's "single use, even on failure" holds there too. One
   refinement: a caller that does not own the ceremony cannot spend it.
4. **`crossOrigin: true` without `topOrigin` was accepted** by the library
   (5d080d2). The hub now refuses it; a ceremony only ever runs on the hub's own
   page.
5. **IP-literal origins passed the startup check** (5d080d2), although browsers
   refuse an IP address as an RP ID. They now stop the hub at startup, with what
   to use instead.
6. **A `localhost` origin was believed from any machine** (5d080d2). A localhost
   passkey syncs to the person's other devices. An agent on one of them could
   serve its own `http://localhost:<port>` page, collect the person's touch, and
   post the assertion to the hub across the tailnet. A `localhost` origin is now
   accepted only from a loopback peer (Bun's `requestIP`, `http/peer.ts`). An
   unknown peer counts as not loopback.
7. **Hub text reached the agent's terminal raw on `pin --waive`** (d392f33). The
   failure sentence is now bounded the way doctor's `hubSaid` bounds it. Waiver
   and request expiries on `pin list` and `status` are re-serialised by the CLI,
   and an unreadable one prints as such.
8. **The self-reported AAGUID was announced as fact** (8675882). It now reads
   *says it is iCloud Keychain, unverified*. The sign counter is only ever
   raised (`GREATEST`), and `enrolled_via`, `revoked_by_kind` and `sign_count`
   are constrained in both DDL sources.
9. **The announcement was a truncated page** (086aec6). The hub listed 20
   enrolments, and doctor counted cooling-off ones within that page. The hub now
   counts the whole window (`enrolmentsTotal`, `coolingOff`), and status prints
   "and N more". A hub that does not answer is a WARN, not a PASS; a 404 reads
   as a hub that predates passkeys.
10. **§4.3's UI announcement was never built** (6cbc17b). It is built on
    `/ui/passkeys` rather than the members page and feed: every member sees
    every enrolment of the window there. The hub serves this page itself, so it
    reaches the person's browser without passing through a CLI that runs beside
    the agent and reads a hub URL the agent can rewrite.
11. **Two pins with the same surface looked identical on the approval card**
    (9c58753). The cards now name the pin id.

Each fix has a mutation anchor in `connector-core/scripts/mutation-check.ts`:
21 new ones, plus 4 repaired whose source text the fixes had moved. All 25 are
`caught`.

**Open, stated rather than hidden** (this corrects §8.1 and §8.4, which
understated it):

1. **On the hub's own host, nothing in this spec holds.** The hub runs as the
   developer's OS user. The PGlite data directory and `hub.env` are readable by
   anything running as that user. An agent there can stop the hub and write
   rows directly: the database accepts a passkey row with `usable_from =
   created_at` and a grant whose `authority` defaults to `terminal`. Database
   constraints are correctness, not a boundary, against whoever can write the
   database. So AT-6 is a **prevention for members on other machines**, and on
   the hub host it is no gate at all. The remedy is operational: run the hub
   under its own OS user, in a container, or on its own machine.
2. **On the hub host, `http://localhost` is not a unique origin.** In the
   review's probe, a second process of the same user bound `[::1]:<port>` while
   the hub listened on IPv4. A browser that tries `::1` first then reaches the
   impostor page, which can hand the hub's challenge (minted for the agent's
   own request) to `navigator.credentials.get`. The person's Touch ID prompt
   says only "localhost". **A passkey gesture shows no terms**: whoever controls
   a page at an accepted origin gets a signature over their own terms. Item 6
   above closes the remote variant. The local one is a case of 1. Two things
   help on the hub host:
   - list only the `https` tailnet origin in `CROSSCHECK_WEBAUTHN_ORIGINS`
     there, and drop `localhost`;
   - rely on the fact that every approval is visible afterwards: an open fence
     shows on every member's `status` (count and next expiry) and on `pin list`
     (who approved, with which authority).
3. **An agent with many UI sessions can still contend for prompt slots.** Item 2
   above makes that slower, never a signature. It fails closed, and the admin
   token can still act.
4. **Enrolment lockout.** During the cool-off the api key may revoke a cooling
   passkey (§4.4), so it can keep revoking every passkey the person enrols. It
   fails closed and is by design; the admin then enrols the person.
5. **Revoking a passkey leaves open the fences it opened.** They run out on their
   own expiry (at most `MAX_WAIVER_DAYS`) or are closed on `/ui/waivers`. They
   are not closed automatically because an admin revocation has no authority to
   write a closure under: `fence_waivers` records `passkey` or `terminal` only.
   That is a decision for Nick (D-PK-1 below).
   **Closed: decided by Nick 2026-10-02 and built** — revoking a passkey now
   closes them at once (D-PK-1 below).
6. **`status` and `doctor` run beside the agent.** The `hubUrl` they read is in
   an agent-writable config. Teammates' terminals and the hub's own
   `/ui/passkeys` are the independent channels (item 10).

**D-PK-1, for Nick:** should revoking a passkey close every live grant it
signed? The safe direction is yes. It needs either a third authority value
(`admin`) for closures written by the admin token, or closures by a passkey
revocation only.

**D-PK-1, decided by Nick 2026-10-02: yes, on every revocation path. Built.**
Nick's record: *waiver terminated, reason: authorizing_credential_revoked,
closed_by: admin/system*.

- **The record.** A third authority, `system`, valid only on a closure the hub
  writes (`@crosscheck/schema` `SYSTEM_WAIVER_AUTHORITY`). Each termination is a
  new `revoke` row superseding the grant, with reason
  `authorizing_credential_revoked`, the revoked credential in `credential_id`,
  and `granted_by` null: no person wrote it. Who revoked the passkey (owner,
  another passkey, the admin) stays on the passkey's own row
  (`revoked_by_kind`), reachable through the credential, so the closure row does
  not repeat it. The grant is never deleted or edited. `capture_mode` is `auto`.
- **The CHECK.** `fence_waivers_authority_check` now reads: `terminal` with a
  person; `passkey` with a credential and a person; `system` only as a `revoke`
  with a credential, no person and that one reason. It is in drizzle
  (`db/schema.ts`) and in `bootstrap.sql`, where a guarded block replaces an
  existing hub's two-authority CHECK once (it looks for the reason in
  `pg_get_constraintdef`) and leaves the constraint alone on every later
  start. `granted_by` lost its `NOT NULL` (an `ALTER … DROP NOT NULL` for hubs
  that have the table); the CHECK is what keeps a person's row from being
  written without a person. `ddl-sync.test.ts` covers both sources, the upgrade
  of an old hub, the restart and the refusals.
- **The write.** `revokePasskey` (`services/passkeys.ts`) is the one writer of
  a revocation for all three paths — the owner during the cool-off
  (`/ui/passkeys/:id/revoke`), a passkey ceremony (`revoke_passkey`) and the
  admin (`POST /api/developers/:id/passkeys/:passkeyId/revoke`). It now runs in
  one transaction and, after marking the passkey revoked, calls
  `terminateWaiversSignedBy` (`services/waiver-terminations.ts`): every grant
  that credential signed which is unexpired and not yet superseded gets its
  closure row, on any pin version. A closure the database refuses rolls the
  revocation back. An owner's cool-off revocation normally finds no grant (a
  cooling passkey cannot approve), and runs the same code.
- **The surfaces.** The pin registry and the verdict carry `closedWaiver` (the
  grant id, when it closed, when the grant would have run out, the reason word)
  until the grant's own expiry; after that the closure changes nothing and
  stays in the record only. `crosscheck pin list` and the verdict block print
  *waiver … CLOSED by the hub … — the passkey that approved it was revoked; it
  would have held until …*; `status` counts them; `/ui/waivers` lists them
  under *Closed because the passkey that approved them was revoked*;
  `GET /api/fence-waivers` lists the closure row with authority `system` and
  `grantedByName` null. The admin's answer carries `terminatedWaivers`, and the
  ceremony says how many open waivers closed with the passkey. The client never
  prints the reason word: it maps the one it knows and prints a fixed sentence
  for any other.
- **The wire.** A live waiver accepts only `terminal` or `passkey`
  (`WAIVER_GRANT_AUTHORITIES`); `system` or any unknown value reads as
  `terminal`, the weaker kind, never as passkey. An unreadable closure is
  dropped on its own; it never costs the pin or the verdict.
- **Not built.** `doctor` prints no waivers and still does not. An old CLI
  against this hub ignores `closedWaiver` and shows the fence as closed without
  the reason, which is the pre-D-PK-1 reading, never an open fence.

Tests: server `passkey-revocation-terminates`, `waiver-closure-surfaces`,
`ui-passkeys` (D-PK-1), `ddl-sync` (three cases); cli `waiver-render` (D-PK-1),
`verdict-render`, `passkey-revocation-cli`; core `verdict-wire`. Each guard has
an anchor at the tail of `connector-core/scripts/mutation-check.ts`, every one
`caught`.
