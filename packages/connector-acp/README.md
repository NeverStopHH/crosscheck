# @crosscheck/connector-acp

The ACP transparent proxy — Block 3 of [docs/adapters/DESIGN-agent-agnostic.md](../../docs/adapters/DESIGN-agent-agnostic.md): `crosscheck acp -- <agent command…>` wraps any [ACP](https://agentclientprotocol.com) agent as a byte-transparent stdio pipe. One binary covers every ACP client (Zed, JetBrains, Neovim, Emacs) × every ACP agent, because the client simply runs crosscheck's binary as the agent command.

**The prime directive (design verdict 2): the proxy must NEVER be able to kill a session.** Every internal failure — parse error, log-write failure, oversized line, our own bug — degrades to a pure byte pipe. A user wrapping their agent with a completely broken crosscheck notices nothing except a log line. Transparency is enforced structurally, not carefully: the forward path never waits on, reads from, or branches on anything the observability layer does.

## What works today

- **Transparent wrap**: `crosscheck acp [--record <file>] -- <agent command…>`. Everything after `--` is spawned as the agent — argv untouched, environment inherited (the agent's own auth keeps working). Bytes forward verbatim in both directions, chunk by chunk, never re-serialized.
- **Faithful lifecycle** (§2.2): the agent's exit code passes through; an agent killed by a signal kills the proxy with the *same* signal (the client's waitpid cannot tell the proxy was there); SIGINT/SIGTERM/SIGHUP to the proxy are relayed to the agent; client stdin EOF becomes the agent's stdin EOF; a client hangup becomes the agent's broken pipe. Agent stderr passes through unmodified.
- **Real backpressure, measured**: the proxy holds one chunk per direction in flight — a 64 MiB flood against a slow peer adds ~12-17 MB to proxy RSS, not the flood (test/backpressure.test.ts pins this on the spawned binary; src/fd-io.ts's header carries the measurements that forced raw-fd plumbing).
- **Observability without interference**: a per-proxy log at `~/.crosscheck/logs/acp-<pid>.log` (size-rotated once, rotated aside on pid reuse, age-swept after 7 days) with per-direction counters — bytes, lines, unparseable lines, oversized lines, observer errors, record drops. `--record <file>` appends every observed NDJSON line (direction, raw text, parse verdict) for Block-4 capture development and per-agent capture-quality measurement (design §6 question 1). All of it rides a COPY of the wire; a stuck disk drops entries and counts them instead of queueing without bound — and a `--record` drop is never a *silent* hole: the next write is preceded by an in-band `{t, gap: n}` marker (trailing drops get one at flush), and the recorder's pending cap is sized so any single observable line fits on an idle disk even at worst-case JSON escaping (src/constants.ts `ACP_RECORD_MAX_PENDING_BYTES`).
- **Contained internal failures**: any post-spawn internal error — fd exhaustion at the FIFO opens, our own bug — reports one stderr line plus a log line, terminates the agent, and exits 2 (`EXIT_FAIL`); it can never surface as a silent usage-style exit with the agent left running. FIFO temp dirs leaked by *abnormal* deaths (SIGKILL, OOM — nothing in-process survives those) are age-swept at the next proxy start, mirroring the log sweep.
- **Loud refusals only where no session exists**: unknown flags, a missing `--`, and an unspawnable agent command fail before any spawn (exit 64 / 127).

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

JetBrains (`~/.jetbrains/acp.json`) takes the same command/args shape. Today this is a no-op wrapper: sessions behave exactly as unproxied, plus a log file.

## Deliberately absent

- **Capture is Block 4.** No session registration, no hub traffic, no spool — the NDJSON observer only counts and records. The §2.4 capture mapping lands behind the same observer.
- **Injection is Block 5.** No message is ever modified: no `mcpServers` append, no prompt-block append, no `--no-inject`/`--agent-kind` flags (they arrive with the features they gate). The two §2.5 write points will re-serialize exactly two message kinds; everything else stays verbatim forever.
- **`crosscheck status`/`doctor` surfacing of drop counters** waits for Block 4+, when sessions exist to attach them to; today the counters live in the log summary.

## Block-3 deviations from design §2, justified

1. **Chunk-granular forwarding** (vs §2.3 rule 3's line granularity): stronger transparency — a partial line is already on its way before its newline arrives, and the observer cannot affect forwarding even by crashing, because forwarding never waits for it. Line-granular handling arrives with Block 5's write points, client→agent path only.
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

The `crosscheck` bin lives in `@crosscheck/connector-claude` until Block 8 extracts `packages/cli` (design §1.2's named debt); this package only exports `runAcpProxy` for it.
