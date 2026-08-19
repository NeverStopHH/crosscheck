# @crosscheck/connector-acp

The ACP transparent proxy — Blocks 3–5 of [docs/adapters/DESIGN-agent-agnostic.md](../../docs/adapters/DESIGN-agent-agnostic.md): `crosscheck acp -- <agent command…>` wraps any [ACP](https://agentclientprotocol.com) agent as a byte-transparent stdio pipe, captures Tier-0 signals from a parsed COPY of the wire (Block 4), and — in a crosscheck-connected repo, on protocol 1, unless `--no-inject` — injects exactly two things (Block 5, §2.5): crosscheck's MCP server appended to the session-setup `mcpServers`, and the team briefing / per-prompt hints appended as one trailing prompt block. One binary covers every ACP client (Zed, JetBrains, Neovim, Emacs) × every ACP agent, because the client simply runs crosscheck's binary as the agent command.

**The prime directive (design verdict 2): the proxy must NEVER be able to kill a session.** Every internal failure — parse error, log-write failure, oversized line, our own bug — degrades to a pure byte pipe. A user wrapping their agent with a completely broken crosscheck notices nothing except a log line. Transparency is enforced structurally, not carefully: the forward path never waits on, reads from, or branches on anything the observability layer does.

## What works today

- **Transparent wrap**: `crosscheck acp [--agent-kind <kind>] [--record <file>] -- <agent command…>`. Everything after `--` is spawned as the agent — argv untouched, environment inherited (the agent's own auth keeps working). Bytes forward verbatim in both directions, chunk by chunk, never re-serialized.
- **Faithful lifecycle** (§2.2): the agent's exit code passes through; an agent killed by a signal kills the proxy with the *same* signal (the client's waitpid cannot tell the proxy was there); SIGINT/SIGTERM/SIGHUP to the proxy are relayed to the agent; client stdin EOF becomes the agent's stdin EOF; a client hangup becomes the agent's broken pipe. Agent stderr passes through unmodified.
- **Real backpressure, measured**: the proxy holds one chunk per direction in flight — a 64 MiB flood against a slow peer adds ~12-17 MB to proxy RSS, not the flood (test/backpressure.test.ts pins this on the spawned binary; src/fd-io.ts's header carries the measurements that forced raw-fd plumbing).
- **Observability without interference**: a per-proxy log at `~/.crosscheck/logs/acp-<pid>.log` (size-rotated once, rotated aside on pid reuse, age-swept after 7 days) with per-direction counters — bytes, lines, unparseable lines, oversized lines, observer errors, record drops. `--record <file>` appends every observed NDJSON line (direction, raw text, parse verdict) for Block-4 capture development and per-agent capture-quality measurement (design §6 question 1). All of it rides a COPY of the wire; a stuck disk drops entries and counts them instead of queueing without bound — and a `--record` drop is never a *silent* hole: the next write is preceded by an in-band `{t, gap: n}` marker (trailing drops get one at flush), and the recorder's pending cap is sized so any single observable line fits on an idle disk even at worst-case JSON escaping (src/constants.ts `ACP_RECORD_MAX_PENDING_BYTES`).
- **Contained internal failures**: any post-spawn internal error — fd exhaustion at the FIFO opens, our own bug — reports one stderr line plus a log line, terminates the agent, and exits 2 (`EXIT_FAIL`); it can never surface as a silent usage-style exit with the agent left running. FIFO temp dirs leaked by *abnormal* deaths (SIGKILL, OOM — nothing in-process survives those) are age-swept at the next proxy start, mirroring the log sweep.
- **Loud refusals only where no session exists**: unknown flags, a missing `--`, and an unspawnable agent command fail before any spawn (exit 64 / 127).

- **Tier-0 capture (Block 4, design §2.4)**: from the observer's parsed copies — never the forward path — the proxy maps the wire onto the crosscheck model through the core kit flows:
  - `initialize` → `agent_kind = acp:<agentInfo.name>` (`--agent-kind` overrides; `CROSSCHECK_AGENT_KIND` in the env outranks both);
  - `session/new` → repo identity from the session's own `cwd`, `hostSessionKey = acp-<agentSlug>--<sessionId>`, `registerSessionFlow` (state file BEFORE the first spool append — reap's aliveness invariant), work-context title `branch @ repo` (never prompt-derived);
  - `session/load`/`resume` → cold sessions register at REQUEST time (pinned and mutation-checked), so replayed history is captured safely (server-side natural-key dedup absorbs the repeats — pinned); a session already live in the same proxy skips the re-register, so a load storm cannot inflate counters or reset capture state;
  - `session/prompt` → heartbeat under `HEARTBEAT_MIN_INTERVAL_MS`; the prompt **content is never parsed** — a hostile prompt cannot reach the spool, state files, or log (pinned);
  - `tool_call`/`tool_call_update` `locations[].path` + diff-content paths → repo-relative file targets (denylist, seen-set, secret-scan); `kind: edit` → status `implementing`;
  - `status: failed` `rawOutput` → the SAME `extractFailureText` + `fingerprint()` as the Claude connector — identical bytes yield the identical `sha256:` (parity-pinned);
  - `terminal/create` → `terminal/output` → non-zero `wait_for_exit` → fingerprint from the output tail; the command text is never uploaded;
  - `fs/write_text_file` → file target (the backstop for agents that report no locations);
  - `session/close`, connection EOF, child exit → `endSessionFlow` per live session + reap with a budgeted `DeferredEnder`.

  Everything is fail-open: a session in a directory with no repo or no crosscheck config is a pure pipe that talks to nobody; the capture queue is byte-capped (drops counted); a capture crash is a counter and a log line — proven by a deterministic fault seam (`CROSSCHECK_ACP_TEST_FAULT=capture-dispatch`) and mutation-checked, so the containment catch can never rot into decoration. JSON-RPC error responses on captured methods are counted, never recorded. Not captured, deliberately: prompt/response content, `rawInput`, diff old/new text, permission outcomes.

  Hostile-identifier discipline: session ids are agent-minted, so the wire parsers shape every one (`safeAcpSessionId` — control/format/separator strip; overlong ids fold to a deterministic sha256) and agent names slug through the length-capped `agentSlug` before anything reaches log lines, state filenames, or `cc_`/`wc_` ids — a newline-bearing id cannot forge forensics log lines, and no id can `ENAMETOOLONG` the register flow. The in-memory seen-set is FIFO-bounded at the same `MAX_SEEN_TARGETS` as the persisted state, so an agent streaming synthetic in-repo paths costs bounded memory (all pinned in test/capture-hardening.test.ts).
- **Capture-quality measurement** (design §6.1): `crosscheck acp-report <record-file>` analyzes an `acp --record` transcript and reports which signals the agent actually emitted — tool calls, locations, diff paths, failures with output, terminals, fs writes, plus recording honesty (gaps/oversized/unparseable). Every untrusted wire string is reduced before it renders (name → `agentSlug`, version and stop reasons → their own narrow alphabets), so a hostile transcript cannot drive the operator's terminal. This is the tool that decides each agent's documented capture level; run it against a real `--record` of Gemini CLI / cursor-agent / Goose before writing that agent's doc.

### Zed install (design §2.1/§2.6)

```json
{
  "agent_servers": {
    "Gemini (crosscheck)": {
      "type": "custom",
      "command": "crosscheck",
      "args": ["acp", "--", "gemini", "--experimental-acp"],
      "env": {}
    }
  }
}
```

JetBrains (`~/.jetbrains/acp.json`) takes the same command/args shape. In a crosscheck-connected repo (committed `.crosscheck.json` + `crosscheck login`), sessions report presence, touched files and failure fingerprints; everywhere else the wrapper is a pure pipe.

## Injection (Block 5, design §2.5)

Exactly two write points, both version-gated (protocol 1 only — the injector watches the `initialize` exchange itself; a mismatch means one log line, one stderr notice, and a pure pipe), both fail-open (any doubt forwards the original bytes with a `inject skip why=…` log line), both off under `--no-inject` or `CROSSCHECK_DISABLED`:

1. **`session/new` / `session/load` / `session/resume`**: ONE `{"name": "crosscheck", "command": …, "args": […, "mcp"], "env": []}` entry appended to an `mcpServers` array the client already sent (never invented — design open question 3's conservative default), launcher resolved through the core durable-install rules (`connector-core/src/config/launcher.ts`; npx/bunx cache paths refuse), never past an existing `crosscheck`-named entry (owned = already installed, foreign = the user's — both skip), and only for a cwd that resolves to a connected repo. The agent then has the full Tier-2 tool surface with zero client cooperation, because the engine wrote the session-state files the MCP server resolves sessions from.
2. **`session/prompt`**: ONE trailing `text` ContentBlock, appended, never editing the user's blocks. First delivery is the briefing — assembled ASYNCHRONOUSLY at register time by the core `assembleBriefing` flow and served from cache (prefetch not ready → this prompt is skipped, the next one gets it; never a blocking wait). After that, the core `selectAndRenderHint` flow per prompt (the prompt text is its EPHEMERAL query — never stored, never logged), raced against the UserPromptSubmit budget constants; a blown budget forwards the prompt unmodified. Telemetry (`hint_deliveries`) is recorded BEFORE the text ships, with deterministic ids — a load/resume replay re-sends the same primary keys and the hub answers `duplicate`.

Every appended character renders through the core renderers via the ONE registered composition point (`src/inject/blocks.ts`, a §4.4 corpus surface — identity today, and the place any future ACP framing literal must live). When injection is off, the c2a path runs the Block-3 chunk pump untouched — byte-identity is construction, not care (`test/inject-e2e.test.ts` hashes it through the real binary; `test/line-pump.test.ts` hashes the active-but-nothing-to-inject case).

## Deliberately absent

- **Turn counting is local.** `session/prompt` responses tick an in-memory counter (the future Tier-1 gate) surfaced in the log summary; nothing is spooled for it. `cancelled`/`refusal` capture nothing in v1.
- **`crosscheck status`/`doctor` surfacing of drop counters** still waits; today the counters live in the log summary lines (`capture sessions=… targets=… fingerprints=…`, `inject mcp=… briefings=… hints=… skips=…`).

## Block-3 deviations from design §2, justified

1. **Chunk-granular forwarding** (vs §2.3 rule 3's line granularity): stronger transparency — a partial line is already on its way before its newline arrives, and the observer cannot affect forwarding even by crashing, because forwarding never waits for it. Since Block 5 this is the INJECTION-OFF path; with injection active the client→agent direction runs the line pump (`src/inject/line-pump.ts`), which still forwards untouched lines' original bytes and preserves order absolutely (a held prompt delays later lines rather than being overtaken).
2. **Raw-fd plumbing with two FIFOs + `sh -c 'exec "$0" "$@" > out 2> err'`** instead of the runtime's pipe streams: every high-level stream (Bun FileSink, Bun.spawn's ReadableStream, node:child_process readables) buffers without bound on at least one side — measured, numbers in src/fd-io.ts. `exec` keeps the child pid = the agent, so signals and exit codes need no translation; the agent's stdin stays a REAL pipe (a FIFO stdin breaks EOF for agents on runtimes that never report FIFO-EOF — observed with Bun's own stdin stream). Still pipes, no PTY. An unexpected `EAGAIN` (something flipped a shared stdio fd to O_NONBLOCK) is retried, never treated as EOF or a hangup — either misreading would end a live direction or drop bytes.
3. **The post-exit drain is unbounded on purpose**: after the agent dies the proxy keeps forwarding until its stdout FIFO reaches EOF. A spec-violating helper process that inherited the agent's stdout can defer the proxy's exit (a *timing* divergence), but a deadline would TRUNCATE tail bytes the unproxied client would have received (a *content* divergence). Content transparency outranks exit timing; a client that hangs up instead unblocks the drain promptly via EPIPE.

