/**
 * One OS process that appends to a spool exactly the way a hook does.
 *
 * Real processes are the point: in-process promises share a file through the
 * same event loop and never reproduce what concurrent `O_APPEND` writers,
 * a flush and a reap actually do to each other.
 *
 * It writes its session state file BEFORE its first append and deletes it
 * afterwards when asked, because that is the ordering `reap` relies on to know
 * that a spool file still has a writer behind it.
 *
 * argv: <home> <repoKey> <sessionId> <workerId> <appendCount> <padBytes> <endSession>
 * stdout: JSON [{ id, persisted, dropped }, ...] — one entry per append call.
 */
import { appendRecords } from "../../src/spool/append.ts";
import {
  deleteSessionState,
  writeSessionState,
} from "../../src/state/session-state.ts";

const [home, key, sessionId, workerId, countRaw, padRaw, endRaw] =
  process.argv.slice(2);

if (
  home === undefined ||
  key === undefined ||
  sessionId === undefined ||
  workerId === undefined ||
  countRaw === undefined ||
  padRaw === undefined
) {
  process.stderr.write(
    "usage: worker <home> <key> <sessionId> <workerId> <count> <pad> [endSession]\n",
  );
  process.exit(64);
}

const count = Number.parseInt(countRaw, 10);
const pad = "x".repeat(Number.parseInt(padRaw, 10));
const now = new Date();

await writeSessionState(home, {
  hostSessionKey: sessionId,
  crosscheckSessionId: `cc_${sessionId}`,
  workContextId: `wc_cc_${sessionId}`,
  repoId: "github.com/acme/api",
  repoRoot: "/tmp/repo",
  hubUrl: "http://127.0.0.1:9",
  developerId: "dev_1",
  startedAt: now.toISOString(),
  lastHeartbeatAt: null,
  seenTargets: [],
});

const envelope = (id: string): Record<string, unknown> => ({
  cx: "0.1",
  id,
  ts: now.toISOString(),
  producer: {
    developerId: "dev_1",
    agentKind: "claude-code",
    sessionId: `cc_${sessionId}`,
  },
  kind: "target",
  body: { workContextId: "wc_1", kind: "file", value: `src/${id}.ts`, pad },
});

const outcomes: unknown[] = [];
for (let index = 0; index < count; index += 1) {
  const id = `env_${workerId}_${index}`;
  const result = await appendRecords(home, key, sessionId, [envelope(id)], now);
  outcomes.push({ id, persisted: result.persisted, dropped: result.dropped });
}

if (endRaw === "end") {
  await deleteSessionState(home, sessionId);
}

process.stdout.write(JSON.stringify(outcomes));