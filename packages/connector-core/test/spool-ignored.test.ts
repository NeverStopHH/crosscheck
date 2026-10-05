/**
 * LOSS-6 (docs/1.0/loss-accounting.md §7): a record kind the hub IGNORES is
 * a counted drop that names the kind — never a 200, a cursor move and a
 * record gone.
 *
 * `ignored` is what an older hub answers about a kind it does not know
 * (server services/records.ts, the forward-compatibility rule). The flush
 * read `rejected` alone, so a newer connector against an older hub lost
 * whole record kinds while `spool drops` printed "none".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { appendRecords, flushSpool, readSpoolLines, repoKey } from "../src/index.ts";
import { readTextOrNull, sessionSlug, spoolDropsPath } from "../src/config/paths.ts";
import { readDropDetail, readDropSummary } from "../src/spool/drops.ts";
import { makeHome } from "./helpers.ts";

const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:9";
const NOW = new Date("2026-07-26T12:00:00.000Z");
const SESSION = "session-ignored";
const KEY = repoKey(HUB_URL, REPO_ID);
const SLUG = sessionSlug(SESSION);
/** No hook hosts these flushes, so nothing bounds them but the batch ceiling. */
const AMPLE_BUDGET_MS = 60_000;

const homes: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(homes.map((path) => rm(path, { recursive: true, force: true })));
  homes.length = 0;
});

const home = async (): Promise<string> => {
  const path = await makeHome("spool-ignored");
  homes.push(path);
  return path;
};

const envelope = (index: number, kind: string): Record<string, unknown> => ({
  cx: "0.1",
  id: `env_${String(index)}`,
  ts: NOW.toISOString(),
  producer: { developerId: "unknown", agentKind: "claude-code", sessionId: "cc_old" },
  kind,
  body: { workContextId: "wc_1", kind: "file", value: `src/file-${String(index)}.ts` },
});

const hubContext = (path: string, hubUrl: string) => ({
  hubUrl,
  apiKey: "key",
  timeoutMs: 20_000,
  home: path,
  repoKey: KEY,
  now: () => NOW,
});

interface WireRecord {
  readonly kind: string;
}

/**
 * A hub from before a record kind: it parses every envelope, ignores the
 * kinds it does not know, and answers 200 with per-record results — exactly
 * what services/records.ts does for an unknown kind.
 */
const ignoringHub = (
  ignoredKinds: ReadonlySet<string>,
  options: { readonly withResults?: boolean } = {},
): string => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { records: readonly WireRecord[] };
      const results = body.records.map((record, index) => ({
        index,
        status: ignoredKinds.has(record.kind) ? "ignored" : "accepted",
      }));
      const ignored = results.filter((result) => result.status === "ignored").length;
      return Response.json({
        ok: true,
        data: {
          accepted: body.records.length - ignored,
          duplicates: 0,
          ignored,
          rejected: 0,
          ...(options.withResults === false ? {} : { results }),
        },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const flush = async (path: string, hubUrl: string): Promise<void> => {
  await flushSpool(
    hubContext(path, hubUrl),
    { sessionId: "cc_live", developerId: "dev_live" },
    AMPLE_BUDGET_MS,
  );
};

describe("LOSS-6: a record kind the hub ignores is a counted drop carrying the kind", () => {
  test("two ignored records of one kind become one ledger line naming the kind, and the cursor still moves", async () => {
    // Arrange
    const path = await home();
    await appendRecords(
      path,
      KEY,
      SESSION,
      [envelope(1, "claim_revalidation"), envelope(2, "claim_revalidation"), envelope(3, "target")],
      NOW,
    );
    const hubUrl = ignoringHub(new Set(["claim_revalidation"]));

    // Act
    await flush(path, hubUrl);

    // Assert: gone from the spool, present in the ledger with its kind
    expect(await readSpoolLines(path, KEY)).toHaveLength(0);
    expect(await readDropSummary(path, KEY)).toEqual({ records: 2, entries: 1, malformed: 0 });
    const detail = await readDropDetail(path, KEY);
    expect(detail.byReason["ignored"]).toBe(2);
    expect(detail.ignoredRecordKinds["claim_revalidation"]).toBe(2);
    expect(await readTextOrNull(spoolDropsPath(path, KEY, SLUG))).toContain('"reason":"ignored"');
  });

  test("a hub that ignores nothing writes no ledger line", async () => {
    // Arrange
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1, "target")], NOW);
    const hubUrl = ignoringHub(new Set());

    // Act
    await flush(path, hubUrl);

    // Assert
    expect(await readDropSummary(path, KEY)).toEqual({ records: 0, entries: 0, malformed: 0 });
  });

  test("a hub that sends counts but no per-record results still counts the total, under no kind", async () => {
    // Arrange
    const path = await home();
    await appendRecords(path, KEY, SESSION, [envelope(1, "claim_revalidation")], NOW);
    const hubUrl = ignoringHub(new Set(["claim_revalidation"]), { withResults: false });

    // Act
    await flush(path, hubUrl);

    // Assert
    const detail = await readDropDetail(path, KEY);
    expect(detail.byReason["ignored"]).toBe(1);
    expect(Object.keys(detail.ignoredRecordKinds)).toHaveLength(0);
  });
});
