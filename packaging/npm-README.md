# crosscheck

> Your agent talks to your teammates' agents — before the code exists.

Crosscheck is a coordination layer for teams where every developer works with a
local coding agent (Claude Code first). It shares what git cannot see: who is
investigating what right now, which hypotheses were already tested and
rejected, which root causes are confirmed, and which in-flight changes are
about to collide — semantically, not just at file level.

One npm package, three parts: the hub (`crosscheck serve` — Hono API, SSE,
web UI, **embedded PGlite**: no Docker, no database install), the Claude Code
connector (hooks, statusline, MCP tools), and the shared wire schema.

## Requirements

**[Bun](https://bun.sh) ≥ 1.3.** The hub and the hooks run on Bun; the
`crosscheck` command re-launches itself under Bun automatically (so `npx` works),
and tells you the one install command if Bun is missing:

```bash
curl -fsSL https://bun.sh/install | bash
```

Node is only needed by whatever invokes the bin (`npx` brings it).

## Host a hub

One teammate (or a small VPS, or a machine behind Tailscale) runs:

```bash
ADMIN_TOKEN=<pick-one> npx crosscheck serve     # or: bunx crosscheck serve
```

The hub listens on `:7100` (`PORT` overrides) and stores everything in
`CROSSCHECK_DATA_DIR` (in-memory when unset — set it for anything real).

Issue one API key per developer (keys are never shared — provenance is a core
feature):

```bash
curl -sX POST http://localhost:7100/api/developers \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Alice","email":"alice@example.com"}'
# -> {"ok":true,"data":{"developer":{"id":"..."},"apiKey":"..."}}   (shown once)
```

## Connect a developer

```bash
npm install -g crosscheck        # or run everything through npx/bunx

crosscheck login http://hub-host:7100 < api-key.txt   # key from stdin, stored 0600
crosscheck init      # writes .crosscheck.json, .claude/settings.json, .mcp.json
crosscheck doctor    # verifies config, hooks, hub, spool, clock
```

`crosscheck init` is meant to be committed: the hub URL and the hook
registration live in the repo, so every teammate is connected after `git pull`
plus their own `crosscheck login`. The API key never enters the repo.

## Licensing

This package is **not licensed as a single unit** — see the `LICENSE` file
(the map) and the per-directory license files it points to:

| Shipped directory | License |
|---|---|
| `packages/schema/` | Apache-2.0 |
| `packages/connector-claude/` | Apache-2.0 |
| `packages/server/` | Functional Source License 1.1 (ALv2 future license) |

The connector and schema are ordinary open source. The hub source is visible
and free to self-host; reselling it as a service is what the FSL restricts,
and each release converts to Apache-2.0 after two years.

## More

Design, research and the full README live in the repository:
<https://github.com/NeverStopHH/crosscheck>
