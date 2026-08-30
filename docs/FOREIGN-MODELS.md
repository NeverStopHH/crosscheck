# Running crosscheck's inference on a model that is not Claude

crosscheck's Tier-1 machinery — the draft summarizer, the derived session
intent, the ghost check and `crosscheck conference` — calls a model. By
default that is headless `claude -p` on a Haiku-class model, riding the Claude
Code auth you already have, so there is no second API key and no new bill.

One environment variable replaces that binary with one of yours.

**This page answers two questions and keeps them apart.** What you must set,
which is exact and tested. And what is guaranteed once you have, which is
narrower than people expect — read [What is *not* guaranteed](#what-is-not-guaranteed)
before you rely on this.

---

## The short version

```sh
export CROSSCHECK_SUMMARIZER_CMD=/absolute/path/to/your-wrapper
```

`your-wrapper` is any executable that:

1. is spawned with **no arguments at all**,
2. reads its **input on stdin** (for the summarizer, one turn's slice),
3. writes **one answer on stdout**,
4. **exits 0**.

That is the entire contract. A working example is checked in at
[`docs/examples/foreign-model-wrapper.sh`](examples/foreign-model-wrapper.sh)
— about twenty lines of `sh`, `curl` and `jq` against an OpenAI-compatible
chat-completions endpoint — and a test drives that exact file through the real
worker on every machine where `jq` is installed.

Then check it:

```
$ crosscheck doctor
PASS  summarizer runner  answered NONE in 0 s
```

---

## What crosscheck guarantees it will do

Every statement in this section is pinned by
`packages/connector-claude/test/foreign-model.test.ts`, which drives a fake
foreign binary from a transcript byte to a spool line to a hub with nothing
stubbed in between.

### The spawn

| | |
|---|---|
| **argv** | exactly `[your-wrapper]`. No `-p`, no prompt, no flag is ever spliced on. The override replaces the binary **wholesale**. |
| **stdin** | the slice, and nothing else. |
| **stdout** | read to at most **16384 bytes**; past that the stream is cancelled, not buffered. |
| **stderr** | never read, never stored (the one exception is `crosscheck doctor`, where a human is reading). |
| **exit code** | `0` means the answer is on stdout. Anything else is a booked failure. |
| **deadline** | **60 s**, then `SIGTERM`, then `SIGKILL` 1 s later. Override with `CROSSCHECK_SUMMARIZER_TIMEOUT_MS`. |
| **cwd** | a neutral directory under the crosscheck home — never your repo, so no `CLAUDE.md`, `AGENTS.md` or tooling config rides into the call. |

### The environment your wrapper inherits

The environment of the process that spawned it, **minus**:

- `CROSSCHECK_API_KEY` — your hub key. The wrapper has no business with the
  hub, so the key stops at the spawn.
- the parent agent session's binding variables (`CLAUDECODE`,
  `CLAUDE_CODE_SESSION_ID`, the messaging socket and token, the SSE port,
  `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_*`, and the rest of that family).

…and **plus** `CROSSCHECK_SUMMARIZER_CHILD=1`, which makes every crosscheck
hook reached from inside the call exit silently — so a wrapper that itself
shells out to an agent cannot make crosscheck fire itself.

Everything auth-shaped **passes through untouched**: `ANTHROPIC_API_KEY`,
`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, the Bedrock and Vertex knobs,
`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`. A denylist that swept `CLAUDE_` or
`ANTHROPIC_` wholesale would log the model out.

### How the path is resolved

There is **no shell**. The value is an executable, not a command line.
Measured on this repo:

| `CROSSCHECK_SUMMARIZER_CMD` | result |
|---|---|
| `/abs/path/to/wrapper` | ✅ runs |
| `wrapper` (a bare name on `PATH`) | ✅ runs |
| `wrapper` (not on `PATH`) | ❌ `Executable not found in $PATH` |
| `~/bin/wrapper` | ❌ `~` is **not** expanded — no shell is involved |
| `python3 /path/wrapper.py` | ❌ the whole string is treated as one filename |

If you need an interpreter, put the shebang in the script and make it
executable. If you need arguments, bake them into the wrapper.

### The answer contract

Answer with **either** a claim object **or** the literal `NONE`.

```json
{"kind": "root_cause", "body": "one sentence, max 400 characters", "confidence": 0.4}
```

`kind` is one of `observation`, `hypothesis`, `evidence`, `root_cause`,
`decision`, `rejected_approach`. `confidence` is optional and defaults to
`0.3`.

**`NONE` is the usual and correct answer.** The prompt asks for a conclusion a
teammate would act on; most turns do not contain one, and a model that finds
one every time is a model filling your team's hub with noise.

The parse is deliberately tolerant of how chat models package things. All of
these are read correctly:

- a preamble — `Sure! I read the slice carefully.\n\nNONE`
- a markdown fence around the answer, with or without a language tag
- a visible reasoning block — `<think>…</think>` before the answer
- trailing chatter after a good answer, **including chatter containing braces**
- CRLF line endings
- `NONE`, `none`, `None.` — case, spacing and a stray full stop

Two tolerances worth stating explicitly, because they are safety properties
rather than conveniences:

- **A draft you rejected in your own scratchpad is never filed.** If you weigh
  a candidate claim inside `<think>` and then answer `NONE`, the answer is
  `NONE`. The scratchpad is not the answer.
- **An answer that contradicts itself resolves to `NONE`.** A claim followed by
  a bare `NONE` line drops the claim. Dropping a draft is the cheap direction.

### The trust fields, which you do not get to choose

Your model picks `kind`, `body` and (at most) `confidence`. Everything that
carries trust is stamped by crosscheck and cannot be influenced by anything
your wrapper prints:

- `provenance` is always `derived`
- `captureMode` is always `auto`
- `status` is always `proposed`
- `evidenceRefs` is always empty
- `confidence` is clamped to **0.5**, the derived cap

A model answering `{"confidence": 0.95, "provenance": "stated", "status":
"accepted"}` lands as `0.5`, `derived`, `proposed`. This is pinned both on the
spool file and on what a hub actually receives.

### Every failure is booked and visible

Nothing your model does can lose a run silently. Each of these has its own
counter, its own sentence, and its own remedy on `crosscheck status` and
`crosscheck doctor`:

| what happened | booked as | why it is its own outcome |
|---|---|---|
| binary missing, or won't start | **failure** | the remedy is the path or the file mode |
| non-zero exit | **failure**, with the exit code | the remedy is the wrapper |
| no answer before the deadline | **failure**, `timed out` | the remedy is the model or the deadline |
| exit 0, printed nothing | **unreadable** — *"the binary exited 0 and printed nothing"* | usually auth or plumbing inside the wrapper |
| exit 0, printed something unreadable | **unreadable** — *"the answer was neither claim JSON nor NONE"* | the model's output shape |
| a well-formed answer crosscheck refused | **refused**, with the class | role-play, an echo of the instruction, an echo of a teammate's hint, or a credential-shaped body |
| the model judged the turn empty | **NONE** | not a failure at all |

The two `unreadable` sentences are deliberately different: one sends you to
your wrapper, the other to your model. A refusal reason **never quotes the
body** — booked reasons are printed into terminals and often into an agent's
context, so a credential-shaped body is dropped *and* not echoed.

Real output, measured against the test fixture:

```
PASS  summarizer runner  answered NONE in 0 s
PASS  summarizer runner  answered in 0 s, not NONE: "I think the retry cap is what is going wrong here." (the runner works; that is model precision)
FAIL  summarizer runner  exit 0 with empty stdout in 0 s — run the argv by hand
FAIL  summarizer runner  could not start: ENOENT no such file or directory, posix_spawn '/nonexistent/ox-wrapper' — is claude on the PATH the hooks run with? (CROSSCHECK_SUMMARIZER_CMD overrides the binary)
```

`crosscheck doctor` costs one model call each time it runs.
`CROSSCHECK_DOCTOR_NO_PROBE=1` skips it.

### The gates run identically

A foreign model's answer goes through the same ordered pipeline as Claude's,
in the same order: parse → role-play refusal → instruction-echo refusal →
delivered-hint-echo refusal → secret scan → wire contract. Nothing is relaxed
for a foreign backend, and there is no per-backend way to relax it.

---

## What is *not* guaranteed

### No vendor's model has been tested. At all.

**No test in this repository has ever called a commercial model to do this
job**, and none of the work on this page involved one. The contract test
drives a **fake binary** that replays a corpus of answer shapes **authored for
the test** — a preamble, a fence, a `<think>` block, trailing chatter, CRLF,
an over-confident number. Those are ordinary habits of instruction-tuned chat
models in general; they are not recorded from a product, and they license no
claim about one. The example wrapper's own test posts to a stub on
`127.0.0.1`, whose "model" never even reads the slice.

(The hub has an unrelated OpenAI *embeddings* client for search — a different
component, a different key, and nothing to do with the model that writes
drafts.)

So: **the contract is proven; a model is not.** If someone asks "does
crosscheck support model X?", the honest answer is "crosscheck supports any
executable that meets the contract on this page, and here is the test that
proves the contract holds — whether model X is any *good* at this job is
something you measure on your own work, and nobody has."

### Precision is not guaranteed, and is the real risk

The four prompts were tuned on a Haiku-class Claude. A different model may:

- answer with a conclusion on every turn instead of `NONE`, filling your
  team's hub with drafts nobody wants;
- narrate the session (*"I'll add the retry cap and re-run the suite"*) instead
  of stating a conclusion — refused as role-play, but the fire is spent;
- hand the instruction back — refused as an echo, likewise spent;
- be subtly, confidently wrong in a way no gate can catch, because no gate
  judges whether a claim is *true*.

Only the last one is dangerous, and the controls for it are the ones you can
see on every surface: the draft is `proposed`, labelled `derived`, capped at
`0.5`, and a human reviews it. **Do not loosen any of those for a backend you
trust more.**

Watch `crosscheck status` for a week after switching. If drafts are landing
and nobody accepts them, your model is not suited to this and the honest move
is to switch back.

### One variable serves four different tasks

This is the sharpest limitation, and it is structural.

`CROSSCHECK_SUMMARIZER_CMD` is honoured by **four** callers — the summarizer,
the session intent, the ghost check, and `crosscheck conference` — and each
gives your wrapper an argv of exactly `[cmd]`. Your wrapper **cannot tell which
one fired**, because nothing on the argv, in the environment or on stdin says
so, and the four want four different answers:

| task | wants |
|---|---|
| summarizer | claim JSON, or `NONE` |
| session intent | one third-person sentence (≤ 120 chars), or `NONE` |
| ghost check | one conflict sentence (≤ 200 chars), or `NONE` |
| conference | its own report shape |

A wrapper with the summarizer's instruction hard-coded — like the example —
therefore gives the summarizer's instruction to all four. The other three will
mostly answer something the parse discards, which is **booked as `unreadable`
and visible**, not silent. But those fires are spent.

If you rely on derived intents or the ghost check, the current honest options
are: leave the default backend in place, or run the two lanes on different
machines. An argv-carrying override that would let one wrapper serve all four
is designed and **not built**; `packages/connector-core/test/model-seam.test.ts`
pins today's behaviour, so this section goes red the day that changes.

### Cost, quota and privacy are yours now

The default backend spends the developer's existing Claude Code quota. Point
it elsewhere and you are spending whatever your wrapper spends — crosscheck
prints a rough per-session estimate (`~N tokens (estimate)`, counting slice and
prompt at ~4 chars/token) and it is a spend *indicator*, not a bill. The
summarizer fires at most **6** times per session.

More importantly: **the slice is a piece of your coding session, and your
wrapper decides where it goes.** With the default backend it reaches the model
your agent is already talking to. With a wrapper it reaches whatever endpoint
you wrote down, under whatever terms that provider offers. crosscheck strips
the hub key and the session markers and runs from a neutral directory; the
summarizer's slice goes from the transcript straight to stdin and is never
written anywhere (the derived-intent prompt is the one exception in the
product: it is parked in a `0600` file the worker unlinks as its first act).
Everything after `curl` is your call.

### Not guaranteed to keep working

Your provider can change a response shape and your wrapper starts returning
something unreadable. That degrades **visibly** — `unreadable` counts climb,
`crosscheck doctor` WARNs and names the model rather than the runner — but
capture is quietly worse until someone looks. Deterministic capture (everything
published over MCP) is unaffected either way: it never involves a model.

---

## The other two lanes

**Point the default backend at another endpoint.** `ANTHROPIC_BASE_URL` and
the other auth variables pass through the spawn untouched, so a provider
offering an Anthropic-compatible endpoint can be used with **no wrapper and no
code change** — set the base URL your Claude Code install already honours.
Everything on this page about the answer contract still applies. This lane is
documented, not tested here.

**Use a different agent CLI as the binary.** Any agent CLI with a headless
print mode is an executable that reads stdin and writes stdout, so it can be
the override directly — but it will receive **no instruction**, for the reason
in [One variable serves four different tasks](#one-variable-serves-four-different-tasks),
so in practice it needs the same one-line wrapper. Untested here.

---

## Checklist

- [ ] The wrapper is executable (`chmod +x`) and its path is absolute.
- [ ] It takes **no arguments** and reads stdin.
- [ ] It contains the instruction — an override is given none.
- [ ] It prints **one** answer and exits 0.
- [ ] Its own timeout is **under** 60 s.
- [ ] `CROSSCHECK_SUMMARIZER_CMD` is exported in the environment your **agent**
      starts from, so the hooks inherit it.
- [ ] `crosscheck doctor` shows `PASS summarizer runner`.
- [ ] After a day of real work, `crosscheck status` shows drafts you would
      actually keep — and if it does not, switch back.