## Layout

| Module | Role |
|---|---|
| `src/proxy.ts` | process model: spawn, wire, signals, exit mirroring |
| `src/pump.ts` | the forward path: original bytes first, observer copy after, one chunk in flight |
| `src/fd-io.ts` | pull-based raw-fd sources/sinks — the backpressure layer |
| `src/observer.ts` | tolerant NDJSON splitter on the copy: lines, drop counters, bounded memory |
| `src/logger.ts` / `src/recorder.ts` | the log file and `--record`, fail-open with pending caps |
| `src/cli.ts` | `acp` argument parsing, loud pre-spawn refusals |
| `src/wire/v1.ts` | protocol-1 wire shapes for capture, tolerant by construction; v2 lands as a sibling module |
| `src/capture/pending.ts` | bounded id → (method, params) maps, one per direction |
| `src/capture/engine.ts` | the §2.4 mapping over the core kit flows — serialized, byte-capped, fail-open; owns the briefing prefetch + `promptInjectionView` |
| `src/inject/injector.ts` | the §2.5 decision engine: version gate, the two write points, skip logging |
| `src/inject/line-pump.ts` | line-granular c2a forwarding while injection is active |
| `src/inject/launcher.ts` | the ACP `mcpServers` entry via the core durable-install rules |
| `src/inject/blocks.ts` | THE prompt-block composition point — a registered §4.4 corpus surface |
| `src/render-surfaces.ts` | the package's §4.4 registrations (briefing block, hint blocks) |
| `src/report.ts` | `acp-report`: the §6.1 capture-quality analyzer over `--record` files |

The `crosscheck` bin lives in `@crosscheck/connector-claude` until Block 8 extracts `packages/cli` (design §1.2's named debt); this package only exports `runAcpProxy` for it.
