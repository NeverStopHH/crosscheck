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
  waive <pin-id> --until <date|Nd> --reason "<why>"`, which prints *"requested —
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

## 11. What the build found

*Appended when built.*
